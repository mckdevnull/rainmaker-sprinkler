import { afterEach, describe, expect, it, vi } from 'vitest';
import { Characteristic as C, HapStatusError, Service as S, type FakeAccessory } from './fakes.js';
import { cleanup, launch, nextTick, shutdown } from './harness.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

const valves = (acc: FakeAccessory) => acc.services.filter((s) => s.type === S.Valve);
const valve = (acc: FakeAccessory, id: number) => {
  const v = acc.getServiceById(S.Valve, `zone-${id}`);
  if (!v) throw new Error(`no valve for zone ${id}`);
  return v;
};

describe('Sprinklers irrigation system', () => {
  it('creates one valve per zone with the zone name', async () => {
    const r = await launch({ sim: { nStations: 4 } });
    const acc = r.api.accessory('Sprinklers');
    const system = acc.getService(S.IrrigationSystem);
    expect(system).toBeDefined();
    expect(valves(acc)).toHaveLength(4);
    expect(system?.linked).toHaveLength(4);
    const first = valve(acc, 0);
    expect(first.value(C.Name)).toBe('S01');
    expect(first.value(C.ConfiguredName)).toBe('S01');
    expect(first.value(C.ValveType)).toBe(C.ValveType.IRRIGATION);
    expect(first.value(C.IsConfigured)).toBe(C.IsConfigured.CONFIGURED);
    expect(first.value(C.SetDuration)).toBe(600);
    expect(valve(acc, 3).value(C.Name)).toBe('S04');
  });

  it('removes valves for zones that disappear', async () => {
    const first = await launch({ sim: { nStations: 6 } });
    const cached = first.api.registered;
    await shutdown(first);
    const stale = new (first.api.platformAccessory)('Old Thing', 'uuid:rainmaker:retired');

    const r = await launch({ dir: first.dir, cached: [...cached, stale], sim: { nStations: 4 } });
    const acc = r.api.accessory('Sprinklers');
    expect(acc).toBe(cached.find((a) => a.displayName === 'Sprinklers'));
    expect(valves(acc).map((v) => v.subtype)).toEqual(['zone-0', 'zone-1', 'zone-2', 'zone-3']);
    expect(acc.getService(S.IrrigationSystem)?.linked.map((v) => v.subtype)).toEqual([
      'zone-0',
      'zone-1',
      'zone-2',
      'zone-3',
    ]);
    expect(r.api.updatePlatformAccessories).toHaveBeenCalledWith([acc]);
    expect(r.api.registerPlatformAccessories).not.toHaveBeenCalled();
    expect(r.api.unregisterPlatformAccessories).toHaveBeenCalledWith('homebridge-rainmaker', 'Rainmaker', [stale]);
  });

  it('setting Active runs the zone with the configured duration and source homekit', async () => {
    const r = await launch({ config: { zoneDefaults: [{ zone: 2, voiceSeconds: 300 }] } });
    const hub = r.platform.hub!;
    const runZone = vi.spyOn(hub.commands, 'runZone');
    const v = valve(r.api.accessory('Sprinklers'), 2);
    expect(v.value(C.SetDuration)).toBe(300);
    await v.getCharacteristic(C.Active).set(C.Active.ACTIVE);
    expect(runZone).toHaveBeenCalledWith(2, 300, 'homekit');
    expect(hub.store.get().zones[2]?.status).toBe('running');
    expect(v.value(C.InUse)).toBe(C.InUse.IN_USE);
  });

  it('RemainingDuration follows store changes', async () => {
    const r = await launch();
    const hub = r.platform.hub!;
    const v = valve(r.api.accessory('Sprinklers'), 1);
    expect(v.value(C.RemainingDuration)).toBe(0);
    const zones = hub.store.get().zones.map((z) => (z.id === 1 ? { ...z, status: 'running' as const, remainingSec: 240 } : z));
    hub.store.patch({ zones });
    expect(v.value(C.RemainingDuration)).toBe(240);
    expect(v.value(C.Active)).toBe(C.Active.ACTIVE);
    expect(r.api.accessory('Sprinklers').getService(S.IrrigationSystem)?.value(C.Active)).toBe(C.Active.ACTIVE);
  });

  it('changing SetDuration in Home persists and survives a platform restart', async () => {
    const first = await launch();
    await valve(first.api.accessory('Sprinklers'), 0).getCharacteristic(C.SetDuration).set(420);
    expect(first.platform.hub!.settings.voiceSeconds(0)).toBe(420);
    const cached = first.api.registered;
    await shutdown(first);

    const r = await launch({ dir: first.dir, cached });
    expect(valve(r.api.accessory('Sprinklers'), 0).value(C.SetDuration)).toBe(420);
    expect(r.platform.hub!.settings.voiceSeconds(0)).toBe(420);
  });

  it('a failed command throws HapStatusError and reverts Active', async () => {
    const r = await launch();
    const hub = r.platform.hub!;
    vi.spyOn(hub.commands, 'runZone').mockResolvedValue({ ok: false, error: 'offline' });
    const active = valve(r.api.accessory('Sprinklers'), 0).getCharacteristic(C.Active);
    const err = await active.set(C.Active.ACTIVE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HapStatusError);
    expect((err as HapStatusError).hapStatus).toBe(-70402);
    await nextTick();
    expect(active.value).toBe(C.Active.INACTIVE);
    expect(r.log.error).toHaveBeenCalledWith(expect.stringContaining('offline'));
  });

  it('a write on a cached valve during startup rejects instead of being accepted', async () => {
    const first = await launch({ sim: { nStations: 2 } });
    const cached = first.api.registered;
    await shutdown(first);

    const errors: unknown[] = [];
    const attempt = async (r: { api: { accessory(n: string): FakeAccessory } }) => {
      const active = valve(r.api.accessory('Sprinklers'), 0).getCharacteristic(C.Active);
      errors.push(await active.set(C.Active.ACTIVE).catch((e: unknown) => e));
      errors.push(await active.get().catch((e: unknown) => e));
    };
    const r = await launch({
      dir: first.dir,
      cached,
      sim: { nStations: 2 },
      duringStartup: async (running, start) => {
        await attempt(running); // restored, before didFinishLaunching
        start();
        await attempt(running); // hub.start() still in flight
      },
    });
    expect(errors).toHaveLength(4);
    for (const e of errors) expect((e as HapStatusError).hapStatus).toBe(-70402);
    expect(r.sim.state.stations[0]?.running).toBe(false);
    // Once started, the live handlers answer.
    expect(await valve(r.api.accessory('Sprinklers'), 0).getCharacteristic(C.Active).get()).toBe(C.Active.INACTIVE);
  });

  it('turning on the Sprinklers system runs all zones in order', async () => {
    const r = await launch({ sim: { nStations: 3 }, config: { zoneDefaults: [{ zone: 1, voiceSeconds: 120 }] } });
    const runZone = vi.spyOn(r.platform.hub!.commands, 'runZone');
    const system = r.api.accessory('Sprinklers').getService(S.IrrigationSystem)!;
    await system.getCharacteristic(C.Active).set(C.Active.ACTIVE);
    expect(runZone.mock.calls).toEqual([
      [0, 600, 'homekit'],
      [1, 120, 'homekit'],
      [2, 600, 'homekit'],
    ]);
    expect(system.value(C.Active)).toBe(C.Active.ACTIVE);
  });

  it('system Active with a concurrent valve write runs only that zone', async () => {
    const r = await launch({ sim: { nStations: 3 } });
    const hub = r.platform.hub!;
    const runZone = vi.spyOn(hub.commands, 'runZone');
    const acc = r.api.accessory('Sprinklers');
    const system = acc.getService(S.IrrigationSystem)!;
    // The Home app sends the system write first, then the valve write, in the same tap.
    const systemWrite = system.getCharacteristic(C.Active).set(C.Active.ACTIVE);
    const valveWrite = valve(acc, 1).getCharacteristic(C.Active).set(C.Active.ACTIVE);
    await Promise.all([systemWrite, valveWrite]);
    expect(runZone.mock.calls).toEqual([[1, 600, 'homekit']]);
    expect(r.sim.state.stations.map((s) => s.running)).toEqual([false, true, false]);
  });

  it('partial failure of run-all stops everything', async () => {
    const r = await launch({ sim: { nStations: 3 } });
    const hub = r.platform.hub!;
    const real = hub.commands.runZone.bind(hub.commands);
    vi.spyOn(hub.commands, 'runZone').mockImplementation((id, seconds, source) =>
      id === 1 ? Promise.resolve({ ok: false, error: 'timeout' }) : real(id, seconds, source),
    );
    const stopAll = vi.spyOn(hub.commands, 'stopAll');
    const system = r.api.accessory('Sprinklers').getService(S.IrrigationSystem)!;
    const err = await system.getCharacteristic(C.Active).set(C.Active.ACTIVE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HapStatusError);
    expect(stopAll).toHaveBeenCalledWith('homekit');
    expect(r.sim.state.stations.every((s) => !s.running)).toBe(true);
    expect(hub.store.get().zones.every((z) => z.status === 'idle')).toBe(true);
  });

  it('a first-zone failure of run-all does not send a stop', async () => {
    const r = await launch({ sim: { nStations: 2 } });
    const hub = r.platform.hub!;
    vi.spyOn(hub.commands, 'runZone').mockResolvedValue({ ok: false, error: 'offline' });
    const stopAll = vi.spyOn(hub.commands, 'stopAll');
    const system = r.api.accessory('Sprinklers').getService(S.IrrigationSystem)!;
    await expect(system.getCharacteristic(C.Active).set(C.Active.ACTIVE)).rejects.toBeInstanceOf(HapStatusError);
    expect(stopAll).not.toHaveBeenCalled();
  });

  it('turning off the Sprinklers system stops all', async () => {
    const r = await launch();
    const hub = r.platform.hub!;
    const stopAll = vi.spyOn(hub.commands, 'stopAll');
    await valve(r.api.accessory('Sprinklers'), 0).getCharacteristic(C.Active).set(C.Active.ACTIVE);
    const system = r.api.accessory('Sprinklers').getService(S.IrrigationSystem)!;
    await system.getCharacteristic(C.Active).set(C.Active.INACTIVE);
    expect(stopAll).toHaveBeenCalledWith('homekit');
    expect(hub.store.get().zones.every((z) => z.status === 'idle')).toBe(true);
    expect(system.value(C.Active)).toBe(C.Active.INACTIVE);
  });
});
