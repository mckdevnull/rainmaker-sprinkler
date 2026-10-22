import type { PlatformAccessory } from 'homebridge';
import type { ControllerState } from '@rainmaker/hub-core';
import { INDEFINITE_PAUSE_MS } from '../constants.js';
import { autoOff, perform, revertSoon, switchService, whenOnline, type Part, type PartContext } from './common.js';

export const SYSTEM_SWITCH_NAME = 'Sprinkler System';
export const PAUSE_SWITCH_NAME = 'Sprinkler Pause';

/** "Sprinkler System": the controller's enable flag (off stops all scheduled watering). */
export function systemSwitch(ctx: PartContext, acc: PlatformAccessory): Part {
  const { hub, api } = ctx;
  const On = api.hap.Characteristic.On;
  const service = switchService(api, acc, SYSTEM_SWITCH_NAME);
  const current = () => hub.store.get().enabled;
  service
    .getCharacteristic(On)
    .onGet(whenOnline(ctx, current))
    .onSet((v) =>
      perform(
        ctx,
        v ? 'turn the sprinkler system on' : 'turn the sprinkler system off',
        () => hub.commands.setSystemEnabled(Boolean(v), 'homekit'),
        () => revertSoon(service, On, current),
      ),
    );
  return { update: (s: ControllerState) => service.updateCharacteristic(On, s.enabled) };
}

/** "Sprinkler Pause": on while any rain delay is set; on pauses until resumed, off resumes. */
export function pauseSwitch(ctx: PartContext, acc: PlatformAccessory): Part {
  const { hub, api } = ctx;
  const On = api.hap.Characteristic.On;
  const service = switchService(api, acc, PAUSE_SWITCH_NAME);
  const current = () => hub.store.get().rainDelayUntil !== null;
  service
    .getCharacteristic(On)
    .onGet(whenOnline(ctx, current))
    .onSet((v) =>
      perform(
        ctx,
        v ? 'pause the sprinklers' : 'resume the sprinklers',
        () => (v ? hub.pause.pauseAll(ctx.clock() + INDEFINITE_PAUSE_MS) : hub.pause.resumeAll()),
        () => revertSoon(service, On, current),
      ),
    );
  return { update: (s: ControllerState) => service.updateCharacteristic(On, s.rainDelayUntil !== null) };
}

/**
 * "Pause Sprinklers 1 Day" / "1 Week": momentary. On pauses for `durationMs` and the switch
 * turns itself off; turning it off does nothing ("Sprinkler Pause" off resumes).
 */
export function timedPauseSwitch(name: string, durationMs: number) {
  return (ctx: PartContext, acc: PlatformAccessory): Part => {
    const { hub, api } = ctx;
    const On = api.hap.Characteristic.On;
    const service = switchService(api, acc, name);
    service
      .getCharacteristic(On)
      .onGet(() => false)
      .onSet(async (v) => {
        if (!v) return;
        await perform(
          ctx,
          `pause the sprinklers (${name})`,
          () => hub.pause.pauseAll(ctx.clock() + durationMs),
          () => revertSoon(service, On, () => false),
        );
        autoOff(ctx, service);
      });
    return { update: () => undefined };
  };
}
