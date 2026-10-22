import { EventEmitter } from 'node:events';
import type { StateStore } from '../state/store.js';
import type { SmartPlug } from './plug.js';

export interface WatchdogOptions {
  minGapMs: number;
  maxPerHour: number;
  offMs: number;
}

const DEFAULTS: WatchdogOptions = { minGapMs: 10 * 60_000, maxPerHour: 3, offMs: 30_000 };
const HOUR_MS = 3_600_000;

/**
 * Power-cycles the controller via a smart plug when it goes offline, rate limited.
 * Events: 'power-cycle' {at, count}, 'recovery-exhausted', 'recovered' {afterCycles}.
 */
export class Watchdog extends EventEmitter {
  private readonly opts: WatchdogOptions;
  private cycles: number[] = [];
  private cyclesSinceRecovery = 0;
  private exhausted = false;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  private readonly onOffline = (): void => this.attempt();
  private readonly onOnline = (): void => this.recovered();

  constructor(
    private readonly store: StateStore,
    private readonly plug: SmartPlug | null,
    opts: Partial<WatchdogOptions> = {},
    private readonly clock: () => number = Date.now,
  ) {
    super();
    this.opts = { ...DEFAULTS, ...opts };
  }

  start(): void {
    if (this.running || !this.plug) return; // no plug: nothing to listen for, emit or schedule
    this.running = true;
    this.store.on('offline', this.onOffline);
    this.store.on('online', this.onOnline);
    if (!this.store.get().online) this.attempt();
  }

  stop(): void {
    this.running = false;
    this.store.off('offline', this.onOffline);
    this.store.off('online', this.onOnline);
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.running && !this.store.get().online) this.attempt();
    }, ms);
  }

  private recovered(): void {
    this.clearTimer();
    this.exhausted = false;
    const afterCycles = this.cyclesSinceRecovery;
    this.cyclesSinceRecovery = 0;
    this.emit('recovered', { afterCycles });
  }

  private attempt(): void {
    if (!this.plug || this.exhausted) return;
    const now = this.clock();
    this.cycles = this.cycles.filter((t) => now - t < HOUR_MS);
    const last = this.cycles[this.cycles.length - 1];
    if (last !== undefined && now - last < this.opts.minGapMs) {
      this.schedule(this.opts.minGapMs - (now - last));
      return;
    }
    if (this.cycles.length >= this.opts.maxPerHour) {
      // Budget spent: no retries until the controller recovers; the owner is told via 'recovery-exhausted'.
      this.exhausted = true;
      this.clearTimer();
      this.emit('recovery-exhausted');
      return;
    }
    this.cycles.push(now);
    this.cyclesSinceRecovery += 1;
    this.schedule(this.opts.minGapMs);
    this.emit('power-cycle', { at: now, count: this.cycles.length });
    this.plug.powerCycle(this.opts.offMs).catch((err: unknown) => {
      console.error('rainmaker watchdog: smart plug power cycle failed', err);
    });
  }
}
