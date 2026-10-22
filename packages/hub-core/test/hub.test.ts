import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BonjourLike } from '../src/api/mdns.js';
import { lastHub, startHub, stopHubs } from './api/helpers.js';

afterEach(stopHubs);

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
