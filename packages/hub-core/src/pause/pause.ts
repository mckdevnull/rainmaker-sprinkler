import { isDeepStrictEqual } from 'node:util';
import { COMMAND_DEADLINE_MS, type CommandError, type CommandResult } from '../commands/commands.js';
import type { ControllerClient } from '../controller/client.js';
import { ControllerRejected, ControllerUnauthorized, ControllerUnreachable } from '../controller/errors.js';
import type { JsonStore } from '../persist/jsonStore.js';
import { scheduleToProgram, type ControllerState, type Schedule } from '../state/model.js';
import type { StateStore } from '../state/store.js';

export type PauseOwner = 'user' | 'weather';
export interface PauseRecord {
  owner: PauseOwner;
  until: number;
  appliedHours: number;
}

const MAX_RAIN_DELAY_HOURS = 32767;
const HOUR_MS = 3600e3;
const CHECK_INTERVAL_MS = 60_000;
/** Re-apply this long before the controller's delay is due to end. */
const REAPPLY_LEAD_MS = 5 * 60_000;
/** A controller delay this far from the one the hub applied was set by someone else. */
const FOREIGN_DELAY_TOLERANCE_MS = 90_000;
const PAUSE_KEY = 'pause';
const JOBS_KEY = 'scheduleJobs';

type Jobs = Record<number, number>;

export class PauseService {
  private record: PauseRecord | null = null;
  private jobs: Jobs = {};
  /** When the delay now on the controller ends, as far as the hub knows; undefined = unknown. */
  private appliedUntil: number | undefined;
  private weather = false;
  private busy = false;
  private loaded: Promise<void> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private readonly onChange = (s: ControllerState): void => this.observe(s);
  private readonly onOnline = (): void => this.safeCheck();

  constructor(
    private readonly client: ControllerClient,
    private readonly store: StateStore,
    private readonly persist: JsonStore,
    private readonly clock: () => number = Date.now,
  ) {}

  start(): void {
    if (this.timer) return;
    this.store.on('change', this.onChange);
    this.store.on('online', this.onOnline);
    this.timer = setInterval(() => this.safeCheck(), CHECK_INTERVAL_MS);
    this.timer.unref();
    this.safeCheck();
  }

  stop(): void {
    this.store.off('change', this.onChange);
    this.store.off('online', this.onOnline);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  describe(): { all: PauseRecord | null; schedules: Record<number, number> } {
    const weather: PauseRecord | null =
      this.weather && this.appliedUntil !== undefined
        ? { owner: 'weather', until: this.appliedUntil, appliedHours: 0 }
        : null;
    return { all: this.record ?? weather, schedules: { ...this.jobs } };
  }

  private safeCheck(): void {
    this.checkNow().catch((err: unknown) => console.error('rainmaker pause check failed', err));
  }

  /** Run one re-apply / re-enable pass now (the timer and 'online' do the same). */
  checkNow(): Promise<void> {
    return this.locked(async () => {
      await this.ensureLoaded();
      if (!this.store.get().online) return;
      const now = this.clock();
      await this.checkAll(now);
      await this.checkJobs(now);
    });
  }

  pauseAll(untilMs: number): Promise<CommandResult> {
    return this.locked(async () => {
      await this.ensureLoaded();
      if (!Number.isFinite(untilMs) || untilMs <= this.clock()) return { ok: false, error: 'rejected' };
      return this.applyRainDelay({ owner: 'user', until: untilMs, appliedHours: 0 });
    });
  }

  resumeAll(): Promise<CommandResult> {
    return this.locked(async () => {
      await this.ensureLoaded();
      const start = Date.now();
      try {
        await this.client.setRainDelayHours(0, { deadlineMs: COMMAND_DEADLINE_MS });
      } catch (err) {
        return { ok: false, error: this.mapError(err) };
      }
      this.record = null;
      this.appliedUntil = 0;
      this.weather = false;
      this.store.patch({ rainDelayUntil: null });
      if (!(await this.saveRecord(null))) return { ok: false, error: 'rejected' };
      return { ok: true, confirmedInMs: Date.now() - start };
    });
  }

  pauseSchedule(id: number, untilMs: number): Promise<CommandResult> {
    return this.locked(async () => {
      await this.ensureLoaded();
      const s = this.schedule(id);
      if (!s || !Number.isFinite(untilMs) || untilMs <= this.clock()) return { ok: false, error: 'rejected' };
      const start = Date.now();
      // Persist the job first: a disabled program must never exist without its re-enable job.
      const withJob = { ...this.jobs, [id]: untilMs };
      if (!(await this.saveJobs(withJob))) return { ok: false, error: 'rejected' };
      try {
        await this.client.setProgram(id, scheduleToProgram({ ...s, enabled: false }), { deadlineMs: COMMAND_DEADLINE_MS });
      } catch (err) {
        await this.saveJobs(this.without(id));
        return { ok: false, error: this.mapError(err) };
      }
      this.patchSchedule(id, { enabled: false, pausedUntil: untilMs });
      return { ok: true, confirmedInMs: Date.now() - start };
    });
  }

  resumeSchedule(id: number): Promise<CommandResult> {
    return this.locked(async () => {
      await this.ensureLoaded();
      if (!(id in this.jobs)) return { ok: true, confirmedInMs: 0 };
      const start = Date.now();
      const failure = await this.reenable(id, true);
      return failure ? { ok: false, error: failure } : { ok: true, confirmedInMs: Date.now() - start };
    });
  }

  // ---- internals -------------------------------------------------------------------------

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      this.busy = true;
      try {
        return await fn();
      } finally {
        this.busy = false;
        this.observe(this.store.get());
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private ensureLoaded(): Promise<void> {
    this.loaded ??= (async () => {
      const record = await this.persist.get<PauseRecord | null>(PAUSE_KEY, null);
      const jobs = await this.persist.get<Jobs>(JOBS_KEY, {});
      this.record = record;
      this.jobs = jobs;
    })().catch((err: unknown) => {
      this.loaded = null; // a transient read error must not disable the service for good
      throw err;
    });
    return this.loaded;
  }

  /** Applies `want.until` to the controller; persists the record only after the controller accepts. */
  private async applyRainDelay(want: PauseRecord): Promise<CommandResult> {
    const start = Date.now();
    const now = this.clock();
    const hours = Math.min(MAX_RAIN_DELAY_HOURS, Math.ceil((want.until - now) / HOUR_MS));
    try {
      await this.client.setRainDelayHours(hours, { deadlineMs: COMMAND_DEADLINE_MS });
    } catch (err) {
      return { ok: false, error: this.mapError(err) };
    }
    const end = now + hours * HOUR_MS;
    this.appliedUntil = end;
    this.weather = false;
    this.record = { ...want, appliedHours: hours };
    this.store.patch({ rainDelayUntil: end });
    if (!(await this.saveRecord(this.record))) return { ok: false, error: 'rejected' };
    return { ok: true, confirmedInMs: Date.now() - start };
  }

  private async checkAll(now: number): Promise<void> {
    const rec = this.record;
    if (!rec) return;
    if (rec.until <= now) {
      // The controller's own delay runs out by itself.
      if (await this.saveRecord(null)) this.record = null;
      return;
    }
    const end = this.appliedUntil ?? this.store.get().rainDelayUntil ?? 0;
    if (now >= end - REAPPLY_LEAD_MS && rec.until > end) await this.applyRainDelay(rec);
  }

  private async checkJobs(now: number): Promise<void> {
    for (const [key, until] of Object.entries(this.jobs)) {
      if (until <= now) await this.reenable(Number(key));
    }
  }

  /**
   * Returns null on success, otherwise the error. The job is removed on success, or always when `drop`
   * (explicit resume); otherwise it stays persisted for the next retry.
   */
  private async reenable(id: number, drop = false): Promise<CommandError | null> {
    const s = this.schedule(id);
    let failure: CommandError | null = s ? null : 'rejected';
    if (s) {
      try {
        await this.client.setProgram(id, scheduleToProgram({ ...s, enabled: true }), { deadlineMs: COMMAND_DEADLINE_MS });
      } catch (err) {
        failure = this.mapError(err);
      }
    }
    if (failure && !drop) return failure;
    if (!(await this.saveJobs(this.without(id)))) return failure ?? 'rejected';
    if (!failure) this.patchSchedule(id, { enabled: true, pausedUntil: null });
    return failure;
  }

  private without(id: number): Jobs {
    return Object.fromEntries(Object.entries(this.jobs).filter(([key]) => Number(key) !== id));
  }

  /** Persist then adopt in memory; on a disk error memory is left unchanged so the work is retried. */
  private async saveJobs(next: Jobs): Promise<boolean> {
    try {
      await this.persist.set(JOBS_KEY, next);
    } catch (err) {
      console.error('rainmaker pause: could not persist schedule jobs', err);
      return false;
    }
    this.jobs = next;
    return true;
  }

  private async saveRecord(next: PauseRecord | null): Promise<boolean> {
    try {
      await this.persist.set(PAUSE_KEY, next);
      return true;
    } catch (err) {
      console.error('rainmaker pause: could not persist pause record', err);
      return false;
    }
  }

  /** Owner detection and pausedUntil annotation on every state change. */
  private observe(state: ControllerState): void {
    this.annotateSchedules(state);
    if (this.busy || !state.online) return;
    const rd = state.rainDelayUntil;
    const now = this.clock();
    if (rd !== null && rd > now) {
      if (this.appliedUntil !== undefined && Math.abs(rd - this.appliedUntil) > FOREIGN_DELAY_TOLERANCE_MS) {
        this.appliedUntil = rd;
        this.weather = true;
      }
    } else if (this.appliedUntil !== undefined) {
      // No delay on the controller any more (weather ended, or it was lost): let the next check restore ours.
      this.appliedUntil = 0;
      this.weather = false;
    }
  }

  private annotateSchedules(state: ControllerState): void {
    const schedules = state.schedules.map((s) => {
      const until = this.jobs[s.id] ?? null;
      return s.pausedUntil === until ? s : { ...s, pausedUntil: until };
    });
    if (!isDeepStrictEqual(schedules, state.schedules)) this.store.patch({ schedules });
  }

  private schedule(id: number): Schedule | undefined {
    return this.store.get().schedules.find((s) => s.id === id);
  }

  private patchSchedule(id: number, change: Partial<Schedule>): void {
    const schedules = this.store.get().schedules.map((s) => (s.id === id ? { ...s, ...change } : s));
    this.store.patch({ schedules });
  }

  private mapError(err: unknown): CommandError {
    if (err instanceof ControllerUnauthorized) return 'unauthorized';
    if (err instanceof ControllerRejected) return 'rejected';
    if (err instanceof ControllerUnreachable) return this.store.get().online === false ? 'offline' : 'timeout';
    console.error('rainmaker pause error', err);
    return 'timeout';
  }
}
