import { createSimulator, type Simulator } from '@rainmaker/controller-sim';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControllerClient } from '../../src/controller/client.js';
import { ControllerUnreachable } from '../../src/controller/errors.js';
import { PollSuperseded } from '../../src/controller/queue.js';
import { Poller, type PollerOptions } from '../../src/state/poller.js';
import { StateStore } from '../../src/state/store.js';

const PASSWORD = 'opendoor';
let sim: Simulator | undefined;
let poller: Poller | undefined;

async function setup(simOpts: Parameters<typeof createSimulator>[0] = {}, pollOpts: Partial<PollerOptions> = {}) {
  sim = createSimulator({ password: PASSWORD, passwordMode: 'plain', responseDelayMs: 5, ...simOpts });
  const { baseUrl } = await sim.listen(0);
  const client = new ControllerClient({ baseUrl, password: PASSWORD, timeoutMs: 300 });
  const store = new StateStore();
  poller = new Poller(client, store, pollOpts);
  return { sim, client, store, poller, baseUrl };
}

const run = (baseUrl: string, query: string) => fetch(`${baseUrl}/cm?pw=${PASSWORD}&${query}`);

afterEach(async () => {
  poller?.stop();
  poller = undefined;
  await sim?.close();
  sim = undefined;
});

describe('Poller', () => {
  it('first poll fills zones and firmware from the controller', async () => {
    const { poller, store } = await setup();
    await poller.pollNow();
    const s = store.get();
    expect(s.online).toBe(true);
    expect(s.zones).toHaveLength(8);
    expect(s.zones.map((z) => z.name)).toEqual(sim?.state.stations.map((z) => z.name));
    expect(s.zones.every((z) => z.status === 'idle')).toBe(true);
    expect(s.firmware?.fwv).toBe(216);
    expect(s.schedules).toHaveLength(1);
    expect(s.tzOffsetSec).toBe(-21600);
  });

  it('running zone shows status running and remaining seconds', async () => {
    const { poller, store, baseUrl } = await setup();
    await run(baseUrl, 'sid=0&en=1&t=60');
    await poller.pollNow();
    const z = store.get().zones[0];
    expect(z?.status).toBe('running');
    expect(z?.remainingSec).toBeGreaterThan(0);
    expect(z?.remainingSec).toBeLessThanOrEqual(60);
    expect(store.get().zones[1]?.status).toBe('idle');
  });

  it('queued zone shows status queued', async () => {
    const { poller, store, baseUrl } = await setup();
    await run(baseUrl, 'sid=0&en=1&t=60');
    await run(baseUrl, 'sid=1&en=1&t=60');
    await poller.pollNow();
    expect(store.get().zones[0]?.status).toBe('running');
    expect(store.get().zones[1]?.status).toBe('queued');
  });

  it('polls faster while something is running', async () => {
    const { poller, client, baseUrl } = await setup({}, { idleIntervalMs: 400, activeIntervalMs: 100 });
    const stamps: number[] = [];
    const real = client.getStatus.bind(client);
    vi.spyOn(client, 'getStatus').mockImplementation((o) => {
      stamps.push(Date.now());
      return real(o);
    });
    poller.start();
    await vi.waitFor(() => expect(stamps.length).toBeGreaterThanOrEqual(3), { timeout: 3000 });
    const idleGap = (stamps[2] ?? 0) - (stamps[1] ?? 0);
    expect(idleGap).toBeGreaterThanOrEqual(380);
    await run(baseUrl, 'sid=0&en=1&t=60');
    await vi.waitFor(() => expect(stamps.length).toBeGreaterThanOrEqual(8), { timeout: 5000 });
    const gaps = stamps.slice(-3).map((t, i, a) => t - (a[i - 1] ?? t)).slice(1);
    for (const g of gaps) {
      expect(g).toBeLessThan(300);
      expect(g).toBeGreaterThanOrEqual(90);
    }
  });

  it('marks offline after 3 failed polls and zones become unknown', async () => {
    const { poller, store, sim } = await setup({}, { idleIntervalMs: 40 });
    await poller.pollNow();
    expect(store.get().online).toBe(true);
    let offline = 0;
    store.on('offline', () => (offline += 1));
    sim.setOffline(true);
    poller.start();
    await vi.waitFor(() => expect(store.get().online).toBe(false), { timeout: 5000 });
    expect(store.get().zones.every((z) => z.status === 'unknown' && z.remainingSec === null)).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(offline).toBe(1);
  });

  it('recovers and emits online', async () => {
    const { poller, store, sim } = await setup({}, { idleIntervalMs: 40 });
    await poller.pollNow();
    sim.setOffline(true);
    poller.start();
    await vi.waitFor(() => expect(store.get().online).toBe(false), { timeout: 5000 });
    let online = 0;
    store.on('online', () => (online += 1));
    sim.setOffline(false);
    await vi.waitFor(() => expect(store.get().online).toBe(true), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(online).toBe(1);
    expect(store.get().zones.every((z) => z.status === 'idle')).toBe(true);
  });

  it('shrinks zones when the controller reports fewer stations', async () => {
    const { poller, store, sim } = await setup();
    await poller.pollNow();
    expect(store.get().zones).toHaveLength(8);
    sim.setStationCount(4);
    await expect(poller.pollNow()).resolves.toBeUndefined();
    expect(store.get().zones).toHaveLength(4);
  });

  it('patch emits change only on real differences', () => {
    const store = new StateStore();
    const changes: unknown[] = [];
    store.on('change', (s) => changes.push(s));
    store.patch({ enabled: true });
    expect(changes).toHaveLength(0);
    store.patch({ enabled: false });
    expect(changes).toHaveLength(1);
    store.patch({ zones: [] });
    store.patch({ enabled: false });
    expect(changes).toHaveLength(1);
    store.patch({ rainDelayUntil: 5 });
    expect(changes).toHaveLength(2);
  });

  it('rain delay end is converted from controller-local time', async () => {
    const { poller, store, baseUrl } = await setup({ tzOffsetSec: -21600 });
    await fetch(`${baseUrl}/cv?pw=${PASSWORD}&rd=2`);
    await poller.pollNow();
    const until = store.get().rainDelayUntil ?? 0;
    expect(Math.abs(until - (Date.now() + 2 * 3600_000))).toBeLessThan(1000);
  });

  it('flags unauthorized without going offline', async () => {
    const { poller, store, sim } = await setup();
    await poller.pollNow();
    sim.setPassword('changed');
    await poller.pollNow();
    expect(store.get().unauthorized).toBe(true);
    expect(store.get().online).toBe(true);
  });

  it('lastSeenAt does not cause change events', async () => {
    const { poller, store } = await setup();
    let changes = 0;
    store.on('change', () => (changes += 1));
    await poller.pollNow();
    const first = changes;
    expect(first).toBeGreaterThan(0);
    const seen = store.get().lastSeenAt;
    await new Promise((r) => setTimeout(r, 5));
    await poller.pollNow();
    await poller.pollNow();
    expect(changes).toBe(first);
    expect(store.get().lastSeenAt).toBeGreaterThan(seen ?? 0);
  });

  it('remainingSec changes while a zone runs still emit change', async () => {
    const { poller, store, baseUrl } = await setup();
    await run(baseUrl, 'sid=0&en=1&t=60');
    await poller.pollNow();
    let changes = 0;
    store.on('change', () => (changes += 1));
    sim?.tick(5000);
    await poller.pollNow();
    expect(changes).toBe(1);
  });
});

describe('Poller failure counting', () => {
  const jc = { devt: 0, en: 1, rd: 0, rdst: 0, sbits: [0, 0], ps: [], nbrd: 1, lrun: [0, 0, 0, 0] };
  function scripted(outcomes: (Error | 'ok')[]) {
    const queue = [...outcomes];
    const client = {
      getStatus: () => {
        const o = queue.shift() ?? 'ok';
        return o === 'ok' ? Promise.resolve(jc) : Promise.reject(o);
      },
      getStations: () => Promise.resolve({ sn: [0, 0], nstations: 2 }),
      getNames: () => Promise.resolve({ snames: ['a', 'b'] }),
      getPrograms: () => Promise.resolve({ nprogs: 0, pd: [] }),
      getOptions: () => Promise.resolve({ fwv: 216, hwv: 22, nbrd: 1, ipas: 0, wl: 100, tz: 48 }),
    } as unknown as ControllerClient;
    const store = new StateStore();
    return { poller: new Poller(client, store), store };
  }
  const down = () => new ControllerUnreachable('down');

  it('goes offline on exactly the third consecutive failure', async () => {
    const { poller, store } = scripted(['ok', down(), down(), down()]);
    await poller.pollNow();
    expect(store.get().online).toBe(true);
    await poller.pollNow();
    await poller.pollNow();
    expect(store.get().online).toBe(true);
    await poller.pollNow();
    expect(store.get().online).toBe(false);
  });

  it('PollSuperseded does not count as a failure', async () => {
    const { poller, store } = scripted(['ok', new PollSuperseded(), new PollSuperseded(), down(), down(), down()]);
    for (let i = 0; i < 5; i += 1) await poller.pollNow();
    expect(store.get().online).toBe(true);
    await poller.pollNow();
    expect(store.get().online).toBe(false);
  });
});
