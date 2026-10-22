import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Pairing, newToken, PAIRING_CODE_TTL_MS } from './api/auth.js';
import { advertise, type BonjourLike, type MdnsAdvertiser } from './api/mdns.js';
import { ApiServer } from './api/server.js';
import { COMMAND_DEADLINE_MS, Commands, type CommandError, type CommandResult } from './commands/commands.js';
import type { HubConfig } from './config.js';
import { ControllerClient } from './controller/client.js';
import { ControllerRejected, ControllerUnauthorized, ControllerUnreachable } from './controller/errors.js';
import { SerialQueue } from './controller/queue.js';
import type { ProgramData } from './controller/types.js';
import { RunHistory } from './history/history.js';
import { Notifier, type Logger } from './notify/notifier.js';
import { PauseService } from './pause/pause.js';
import { JsonStore } from './persist/jsonStore.js';
import { createPlug } from './recovery/plug.js';
import { Watchdog } from './recovery/watchdog.js';
import { SettingsStore } from './settings/settingsStore.js';
import { programToSchedule } from './state/model.js';
import { Poller } from './state/poller.js';
import { StateStore } from './state/store.js';
import { OpenMeteoClient, type Forecast } from './weather/openMeteo.js';

export interface Capabilities {
  mqtt: boolean;
  pauseUntil: true;
  maxRainDelayHours: 32767;
  firmware: number | null;
}

/**
 * Optional collaborators for `createHub`. Everything defaults to the real thing.
 * - `fetchImpl`: used for the forecast, notifications and smart plug (not the controller).
 * - `clock`: UTC ms, for pairing, pause and watchdog.
 * - `logger`: hub log lines (pairing code, failures); default `console`.
 * - `mdns`: false skips the mDNS advertisement (tests); `mdnsFactory` replaces bonjour-service.
 */
export interface HubDeps {
  fetchImpl?: typeof fetch;
  clock?: () => number;
  logger?: Logger;
  mdns?: boolean;
  mdnsFactory?: () => BonjourLike;
}

export interface Hub {
  store: StateStore;
  commands: Commands;
  pause: PauseService;
  history: RunHistory;
  forecast(): Promise<Forecast | null>;
  settings: SettingsStore;
  watchdog: Watchdog;
  notifier: Notifier;
  pairing: Pairing;
  start(): Promise<void>;
  stop(): Promise<void>;
  capabilities(): Capabilities;
  // ---- beyond the plan's interface ----
  readonly config: HubConfig;
  readonly logger: Logger;
  /** The port the API is bound to (useful with `apiPort: 0`); throws before `start()`. */
  apiPort(): number;
  /** Writes a program to the controller and updates the store's copy of that schedule. */
  updateSchedule(id: number, data: ProgramData): Promise<CommandResult>;
}

const MQTT_MIN_FWV = 219;
const HISTORY_REFRESH_MS = 15 * 60_000;
const CLI_TOKEN_FILE = 'cli-token';
/** Auto-issue stops after this many codes expired unclaimed or were locked out. */
const MAX_AUTO_BURNED_CODES = 20;

function mapError(err: unknown, online: boolean, logger: Logger): CommandError {
  if (err instanceof ControllerUnauthorized) return 'unauthorized';
  if (err instanceof ControllerRejected) return 'rejected';
  if (err instanceof ControllerUnreachable) return online ? 'timeout' : 'offline';
  logger.error('rainmaker: controller error', err);
  return 'timeout';
}

/** Builds the whole hub; no I/O happens until `start()`. */
export function createHub(config: HubConfig, deps: HubDeps = {}): Hub {
  const logger = deps.logger ?? console;
  const clock = deps.clock ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const persist = new JsonStore(config.dataDir);
  const client = new ControllerClient(config.controller, new SerialQueue());
  const store = new StateStore();
  const poller = new Poller(client, store);
  const commands = new Commands(client, store, poller);
  const pause = new PauseService(client, store, persist, clock);
  const history = new RunHistory(client, store, persist);
  const weather = config.location ? new OpenMeteoClient(config.location.lat, config.location.lon, fetchImpl) : null;
  const settings = new SettingsStore(persist, config);
  const watchdog = new Watchdog(store, createPlug(config.plug, fetchImpl), {}, clock);
  const notifier = new Notifier(config.notifications, persist, { fetchImpl, logger, clock });
  const pairing = new Pairing(persist, clock, logger);

  let server: ApiServer | null = null;
  /** The in-flight or finished start; null when stopped. Makes start() idempotent. */
  let lifecycle: Promise<void> | null = null;
  let mdns: MdnsAdvertiser | null = null;
  let pairingTimer: NodeJS.Timeout | null = null;
  let historyTimer: NodeJS.Timeout | null = null;
  let offlineNotified = false;
  const unsubscribe: (() => void)[] = [];

  const on = (emitter: NodeJS.EventEmitter, event: string, fn: (...args: unknown[]) => void) => {
    emitter.on(event, fn);
    unsubscribe.push(() => emitter.off(event, fn));
  };

  const refreshHistory = () =>
    history.refresh().catch((err: unknown) => logger.warn('rainmaker: run history refresh failed', err));

  const issuePairingCode = () => {
    if (pairing.list().length > 0) return;
    if (pairing.burnedCodes() >= MAX_AUTO_BURNED_CODES) {
      // Nobody is claiming them (or someone is guessing): stop until an owner asks or restarts.
      if (pairingTimer) clearInterval(pairingTimer);
      pairingTimer = null;
      logger.log('Rainmaker pairing paused; run `rainmaker-hub pair` or restart to resume');
      return;
    }
    const { code } = pairing.startPairing();
    logger.log(`Rainmaker pairing code: ${code} (valid ${PAIRING_CODE_TTL_MS / 60_000} minutes)`);
  };

  const wireNotifications = () => {
    on(store, 'offline', () => {
      if (!settings.get().notifications.offline) return;
      offlineNotified = true;
      void notifier.notify('offline', 'The sprinkler controller is offline.');
    });
    on(store, 'online', () => {
      if (!offlineNotified) return; // the first poll after start is not news
      offlineNotified = false;
      if (settings.get().notifications.offline) void notifier.notify('online', 'The sprinkler controller is back online.');
    });
    on(watchdog, 'recovery-exhausted', () => {
      void notifier.notify('recovery-exhausted', 'The controller is still offline after power-cycling it; please check it.');
    });
  };

  const ensureCliToken = async () => {
    const file = path.join(config.dataDir, CLI_TOKEN_FILE);
    let token: string;
    try {
      token = (await fs.readFile(file, 'utf8')).trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      token = newToken();
      await fs.writeFile(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
    }
    if (token) pairing.trust(token);
  };

  const hub: Hub = {
    store,
    commands,
    pause,
    history,
    settings,
    watchdog,
    notifier,
    pairing,
    config,
    logger,

    forecast: async () => (weather ? weather.getForecast() : null),

    capabilities: () => {
      const fwv = store.get().firmware?.fwv ?? null;
      return { mqtt: fwv !== null && fwv >= MQTT_MIN_FWV, pauseUntil: true, maxRainDelayHours: 32767, firmware: fwv };
    },

    apiPort: () => {
      if (!server) throw new Error('hub is not started');
      return server.port();
    },

    async updateSchedule(id, data) {
      const start = Date.now();
      try {
        await client.setProgram(id, data, { deadlineMs: COMMAND_DEADLINE_MS });
      } catch (err) {
        return { ok: false, error: mapError(err, store.get().online, logger) };
      }
      const schedules = store
        .get()
        .schedules.map((s) => (s.id === id ? { ...programToSchedule(id, data), pausedUntil: s.pausedUntil } : s));
      store.patch({ schedules });
      return { ok: true, confirmedInMs: Date.now() - start };
    },

    start() {
      lifecycle ??= startAll().catch(async (err: unknown) => {
        // Undo whatever came up before the failure, then let the caller see the error.
        await stopAll().catch((e: unknown) => logger.error('rainmaker: cleanup after failed start failed', e));
        lifecycle = null;
        throw err;
      });
      return lifecycle;
    },

    async stop() {
      const running = lifecycle;
      lifecycle = null;
      await running?.catch(() => undefined);
      await stopAll();
    },
  };

  async function startAll(): Promise<void> {
    await fs.mkdir(config.dataDir, { recursive: true });
    await settings.load();
    await pairing.load();
    await ensureCliToken();
    await poller.pollNow().catch((err: unknown) => logger.warn('rainmaker: first poll failed', err));
    poller.start();
    void refreshHistory();
    historyTimer = setInterval(() => void refreshHistory(), HISTORY_REFRESH_MS);
    historyTimer.unref();
    pause.start();
    watchdog.start();
    wireNotifications();
    server = new ApiServer(hub);
    await server.listen(config.apiPort, '0.0.0.0');
    logger.log(`Rainmaker hub listening on ${server.port()}`);
    if (deps.mdns !== false) mdns = advertise(server.port(), { logger, factory: deps.mdnsFactory });
    issuePairingCode();
    pairingTimer = setInterval(issuePairingCode, PAIRING_CODE_TTL_MS);
    pairingTimer.unref();
  }

  async function stopAll(): Promise<void> {
    if (pairingTimer) clearInterval(pairingTimer);
    if (historyTimer) clearInterval(historyTimer);
    pairingTimer = historyTimer = null;
    for (const off of unsubscribe.splice(0)) off();
    await mdns?.stop();
    mdns = null;
    await server?.close();
    server = null;
    watchdog.stop();
    pause.stop();
    poller.stop();
  }

  return hub;
}

