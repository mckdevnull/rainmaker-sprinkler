import type { PlatformAccessory } from 'homebridge';
import { autoOff, switchService, type Part, type PartContext } from './common.js';

export const PAIRING_SWITCH_NAME = 'Rainmaker Pairing';

/**
 * "Rainmaker Pairing": momentary. On issues a new pairing code for the app (the platform logs
 * every code the hub issues) and the switch turns itself off.
 */
export function pairingSwitch(ctx: PartContext, acc: PlatformAccessory): Part {
  const { hub, api } = ctx;
  const service = switchService(api, acc, PAIRING_SWITCH_NAME);
  service
    .getCharacteristic(api.hap.Characteristic.On)
    .onGet(() => false)
    .onSet((v) => {
      if (!v) return;
      hub.pairing.startPairing();
      autoOff(ctx, service);
    });
  return { update: () => undefined };
}
