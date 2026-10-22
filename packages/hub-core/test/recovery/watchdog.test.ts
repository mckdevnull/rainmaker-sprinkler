import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SmartPlug } from '../../src/recovery/plug.js';
import { Watchdog } from '../../src/recovery/watchdog.js';
import { StateStore } from '../../src/state/store.js';

const MIN = 60_000;

class FakePlug implements SmartPlug {
  calls: number[] = [];
  fail = false;
  async powerCycle(offMs: number): Promise<void> {
    this.calls.push(offMs);
    if (this.fail) throw new Error('plug unreachable');
  }
}

let store: StateStore;
let plug: FakePlug;
let dog: Watchdog | undefined;
let events: Array<[string, unknown]>;

function make(p: SmartPlug | null = plug, opts = {}): Watchdog {
  const w = new Watchdog(store, p, opts, () => Date.now());
  for (const e of ['power-cycle', 'recovery-exhausted', 'recovered'])
    w.on(e, (x: unknown) => events.push([e, x]));
  w.start();
  dog = w;
  return w;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  store = new StateStore();
  store.patch({ online: true });
  plug = new FakePlug();
  events = [];
});
afterEach(() => {
  dog?.stop();
  dog = undefined;
  vi.useRealTimers();
});

describe('Watchdog', () => {
  it('cycles once when store goes offline', async () => {
    make();
    store.patch({ online: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(plug.calls).toEqual([30_000]);
    expect(events.filter(([e]) => e === 'power-cycle')).toHaveLength(1);
    expect(events[0]?.[1]).toMatchObject({ count: 1 });
  });

  it('acts on start() when the controller is already offline', async () => {
    store.patch({ online: false });
    make();
    await vi.advanceTimersByTimeAsync(0);
    expect(plug.calls).toHaveLength(1);
  });

  it('does not cycle again within 10 minutes', async () => {
    make();
    store.patch({ online: false });
    await vi.advanceTimersByTimeAsync(9 * MIN);
    expect(plug.calls).toHaveLength(1);
    store.patch({ online: true });
    store.patch({ online: false }); // flap inside the gap
    await vi.advanceTimersByTimeAsync(0);
    expect(plug.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(MIN); // gap elapses, still offline
    expect(plug.calls).toHaveLength(2);
  });

  it('stops after 3 cycles in an hour and emits recovery-exhausted once', async () => {
    make();
    store.patch({ online: false });
    await vi.advanceTimersByTimeAsync(55 * MIN);
    expect(plug.calls).toHaveLength(3);
    const exhausted = () => events.filter(([e]) => e === 'recovery-exhausted').length;
    expect(exhausted()).toBe(1);
    await vi.advanceTimersByTimeAsync(3 * 60 * MIN);
    expect(plug.calls).toHaveLength(3);
    expect(exhausted()).toBe(1);
  });

  it('emits recovered when store comes back online', async () => {
    make();
    store.patch({ online: false });
    await vi.advanceTimersByTimeAsync(0);
    store.patch({ online: true });
    expect(events.at(-1)).toEqual(['recovered', { afterCycles: 1 }]);
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(plug.calls).toHaveLength(1); // timer cancelled
  });

  it('re-emits recovery-exhausted after exhausted, recovered, offline again', async () => {
    make();
    store.patch({ online: false });
    await vi.advanceTimersByTimeAsync(35 * MIN);
    const exhausted = () => events.filter(([e]) => e === 'recovery-exhausted').length;
    expect(exhausted()).toBe(1);
    store.patch({ online: true });
    expect(events.at(-1)).toEqual(['recovered', { afterCycles: 3 }]);
    store.patch({ online: false }); // still 3 cycles in the trailing hour
    await vi.advanceTimersByTimeAsync(0);
    expect(plug.calls).toHaveLength(3);
    expect(exhausted()).toBe(2);
  });

  it('counts a failing plug as an attempt and keeps going', async () => {
    plug.fail = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    make();
    store.patch({ online: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(plug.calls).toHaveLength(1);
    expect(err).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(plug.calls).toHaveLength(2);
    err.mockRestore();
  });

  it('does nothing when plug is null', async () => {
    make(null);
    store.patch({ online: false });
    await vi.advanceTimersByTimeAsync(2 * 60 * MIN);
    expect(events).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('emits nothing for a null plug across offline then online', async () => {
    make(null);
    store.patch({ online: false });
    store.patch({ online: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([]);
    expect(store.listenerCount('offline')).toBe(0);
  });

  it('stop() removes listeners and timers', async () => {
    const w = make();
    store.patch({ online: false });
    await vi.advanceTimersByTimeAsync(0);
    w.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(plug.calls).toHaveLength(1);
    expect(store.listenerCount('offline')).toBe(0);
  });
});
