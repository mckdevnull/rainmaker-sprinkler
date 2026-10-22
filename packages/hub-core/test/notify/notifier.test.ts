import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Notifier } from '../../src/notify/notifier.js';
import { JsonStore } from '../../src/persist/jsonStore.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rainmaker-notify-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const silent = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('Notifier', () => {
  it('posts the text to ntfy when a topic is set', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const logger = silent();
    const n = new Notifier({ offline: true, ntfyTopic: 'my-garden' }, new JsonStore(dir), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger,
    });
    await n.notify('offline', 'Controller is offline');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ntfy.sh/my-garden');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('Controller is offline');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('never throws when ntfy fails, and logs instead', async () => {
    const logger = silent();
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const n = new Notifier({ offline: true, ntfyTopic: 'my-garden' }, new JsonStore(dir), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger,
    });
    await expect(n.notify('online', 'back')).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
    const bad = new Notifier({ offline: true, ntfyTopic: 'my-garden' }, new JsonStore(dir), {
      fetchImpl: (async () => new Response('', { status: 500 })) as unknown as typeof fetch,
      logger,
    });
    await expect(bad.notify('online', 'back')).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it('logs when no channel is configured', async () => {
    const logger = silent();
    const fetchImpl = vi.fn();
    const n = new Notifier({ offline: true }, new JsonStore(dir), { fetchImpl: fetchImpl as unknown as typeof fetch, logger });
    await n.notify('recovery-exhausted', 'Gave up power-cycling');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Gave up power-cycling'));
  });

  it('persists push tokens per device', async () => {
    const n = new Notifier({ offline: true }, new JsonStore(dir), { logger: silent() });
    await n.registerPush('device-a', 'ab'.repeat(32));
    await n.registerPush('device-b', 'cd'.repeat(32));
    await n.unregisterPush('device-a');
    expect(await new JsonStore(dir).get('pushTokens', {})).toEqual({ 'device-b': 'cd'.repeat(32) });
  });
});
