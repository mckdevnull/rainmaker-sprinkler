import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSimulator, type Simulator } from '@rainmaker/controller-sim';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControllerClient } from '../../src/controller/client.js';
import { PauseService } from '../../src/pause/pause.js';
import { JsonStore } from '../../src/persist/jsonStore.js';
import { Poller } from '../../src/state/poller.js';
import { StateStore } from '../../src/state/store.js';

const PASSWORD = 'opendoor';
const HOUR = 3600e3;
const DAY = 24 * HOUR;
let sim: Simulator | undefined;
let dir: string;
const services: PauseService[] = [];

class FlakyStore extends JsonStore {
  failNextSet = false;
  override async set<T>(key: string, value: T): Promise<void> {
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error('disk full');
    }
    return super.set(key, value);
  }
}

/** Real-time poll for a condition (vitest's waitFor would drive the faked interval). */
async function eventually(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(pred()).toBe(true);
}

async function setup(persist: JsonStore = new JsonStore(dir)) {
  sim = createSimulator({ password: PASSWORD, passwordMode: 'plain', responseDelayMs: 1, clock: () => Date.now() });
  const { baseUrl } = await sim.listen(0);
  const client = new ControllerClient({ baseUrl, password: PASSWORD, timeoutMs: 3000 });
  const store = new StateStore();
  const poller = new Poller(client, store);
  await poller.pollNow();
  const make = () => {
    const svc = new PauseService(client, store, persist, () => Date.now());
    services.push(svc);
    return svc;
  };
  return { sim, baseUrl, client, store, poller, persist, make, svc: make() };
}

/** Jump the shared fake clock without firing timers. */
const jump = (ms: number) => vi.setSystemTime(Date.now() + ms);

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rainmaker-pause-'));
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: Date.now() });
});
afterEach(async () => {
  services.splice(0).forEach((s) => s.stop());
  vi.useRealTimers();
  await sim?.close();
  sim = undefined;
  await fs.rm(dir, { recursive: true, force: true });
});

describe('PauseService all-zones pause', () => {
  it('pauseAll sets rain delay to the hours until the date', async () => {
    const { svc, sim, store } = await setup();
    const until = Date.now() + 72 * HOUR;
    expect((await svc.pauseAll(until)).ok).toBe(true);
    expect(sim.state.rainDelayUntil).toBe(until);
    expect(store.get().rainDelayUntil).toBe(until);
    expect(svc.describe().all).toMatchObject({ owner: 'user', until, appliedHours: 72 });
  });

  it('pauseAll beyond the max caps and re-applies', async () => {
    const { svc, sim } = await setup();
    const until = Date.now() + 5 * 365 * DAY;
    const start = Date.now();
    expect((await svc.pauseAll(until)).ok).toBe(true);
    expect(sim.state.rainDelayUntil).toBe(start + 32767 * HOUR);
    expect(svc.describe().all?.appliedHours).toBe(32767);
    jump(32767 * HOUR + 1000);
    await svc.checkNow();
    expect(sim.state.rainDelayUntil).toBeGreaterThan(Date.now());
    expect(svc.describe().all?.until).toBe(until);
  });

  it('resumeAll clears the delay and record', async () => {
    const { svc, sim, persist } = await setup();
    await svc.pauseAll(Date.now() + 72 * HOUR);
    expect((await svc.resumeAll()).ok).toBe(true);
    expect(sim.state.rainDelayUntil).toBeNull();
    expect(svc.describe().all).toBeNull();
    expect(await persist.get('pause', null)).toBeNull();
  });

  it('weather delay that overwrites a user pause is restored when it ends', async () => {
    const { svc, sim, baseUrl, poller } = await setup();
    svc.start();
    const until = Date.now() + 7 * DAY;
    await svc.pauseAll(until);
    await fetch(`${baseUrl}/cv?pw=${PASSWORD}&rd=24`);
    await poller.pollNow();
    expect(svc.describe().all?.until).toBe(until);
    jump(DAY);
    await poller.pollNow();
    await svc.checkNow();
    expect(sim.state.rainDelayUntil).toBe(until);
  });
});

describe('PauseService schedule pause', () => {
  it('pauseSchedule clears the enable bit and re-enables on the date, and persists across restart', async () => {
    const { svc, sim, make, store } = await setup();
    const until = Date.now() + 3 * DAY;
    expect((await svc.pauseSchedule(0, until)).ok).toBe(true);
    expect((sim.state.programs[0]?.flag ?? 1) & 1).toBe(0);
    expect(store.get().schedules[0]).toMatchObject({ enabled: false, pausedUntil: until });
    expect(svc.describe().schedules).toEqual({ 0: until });
    svc.stop();

    jump(3 * DAY + 1000);
    const second = make();
    second.start();
    await eventually(() => ((sim.state.programs[0]?.flag ?? 0) & 1) === 1);
    await second.checkNow();
    expect(second.describe().schedules).toEqual({});
  });

  it('pauseSchedule changes only the enable bit and keeps the name', async () => {
    const { svc, sim, poller } = await setup();
    const program = sim.state.programs[0];
    if (!program) throw new Error('no program');
    program.name = 'Lawn';
    program.flag = 0b111;
    await poller.pollNow();
    jump(61_000); // force a full refresh so the store sees the edit
    await poller.pollNow();
    await svc.pauseSchedule(0, Date.now() + DAY);
    expect(sim.state.programs[0]?.flag).toBe(0b110);
    expect(sim.state.programs[0]?.name).toBe('Lawn');
    await svc.resumeSchedule(0);
    expect(sim.state.programs[0]?.flag).toBe(0b111);
    expect(sim.state.programs[0]?.name).toBe('Lawn');
    expect(svc.describe().schedules).toEqual({});
  });

  it('re-enable is retried when the controller is offline at the deadline', async () => {
    const { svc, sim, store, poller } = await setup();
    await svc.pauseSchedule(0, Date.now() + DAY);
    svc.start();
    sim.setOffline(true);
    jump(DAY + 1000);
    await svc.checkNow(); // store still says online; the command fails and the job stays
    expect(svc.describe().schedules).toHaveProperty('0');
    sim.setOffline(false);
    await poller.pollNow();
    expect(store.get().online).toBe(true);
    store.emit('online');
    await svc.checkNow();
    expect((sim.state.programs[0]?.flag ?? 0) & 1).toBe(1);
    expect(svc.describe().schedules).toEqual({});
  });

  it('restart while a job is pending and overdue restores it', async () => {
    const { svc, sim, make } = await setup();
    await svc.pauseSchedule(0, Date.now() + DAY);
    sim.setOffline(true);
    jump(DAY + 1000);
    await svc.checkNow();
    expect(svc.describe().schedules).toHaveProperty('0');
    svc.stop();
    sim.setOffline(false);
    const second = make();
    second.start();
    await eventually(() => ((sim.state.programs[0]?.flag ?? 0) & 1) === 1);
    await second.checkNow();
    expect(second.describe().schedules).toEqual({});
  });

  it('the 60 s timer retries a failed re-enable', async () => {
    const { svc, sim } = await setup();
    await svc.pauseSchedule(0, Date.now() + DAY);
    svc.start();
    sim.setOffline(true);
    jump(DAY + 1000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(svc.describe().schedules).toHaveProperty('0');
    sim.setOffline(false);
    await vi.advanceTimersByTimeAsync(60_000);
    await eventually(() => ((sim.state.programs[0]?.flag ?? 0) & 1) === 1);
    await svc.checkNow();
    expect(svc.describe().schedules).toEqual({});
  });

  it('survives a persist failure: the job remains and the next check succeeds', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const flaky = new FlakyStore(dir);
    const { svc, sim } = await setup(flaky);
    await svc.pauseSchedule(0, Date.now() + DAY);
    jump(DAY + 1000);
    flaky.failNextSet = true;
    await expect(svc.checkNow()).resolves.toBeUndefined();
    expect(svc.describe().schedules).toHaveProperty('0');
    await svc.checkNow();
    expect(svc.describe().schedules).toEqual({});
    expect((sim.state.programs[0]?.flag ?? 0) & 1).toBe(1);
  });

  it('pauseSchedule reports rejected, not a throw, when persisting fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const flaky = new FlakyStore(dir);
    const { svc, sim } = await setup(flaky);
    flaky.failNextSet = true;
    expect(await svc.pauseSchedule(0, Date.now() + DAY)).toEqual({ ok: false, error: 'rejected' });
    expect((sim.state.programs[0]?.flag ?? 0) & 1).toBe(1);
    expect(svc.describe().schedules).toEqual({});
  });

  it('resumeSchedule without a job is a no-op, and drops an orphaned job', async () => {
    const { svc, sim, store } = await setup();
    const flagBefore = sim.state.programs[0]?.flag;
    expect(await svc.resumeSchedule(0)).toEqual({ ok: true, confirmedInMs: 0 });
    expect(sim.state.programs[0]?.flag).toBe(flagBefore);
    await svc.pauseSchedule(0, Date.now() + DAY);
    store.patch({ schedules: [] }); // schedule vanished from the controller
    expect((await svc.resumeSchedule(0)).ok).toBe(false);
    expect(svc.describe().schedules).toEqual({});
  });
});
