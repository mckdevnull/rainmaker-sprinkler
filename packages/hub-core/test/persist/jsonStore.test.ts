import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonStore } from '../../src/persist/jsonStore.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rainmaker-store-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('JsonStore', () => {
  it('returns fallback when missing', async () => {
    expect(await new JsonStore(dir).get('nope', { a: 1 })).toEqual({ a: 1 });
  });

  it('round-trips', async () => {
    const store = new JsonStore(dir);
    await store.set('k', { until: 123, list: [1, 2] });
    expect(await store.get('k', null)).toEqual({ until: 123, list: [1, 2] });
    expect(await new JsonStore(dir).get('k', null)).toEqual({ until: 123, list: [1, 2] });
  });

  it('write is atomic', async () => {
    const store = new JsonStore(dir);
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.set('k', { n: i, pad: 'x'.repeat(5000) })));
    expect(await fs.readdir(dir)).toEqual(['k.json']);
    const parsed = JSON.parse(await fs.readFile(path.join(dir, 'k.json'), 'utf8')) as { n: number };
    expect(parsed.n).toBe(24);
  });

  it('returns fallback and warns on a corrupt file', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await fs.writeFile(path.join(dir, 'bad.json'), '{not json');
    expect(await new JsonStore(dir).get('bad', 7)).toBe(7);
    expect(warn).toHaveBeenCalled();
  });

  it('rejects keys that could escape the directory', async () => {
    await expect(new JsonStore(dir).set('../evil', 1)).rejects.toThrow();
  });
});
