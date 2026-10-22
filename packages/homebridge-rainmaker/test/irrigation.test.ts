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
});
