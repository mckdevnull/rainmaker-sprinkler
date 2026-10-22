import type { PlatformAccessory } from 'homebridge';
import type { ControllerState } from '@rainmaker/hub-core';
import type { Part, PartContext } from './common.js';

export const ONLINE_SENSOR_NAME = 'Sprinkler Controller Online';

/**
 * "Sprinkler Controller Online": contact detected while the controller answers. A HomeKit
 * automation can power-cycle the controller's plug when it opens (plug type homekit-automation).
 */
export function onlineSensor(ctx: PartContext, acc: PlatformAccessory): Part {
  const { Service: S, Characteristic: C } = ctx.api.hap;
  const service = acc.getService(S.ContactSensor) ?? acc.addService(S.ContactSensor, ONLINE_SENSOR_NAME);
  const value = (online: boolean) =>
    online ? C.ContactSensorState.CONTACT_DETECTED : C.ContactSensorState.CONTACT_NOT_DETECTED;
  service.getCharacteristic(C.ContactSensorState).onGet(() => value(ctx.hub.store.get().online));
  return { update: (s: ControllerState) => service.updateCharacteristic(C.ContactSensorState, value(s.online)) };
}
