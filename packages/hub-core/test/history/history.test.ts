import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSimulator, type Simulator } from '@rainmaker/controller-sim';
import { afterEach, describe, expect, it } from 'vitest';
import { ControllerClient } from '../../src/controller/client.js';
import { RunHistory } from '../../src/history/history.js';
import { JsonStore } from '../../src/persist/jsonStore.js';
import { Poller } from '../../src/state/poller.js';
import { StateStore } from '../../src/state/store.js';

const PASSWORD = 'opendoor';
const TEN_MIN = 10 * 60e3;
let sim: Simulator | undefined;
let dir: string | undefined;

/**
 * Sim whose clock starts `skewMs` + 1 min ago; a 60 s run on zone 0 then completes `skewMs` ago.
 * A skewed sim clock makes the poller derive a wrong tz offset, so skewed tests set the store's
 * tzOffsetSec directly instead of polling.
 */
async function setup(simOpts: Parameters<typeof createSimulator>[0] = {}, skewMs = TEN_MIN) {
  const start = Date.now() - skewMs - 60e3;
  sim = createSimulator({ password: PASSWORD, responseDelayMs: 1, clock: () => start, ...simOpts });
  const { baseUrl } = await sim.listen(0);
  await fetch(`${baseUrl}/cm?pw=${PASSWORD}&sid=0&en=1&t=60`);
  sim.tick(61_000);
  const client = new ControllerClient({ baseUrl, password: PASSWORD, timeoutMs: 1000 });
  const store = new StateStore();
  const poller = new Poller(client, store);
  dir = await mkdtemp(path.join(tmpdir(), 'rainmaker-history-'));
  const persist = new JsonStore(dir);
  return { client, store, poller, persist, history: new RunHistory(client, store, persist) };
}

afterEach(async () => {
  await sim?.close();
  sim = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('RunHistory', () => {
  it('refresh completes while the poller is running', async () => {
    const { client, store, persist } = await setup();
    const poller = new Poller(client, store, { idleIntervalMs: 50, activeIntervalMs: 50 });
    const history = new RunHistory(client, store, persist);
    poller.start();
    try {
      // Overlapping refreshes plus the poller keep several reads waiting at once: none may be dropped.
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => history.refresh()));
      expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    } finally {
      poller.stop();
    }
    expect(history.lastRunAt(0)).not.toBeNull();
  });

  it('log end times are converted from controller-local time', async () => {
    const { store, history } = await setup({ tzOffsetSec: -21600 });
    store.patch({ tzOffsetSec: -21600 });
    await history.refresh();
    const at = history.lastRunAt(0);
    expect(at).not.toBeNull();
    expect(Math.abs((at ?? 0) - (Date.now() - TEN_MIN))).toBeLessThan(60_000);
    expect(history.lastRunAt(1)).toBeNull();
  });

  it('lastRunAt uses the later of /jl and local command events', async () => {
    const { store, history } = await setup();
    store.patch({ tzOffsetSec: -21600, zones: [{ id: 0, name: 'Z', status: 'idle', remainingSec: null, lastRunAt: null }] });
    const before = Date.now();
    store.emit('command', { type: 'runZone', id: 0, seconds: 300, source: 'app' });
    await history.refresh();
    expect(history.lastRunAt(0)).toBeGreaterThanOrEqual(before);
    // Written back into the store for readers of zone.lastRunAt.
    expect(store.get().zones[0]?.lastRunAt).toBe(history.lastRunAt(0));
  });

  it('survives restart', async () => {
    const { store, client, persist, history } = await setup();
    store.patch({ tzOffsetSec: -21600 });
    store.emit('command', { type: 'runZone', id: 3, seconds: 60, source: 'app' });
    await history.refresh();
    const saved = history.lastRunAt(3);
    expect(saved).not.toBeNull();
    const fresh = new RunHistory(client, new StateStore(), persist);
    await fresh.refresh();
    expect(fresh.lastRunAt(3)).toBe(saved);
    expect(fresh.lastRunAt(0)).toBe(history.lastRunAt(0));
  });

  it('falls back to lrun and local events when the controller has no log', async () => {
    // Unskewed clock so the poller derives the right tz offset; the run ended ~now.
    const { client, store, poller, persist, history } = await setup({ hasLog: false }, -1000);
    await expect(client.getLog(0, 1)).resolves.toBeNull();
    await poller.pollNow(); // lrun -> zone 0
    store.emit('command', { type: 'runZone', id: 2, seconds: 60, source: 'app' });
    await history.refresh();
    const lrunAt = history.lastRunAt(0);
    expect(Math.abs((lrunAt ?? 0) - Date.now())).toBeLessThan(60_000);
    expect(history.lastRunAt(2)).not.toBeNull();
    const fresh = new RunHistory(client, new StateStore(), persist);
    await fresh.refresh();
    expect(fresh.lastRunAt(0)).toBe(lrunAt);
    expect(fresh.lastRunAt(2)).toBe(history.lastRunAt(2));
  });
});
