import { afterEach, describe, expect, it, vi } from 'vitest';
import { Characteristic as C, Service as S } from './fakes.js';
import { cleanup, launch, NOW } from './harness.js';

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await cleanup();
});

const HOUR = 3600e3;

describe('switches and sensors', () => {
  it('Sprinkler Pause reflects rainDelayUntil', async () => {
    const r = await launch();
    const on = r.api.accessory('Sprinkler Pause').getService(S.Switch)!.getCharacteristic(C.On);
    expect(on.value).toBe(false);
    r.platform.hub!.store.patch({ rainDelayUntil: NOW + 5 * HOUR });
    expect(on.value).toBe(true);
    expect(await on.get()).toBe(true);
    r.platform.hub!.store.patch({ rainDelayUntil: null });
    expect(on.value).toBe(false);
  });

  it('Pause 1 Week calls pauseAll with 168 h and turns itself off', async () => {
    const r = await launch();
    const pauseAll = vi.spyOn(r.platform.hub!.pause, 'pauseAll').mockResolvedValue({ ok: true, confirmedInMs: 5 });
    const on = r.api.accessory('Pause Sprinklers 1 Week').getService(S.Switch)!.getCharacteristic(C.On);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await on.set(true);
    expect(pauseAll).toHaveBeenCalledWith(NOW + 168 * HOUR);
    expect(on.value).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(on.value).toBe(false);
    expect(r.api.accessory('Pause Sprinklers 1 Day')).toBeDefined();
  });

  it('online sensor follows store online', async () => {
    const r = await launch();
    const state = r.api
      .accessory('Sprinkler Controller Online')
      .getService(S.ContactSensor)!
      .getCharacteristic(C.ContactSensorState);
    expect(state.value).toBe(C.ContactSensorState.CONTACT_DETECTED);
    r.platform.hub!.store.patch({ online: false });
    expect(state.value).toBe(C.ContactSensorState.CONTACT_NOT_DETECTED);
    expect(await state.get()).toBe(C.ContactSensorState.CONTACT_NOT_DETECTED);
    r.platform.hub!.store.patch({ online: true });
    expect(state.value).toBe(C.ContactSensorState.CONTACT_DETECTED);
  });

  it('online sensor reports detected while online is unknown (null)', async () => {
    const r = await launch();
    const state = r.api
      .accessory('Sprinkler Controller Online')
      .getService(S.ContactSensor)!
      .getCharacteristic(C.ContactSensorState);
    r.platform.hub!.store.patch({ online: null });
    expect(await state.get()).toBe(C.ContactSensorState.CONTACT_DETECTED);
    expect(state.value).toBe(C.ContactSensorState.CONTACT_DETECTED);
  });

  it('Pairing switch issues a code', async () => {
    const r = await launch();
    const startPairing = vi.spyOn(r.platform.hub!.pairing, 'startPairing');
    const on = r.api.accessory('Rainmaker Pairing').getService(S.Switch)!.getCharacteristic(C.On);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await on.set(true);
    expect(startPairing).toHaveBeenCalledTimes(1);
    const code = startPairing.mock.results[0]?.value.code as string;
    expect(code).toMatch(/^\d{6}$/);
    expect(r.log.info).toHaveBeenCalledWith(expect.stringContaining(code));
    await vi.advanceTimersByTimeAsync(1000);
    expect(on.value).toBe(false);
  });
});
