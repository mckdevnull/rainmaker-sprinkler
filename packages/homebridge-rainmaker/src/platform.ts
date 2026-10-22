import type { API, Categories, DynamicPlatformPlugin, HAP, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { createHub, type ControllerState, type Hub, type HubDeps, type Logger } from '@rainmaker/hub-core';
import { bindUnavailable, setInfo, type Part, type PartContext } from './accessories/common.js';
import { IRRIGATION_NAME, IrrigationAccessory } from './accessories/irrigation.js';
import { ONLINE_SENSOR_NAME, onlineSensor } from './accessories/onlineSensor.js';
import { PAIRING_SWITCH_NAME, pairingSwitch } from './accessories/pairingSwitch.js';
import { PAUSE_SWITCH_NAME, SYSTEM_SWITCH_NAME, pauseSwitch, systemSwitch, timedPauseSwitch } from './accessories/switches.js';
import { PAUSE_1_DAY_MS, PAUSE_1_WEEK_MS, PLATFORM_NAME, PLUGIN_NAME } from './constants.js';
import { toHubConfig } from './hubConfig.js';

interface AccessorySpec {
  /** Stable key: the accessory UUID is generated from `rainmaker:<key>`. */
  key: string;
  name: string;
  category(hap: HAP): Categories;
  create(ctx: PartContext, acc: PlatformAccessory): Part;
}

const ACCESSORIES: readonly AccessorySpec[] = [
  { key: 'irrigation', name: IRRIGATION_NAME, category: (hap) => hap.Categories.SPRINKLER, create: (c, a) => new IrrigationAccessory(c, a) },
  { key: 'system', name: SYSTEM_SWITCH_NAME, category: (hap) => hap.Categories.SWITCH, create: systemSwitch },
  { key: 'pause', name: PAUSE_SWITCH_NAME, category: (hap) => hap.Categories.SWITCH, create: pauseSwitch },
  {
    key: 'pause-1d',
    name: 'Pause Sprinklers 1 Day',
    category: (hap) => hap.Categories.SWITCH,
    create: timedPauseSwitch('Pause Sprinklers 1 Day', PAUSE_1_DAY_MS),
  },
  {
    key: 'pause-1w',
    name: 'Pause Sprinklers 1 Week',
    category: (hap) => hap.Categories.SWITCH,
    create: timedPauseSwitch('Pause Sprinklers 1 Week', PAUSE_1_WEEK_MS),
  },
  { key: 'online', name: ONLINE_SENSOR_NAME, category: (hap) => hap.Categories.SENSOR, create: onlineSensor },
  { key: 'pairing', name: PAIRING_SWITCH_NAME, category: (hap) => hap.Categories.SWITCH, create: pairingSwitch },
];

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Hub log lines go to the Homebridge log. */
function hubLogger(log: Logging): Logger {
  return {
    log: (msg?: unknown, ...rest: unknown[]) => log.info(String(msg), ...rest),
    warn: (msg?: unknown, ...rest: unknown[]) => log.warn(String(msg), ...rest),
    error: (msg?: unknown, ...rest: unknown[]) => log.error(String(msg), ...rest),
  };
}

/**
 * Runs the Rainmaker hub inside Homebridge and publishes its HomeKit accessories. Homebridge
 * calls the constructor with (log, config, api); `deps` exists for tests.
 */
export class RainmakerPlatform implements DynamicPlatformPlugin {
  /** Null when the config is invalid (the error is logged). */
  readonly hub: Hub | null;
  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly registered = new Set<string>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly clock: () => number;
  private parts: Part[] = [];
  private unsubscribe: (() => void)[] = [];
  private starting: Promise<void> = Promise.resolve();
  private stopping: Promise<void> = Promise.resolve();

  constructor(
    private readonly log: Logging,
    config: PlatformConfig,
    private readonly api: API,
    deps: HubDeps = {},
  ) {
    this.clock = deps.clock ?? Date.now;
    this.hub = this.buildHub(config, deps);
    api.on('didFinishLaunching', () => {
      this.starting = this.launch();
    });
    api.on('shutdown', () => {
      this.stopping = this.shutdown();
    });
  }

  /** Homebridge hands back each accessory restored from its cache. */
  configureAccessory(acc: PlatformAccessory): void {
    // Until the hub has started and live handlers replace these, writes must fail, not succeed.
    bindUnavailable(this.api, acc);
    this.cached.set(acc.UUID, acc);
    this.registered.add(acc.UUID);
  }

  /** Settles once launch has finished (successfully or not). */
  ready(): Promise<void> {
    return this.starting;
  }

  /** Settles once shutdown has finished. */
  stopped(): Promise<void> {
    return this.stopping;
  }

  private buildHub(config: PlatformConfig, deps: HubDeps): Hub | null {
    try {
      const hubConfig = toHubConfig(config, this.api.user.storagePath());
      return createHub(hubConfig, { ...deps, logger: hubLogger(this.log) });
    } catch (err) {
      this.log.error(`Rainmaker is not running: ${message(err)}. Fix the plugin settings and restart Homebridge.`);
      return null;
    }
  }

  private async launch(): Promise<void> {
    const hub = this.hub;
    if (!hub) return this.markUnavailable();
    try {
      await hub.start();
    } catch (err) {
      this.log.error(`Rainmaker hub failed to start: ${message(err)}`);
      return this.markUnavailable();
    }
    this.publish(hub);
  }

  /**
   * Cached accessories stay (keeping rooms and automations) and keep the error handlers bound in
   * `configureAccessory`: every control reports an error.
   */
  private markUnavailable(): void {
    this.log.error('Rainmaker accessories will report errors until the hub starts.');
  }

  private publish(hub: Hub): void {
    const { api } = this;
    const ctx: PartContext = { api, log: this.log, hub, clock: this.clock, timers: this.timers, save: (a) => this.save(a) };
    const state = hub.store.get();
    const fresh: PlatformAccessory[] = [];
    const wanted = new Set<string>();
    for (const spec of ACCESSORIES) {
      const uuid = api.hap.uuid.generate(`rainmaker:${spec.key}`);
      wanted.add(uuid);
      let acc = this.cached.get(uuid);
      if (!acc) {
        acc = new api.platformAccessory(spec.name, uuid, spec.category(api.hap));
        fresh.push(acc);
      }
      setInfo(api, acc, spec.name);
      const part = spec.create(ctx, acc);
      part.update(state);
      this.parts = [...this.parts, part];
    }
    this.removeStale(wanted);
    if (fresh.length > 0) {
      api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, fresh);
      for (const acc of fresh) this.registered.add(acc.UUID);
    }
    this.subscribe(hub);
  }

  private removeStale(wanted: Set<string>): void {
    const stale = [...this.cached.values()].filter((acc) => !wanted.has(acc.UUID));
    if (stale.length === 0) return;
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    for (const acc of stale) {
      this.cached.delete(acc.UUID);
      this.registered.delete(acc.UUID);
      this.log.info(`Rainmaker: removed the retired accessory "${acc.displayName}"`);
    }
  }

  private subscribe(hub: Hub): void {
    const onChange = (s: ControllerState) => {
      for (const part of this.parts) part.update(s);
    };
    const onCode = ({ code, expiresAt }: { code: string; expiresAt: number }) => {
      const minutes = Math.max(1, Math.round((expiresAt - this.clock()) / 60_000));
      this.log.info(`Rainmaker pairing code: ${code} (enter it in the Rainmaker app within ${minutes} minutes)`);
    };
    hub.store.on('change', onChange);
    hub.pairing.on('code', onCode);
    this.unsubscribe = [() => hub.store.off('change', onChange), () => hub.pairing.off('code', onCode)];
  }

  private save(acc: PlatformAccessory): void {
    if (this.registered.has(acc.UUID)) this.api.updatePlatformAccessories([acc]);
  }

  private async shutdown(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const off of this.unsubscribe.splice(0)) off();
    try {
      await this.hub?.stop();
    } catch (err) {
      this.log.error(`Rainmaker hub did not stop cleanly: ${message(err)}`);
    }
  }
}
