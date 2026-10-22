import { createSimulator, type Simulator } from '@rainmaker/controller-sim';
import { afterEach, describe, expect, it } from 'vitest';
import { Commands } from '../../src/commands/commands.js';
import { ControllerClient } from '../../src/controller/client.js';
import { Poller } from '../../src/state/poller.js';
import { StateStore } from '../../src/state/store.js';

const PASSWORD = 'opendoor';
let sim: Simulator | undefined;

async function setup(simOpts: Parameters<typeof createSimulator>[0] = {}, pollOpts: { offlineAfterFailures?: number } = {}) {
  sim = createSimulator({ password: PASSWORD, passwordMode: 'plain', responseDelayMs: 5, ...simOpts });
  const { baseUrl } = await sim.listen(0);
  const client = new ControllerClient({ baseUrl, password: PASSWORD, timeoutMs: 3000 });
  const store = new StateStore();
  const poller = new Poller(client, store, pollOpts);
  const commands = new Commands(client, store, poller);
  return { sim, client, store, poller, commands };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  await sim?.close();
  sim = undefined;
});

describe('Commands', () => {
  it('runZone reflects running before the controller responds', async () => {
    const { commands, store, poller } = await setup({ responseDelayMs: 400 });
    await poller.pollNow();
    const p = commands.runZone(2, 60, 'app');
    await sleep(50);
    expect(store.get().zones[2]?.status).toBe('running');
    expect(store.get().zones[2]?.remainingSec).toBe(60);
    const result = await p;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.confirmedInMs).toBeLessThan(1500);
  });

  it('runZone while another runs shows queued', async () => {
    const { commands, store, poller } = await setup();
    await poller.pollNow();
    expect((await commands.runZone(0, 60, 'app')).ok).toBe(true);
    const r = await commands.runZone(1, 60, 'app');
    expect(r.ok).toBe(true);
    expect(store.get().zones[0]?.status).toBe('running');
    expect(store.get().zones[1]?.status).toBe('queued');
  });

  it('runZone works while the system is off', async () => {
    const { commands, store, poller } = await setup();
    await poller.pollNow();
    expect((await commands.setSystemEnabled(false, 'app')).ok).toBe(true);
    expect(store.get().enabled).toBe(false);
    expect((await commands.runZone(3, 60, 'app')).ok).toBe(true);
    expect(store.get().zones[3]?.status).toBe('running');
  });

  it('reverts and returns offline when unreachable', async () => {
    const { commands, store, poller } = await setup({}, { offlineAfterFailures: 1 });
    await poller.pollNow();
    sim?.setOffline(true);
    await poller.pollNow();
    expect(store.get().online).toBe(false);
    const t0 = Date.now();
    const r = await commands.runZone(0, 60, 'app');
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r).toEqual({ ok: false, error: 'offline' });
    expect(['unknown', 'idle']).toContain(store.get().zones[0]?.status);
  });

  it('stopAll clears running and queued', async () => {
    const { commands, store, poller } = await setup();
    await poller.pollNow();
    await commands.runZone(0, 60, 'app');
    await commands.runZone(1, 60, 'app');
    const r = await commands.stopAll('app');
    expect(r.ok).toBe(true);
    expect(store.get().zones.every((z) => z.status === 'idle')).toBe(true);
    expect(sim?.state.stations.length).toBe(8);
  });

  it('source is recorded on the command event', async () => {
    const { commands, store, poller } = await setup();
    await poller.pollNow();
    const events: unknown[] = [];
    store.on('command', (e) => events.push(e));
    await commands.runZone(1, 90, 'siri-intent');
    expect(events).toEqual([{ type: 'runZone', id: 1, seconds: 90, source: 'siri-intent' }]);
  });

  it('returns not-applied when the controller acknowledges but does not run', async () => {
    const { commands, store, poller } = await setup({ dropCommands: true });
    await poller.pollNow();
    const r = await commands.runZone(0, 60, 'app');
    expect(r).toEqual({ ok: false, error: 'not-applied' });
    expect(store.get().zones[0]?.status).toBe('idle');
  });

  it('meets the 3 s deadline with a slow poll in flight', async () => {
    const { commands, store, poller } = await setup({ responseDelayMs: 2500 });
    store.patch({
      online: true,
      zones: Array.from({ length: 8 }, (_, id) => ({ id, name: `Z${id}`, status: 'idle' as const, remainingSec: null, lastRunAt: null })),
    });
    void poller.pollNow();
    await sleep(20);
    const t0 = Date.now();
    const r = await commands.runZone(0, 60, 'app');
    expect(Date.now() - t0).toBeLessThan(3100);
    expect(typeof r.ok).toBe('boolean');
  });

  it('confirmation read survives concurrent polls', async () => {
    const { commands, poller } = await setup({ responseDelayMs: 50 });
    await poller.pollNow();
    const p = commands.runZone(0, 60, 'app');
    await sleep(10);
    void poller.pollNow();
    void poller.pollNow();
    void poller.pollNow();
    const r = await p;
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.confirmedInMs).toBeGreaterThan(0);
  });
});
