import type { ControllerClient } from '../controller/client.js';
import type { JsonStore } from '../persist/jsonStore.js';
import { localToUtcMs } from '../state/model.js';
import type { StateStore } from '../state/store.js';

const STORE_KEY = 'history';
const LOOKBACK_SEC = 7 * 86400;

type Map_ = Readonly<Record<number, number>>;

/**
 * Durable "last ran" per zone (UTC ms), the max of: the controller log (/jl, last 7 days),
 * /jc.lrun (as set on zones by the poller) and the hub's own runZone commands.
 * A command is recorded at the moment it is issued (`now`, not now + seconds): it is a lower
 * bound for when the zone last ran and never claims a run end that has not happened yet.
 * Controllers without an SD card answer /jl with 404 (getLog -> null); that source is skipped.
 */
export class RunHistory {
  private lastRun: Map_ = {};
  private loaded: Promise<void> | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: ControllerClient,
    private readonly store: StateStore,
    private readonly persist: JsonStore,
  ) {
    store.on('command', (e: { type: string; id?: number }) => {
      if (e.type === 'runZone' && typeof e.id === 'number') this.enqueue(() => this.merge({ [e.id as number]: Date.now() }));
    });
  }

  lastRunAt(zoneId: number): number | null {
    return this.lastRun[zoneId] ?? null;
  }

  async refresh(): Promise<void> {
    await this.chain;
    await this.ensureLoaded();
    const found: Record<number, number> = {};
    const { tzOffsetSec, zones } = this.store.get();
    for (const z of zones) if (z.lastRunAt !== null) found[z.id] = z.lastRunAt;
    const nowLocalSec = Math.floor(Date.now() / 1000) + tzOffsetSec;
    const log = await this.client.getLog(nowLocalSec - LOOKBACK_SEC, nowLocalSec);
    for (const [, sid, , endLocal] of log ?? []) {
      const at = localToUtcMs(endLocal, tzOffsetSec);
      if (at > (found[sid] ?? 0)) found[sid] = at;
    }
    await this.enqueue(() => this.merge(found));
    this.writeBack();
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.chain.then(job);
    this.chain = run.catch((err: unknown) => console.warn('rainmaker: run history update failed', err));
    return run;
  }

  private ensureLoaded(): Promise<void> {
    this.loaded ??= this.persist.get<Map_>(STORE_KEY, {}).then((saved) => {
      this.lastRun = this.maxOf(saved, this.lastRun);
    });
    return this.loaded;
  }

  private async merge(incoming: Map_): Promise<void> {
    await this.ensureLoaded();
    const next = this.maxOf(this.lastRun, incoming);
    if (Object.keys(next).every((k) => next[Number(k)] === this.lastRun[Number(k)])) return;
    this.lastRun = next;
    await this.persist.set(STORE_KEY, next);
  }

  private maxOf(a: Map_, b: Map_): Map_ {
    const out: Record<number, number> = { ...a };
    for (const [k, v] of Object.entries(b)) if (v > (out[Number(k)] ?? 0)) out[Number(k)] = v;
    return out;
  }

  private writeBack(): void {
    const zones = this.store.get().zones;
    if (zones.every((z) => (this.lastRun[z.id] ?? 0) <= (z.lastRunAt ?? 0))) return;
    this.store.patch({
      zones: zones.map((z) =>
        (this.lastRun[z.id] ?? 0) > (z.lastRunAt ?? 0) ? { ...z, lastRunAt: this.lastRun[z.id] ?? null } : z,
      ),
    });
  }
}
