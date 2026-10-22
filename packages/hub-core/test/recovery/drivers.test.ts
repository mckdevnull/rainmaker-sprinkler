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
    expect(urls).toEqual(['http://plug.local/relay/0?turn=off&timer=30']);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(urls).toEqual([
      'http://plug.local/relay/0?turn=off&timer=30',
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
      'http://192.0.2.10/cm?cmnd=Backlog%20Power%20Off%3B%20Delay%2010%3B%20Power%20On',
      'http://192.0.2.10/cm?cmnd=Power%20On',
    ]);
  });

  it('the off request carries the device timer', async () => {
    const { fetchImpl, urls } = stubFetch();
    void createPlug({ type: 'shelly', host: 'plug.local' }, fetchImpl)!.powerCycle(45_000);
    void createPlug({ type: 'tasmota', host: 'plug.local' }, fetchImpl)!.powerCycle(45_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(urls).toEqual([
      'http://plug.local/relay/0?turn=off&timer=45',
      'http://plug.local/cm?cmnd=Backlog%20Power%20Off%3B%20Delay%20450%3B%20Power%20On',
    ]);
    expect(decodeURIComponent(urls[1] ?? '')).toContain('cmnd=Backlog Power Off; Delay 450; Power On');
    await vi.advanceTimersByTimeAsync(45_000);
  });

  it('a failed explicit "on" is ignored (the device timer covers it)', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return { ok: !String(url).includes('turn=on'), status: 500 } as Response;
    }) as typeof fetch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = createPlug({ type: 'shelly', host: 'plug.local' }, fetchImpl)!.powerCycle(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBeUndefined();
    expect(urls).toHaveLength(2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
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
