import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlug } from '../../src/recovery/plug.js';

function stubFetch(): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    urls.push(String(url));
    return { ok: true } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

describe('smart plug drivers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shelly cycles off then on after offMs', async () => {
    const { fetchImpl, urls } = stubFetch();
    const plug = createPlug({ type: 'shelly', host: 'plug.local' }, fetchImpl);
    const p = plug!.powerCycle(30_000);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(urls).toEqual(['http://plug.local/relay/0?turn=off']);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(urls).toEqual([
      'http://plug.local/relay/0?turn=off',
      'http://plug.local/relay/0?turn=on',
    ]);
  });

  it('tasmota cycles off then on', async () => {
    const { fetchImpl, urls } = stubFetch();
    const plug = createPlug({ type: 'tasmota', host: '192.0.2.10' }, fetchImpl);
    const p = plug!.powerCycle(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(urls).toEqual([
      'http://192.0.2.10/cm?cmnd=Power%20Off',
      'http://192.0.2.10/cm?cmnd=Power%20On',
    ]);
  });

  it('returns null for none and homekit-automation', () => {
    expect(createPlug({ type: 'none' })).toBeNull();
    expect(createPlug({ type: 'homekit-automation' })).toBeNull();
  });

  it('rejects hosts with scheme, path, whitespace or credentials', () => {
    for (const host of ['http://plug.local', 'plug.local/x', 'plug local', 'u@plug.local', 'plug.local:8080', '']) {
      expect(() => createPlug({ type: 'shelly', host })).toThrow(/host/i);
    }
  });

  it('throws on a non-OK response', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500 }) as Response) as typeof fetch;
    const plug = createPlug({ type: 'shelly', host: 'plug.local' }, fetchImpl);
    await expect(plug!.powerCycle(0)).rejects.toThrow(/500/);
  });
});
