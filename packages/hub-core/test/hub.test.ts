import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '@rainmaker/controller-sim';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BonjourLike } from '../src/api/mdns.js';
import { validateConfig } from '../src/config.js';
import { createHub, type Hub } from '../src/hub.js';
import { eventually, lastHub, PASSWORD, silentLogger, startHub, stopHubs } from './api/helpers.js';

afterEach(stopHubs);

/** Records smart-plug calls; anything else (notifications) answers 200. */
function plugFetch(): { fetchImpl: typeof fetch; plugCalls: string[] } {
  const plugCalls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    if (String(url).includes('plug.test')) plugCalls.push(String(url));
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, plugCalls };
}
const PLUG = { plug: { type: 'shelly', host: 'plug.test' } };

describe('Hub lifecycle', () => {
  it('start twice does not duplicate pollers or servers', async () => {
    const publish = vi.fn();
    const fake: BonjourLike = { publish, unpublishAll: (cb) => cb?.(), destroy: (cb) => cb?.() };
    const t = await startHub({ deps: { mdns: true, mdnsFactory: () => fake } });
    const port = t.hub.apiPort();
    const onChange = t.hub.store.listenerCount('change');
    await t.hub.start();
    await Promise.all([t.hub.start(), t.hub.start()]);
    expect(t.hub.apiPort()).toBe(port);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(t.hub.store.listenerCount('change')).toBe(onChange);
    expect((await t.api('GET', '/v1/state')).status).toBe(200);
  });

  it('a failed start stops what it started', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '0.0.0.0', resolve));
    const port = (blocker.address() as { port: number }).port;
    try {
      await expect(startHub({ config: { apiPort: port } })).rejects.toThrow(/EADDRINUSE/);
      const store = lastHub()?.hub.store;
      expect(store?.listenerCount('change')).toBe(0);
      expect(store?.listenerCount('offline')).toBe(0);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe('Hub startup and the smart plug', () => {
  it('a first poll that fails once and then succeeds does not power-cycle', async () => {
    const sim = createSimulator({ password: PASSWORD, passwordMode: 'plain', responseDelayMs: 2 });
    const { baseUrl } = await sim.listen(0);
    sim.setOffline(true); // the first poll fails
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rainmaker-hub-'));
    const { fetchImpl, plugCalls } = plugFetch();
    const config = validateConfig({ controller: { baseUrl, password: PASSWORD }, dataDir: dir, apiPort: 0, ...PLUG });
    const hub: Hub = createHub(config, { logger: silentLogger(), mdns: false, fetchImpl });
    const cycles: unknown[] = [];
    hub.watchdog.on('power-cycle', (e: unknown) => cycles.push(e));
    try {
      await hub.start();
      expect(hub.store.get().online).toBeNull();
      sim.setOffline(false);
      expect(await eventually(() => hub.store.get().online === true, 8000)).toBe(true);
      expect(cycles).toEqual([]);
      expect(plugCalls).toEqual([]);
    } finally {
      await hub.stop();
      await sim.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it('a wrong controller password never power-cycles and leaves online unknown', async () => {
    const { fetchImpl, plugCalls } = plugFetch();
    const t = await startHub({ config: PLUG, deps: { fetchImpl }, sim: { password: 'not-the-hub-password' } });
    const cycles: unknown[] = [];
    t.hub.watchdog.on('power-cycle', (e: unknown) => cycles.push(e));
    await new Promise((r) => setTimeout(r, 300));
    expect(t.hub.store.get().unauthorized).toBe(true);
    expect(t.hub.store.get().online).toBeNull();
    expect(cycles).toEqual([]);
    expect(plugCalls).toEqual([]);
  });
});
