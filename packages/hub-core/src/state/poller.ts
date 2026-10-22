import { ControllerUnauthorized, ControllerUnreachable } from '../controller/errors.js';
import type { ControllerClient } from '../controller/client.js';
import { PollSuperseded } from '../controller/queue.js';
import type { JcResponse, JsResponse } from '../controller/types.js';
import { localToUtcMs, programToSchedule, type Zone } from './model.js';
import type { StateStore } from './store.js';

export interface PollerOptions {
  idleIntervalMs: number;
  activeIntervalMs: number;
  offlineAfterFailures: number;
}

const DEFAULTS: PollerOptions = { idleIntervalMs: 5000, activeIntervalMs: 2000, offlineAfterFailures: 3 };
const FULL_REFRESH_MS = 60_000;
const TZ_STEP_SEC = 900;

export class Poller {
  private readonly opts: PollerOptions;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private failures = 0;
  private names: string[] = [];
  private lastFullAt = 0;
  private lastNbrd = -1;
  private lastStations = -1;

  constructor(
    private readonly client: ControllerClient,
    private readonly store: StateStore,
    opts: Partial<PollerOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async pollNow(): Promise<void> {
    try {
      const jc = await this.client.getStatus();
      const js = await this.client.getStations();
      if (this.needsFullFetch(jc, js)) await this.fullFetch(jc, js);
      this.failures = 0;
      this.applyStatus(jc, js);
    } catch (err) {
      this.handleError(err);
    }
  }

  applyStatus(jc: JcResponse, js?: JsResponse): void {
    const prev = this.store.get();
    const tzOffsetSec = Math.round((jc.devt - Math.floor(Date.now() / 1000)) / TZ_STEP_SEC) * TZ_STEP_SEC;
    const count = js?.nstations ?? (prev.zones.length > 0 ? prev.zones.length : jc.nbrd * 8);
    const zones = Array.from({ length: count }, (_, id): Zone => {
      const old = prev.zones[id];
      const running = (((jc.sbits[id >> 3] ?? 0) >> (id & 7)) & 1) === 1;
      const [pid = 0, remaining = 0] = jc.ps[id] ?? [];
      const queued = !running && pid !== 0 && remaining > 0;
      return {
        id,
        name: this.names[id] ?? old?.name ?? `Station ${id + 1}`,
        status: running ? 'running' : queued ? 'queued' : 'idle',
        remainingSec: running || queued ? remaining : null,
        lastRunAt: old?.lastRunAt ?? null,
      };
    });
    const [lastSid, , , lastEnd] = jc.lrun;
    const last = zones[lastSid];
    if (last && lastEnd > 0) last.lastRunAt = localToUtcMs(lastEnd, tzOffsetSec);
    this.store.patch({
      online: true,
      unauthorized: false,
      lastSeenAt: Date.now(),
      tzOffsetSec,
      enabled: jc.en === 1,
      rainDelayUntil: jc.rd === 1 ? localToUtcMs(jc.rdst, tzOffsetSec) : null,
      zones,
    });
  }

  private needsFullFetch(jc: JcResponse, js: JsResponse): boolean {
    return (
      this.lastFullAt === 0 ||
      jc.nbrd !== this.lastNbrd ||
      js.nstations !== this.lastStations ||
      Date.now() - this.lastFullAt >= FULL_REFRESH_MS
    );
  }

  private async fullFetch(jc: JcResponse, js: JsResponse): Promise<void> {
    const jn = await this.client.getNames();
    const jp = await this.client.getPrograms();
    const jo = await this.client.getOptions();
    this.names = jn.snames;
    this.lastNbrd = jc.nbrd;
    this.lastStations = js.nstations;
    this.lastFullAt = Date.now();
    this.store.patch({
      schedules: jp.pd.map((pd, i) => programToSchedule(i, pd)),
      firmware: { fwv: jo.fwv, hwv: jo.hwv },
    });
  }

  private handleError(err: unknown): void {
    if (err instanceof PollSuperseded) return;
    if (err instanceof ControllerUnauthorized) {
      this.store.patch({ unauthorized: true });
      return;
    }
    if (!(err instanceof ControllerUnreachable)) throw err;
    this.failures += 1;
    if (this.failures >= this.opts.offlineAfterFailures) {
      const zones = this.store.get().zones.map((z): Zone => ({ ...z, status: 'unknown', remainingSec: null }));
      this.store.patch({ online: false, zones });
    }
  }

  private async loop(): Promise<void> {
    try {
      await this.pollNow();
    } catch (err) {
      console.error('rainmaker poller error', err);
    }
    if (!this.running) return;
    const busy = this.store.get().zones.some((z) => z.status === 'running' || z.status === 'queued');
    this.timer = setTimeout(() => void this.loop(), busy ? this.opts.activeIntervalMs : this.opts.idleIntervalMs);
  }
}
