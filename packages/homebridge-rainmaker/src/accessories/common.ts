import type {
  API,
  Characteristic,
  CharacteristicValue,
  HAPStatus,
  Logging,
  PlatformAccessory,
  Service,
  WithUUID,
} from 'homebridge';
import type { CommandResult, ControllerState, Hub } from '@rainmaker/hub-core';
import { MOMENTARY_MS } from '../constants.js';

/** What every accessory needs from the platform. */
export interface PartContext {
  readonly api: API;
  readonly log: Logging;
  readonly hub: Hub;
  /** UTC ms (the hub's clock). */
  readonly clock: () => number;
  /** Pending auto-off timers, cleared on shutdown. */
  readonly timers: Set<NodeJS.Timeout>;
  /** Tells Homebridge an accessory's services changed (no-op until it is registered). */
  save(acc: PlatformAccessory): void;
}

/** One published accessory, kept in step with the hub's state. */
export interface Part {
  update(state: ControllerState): void;
}

export type CharacteristicType = WithUUID<new () => Characteristic>;

export function hapError(api: API, status?: HAPStatus): Error {
  return new api.hap.HapStatusError(status ?? api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
}

/**
 * HAP keeps the old value when a write throws, but the Home app (and Alexa) already show the
 * new one; push the store's value back once the failed write has been answered.
 */
export function revertSoon(service: Service, type: CharacteristicType, current: () => CharacteristicValue): void {
  setImmediate(() => service.updateCharacteristic(type, current()));
}

/**
 * Runs a hub command for a characteristic write. A failure is logged, the characteristic is
 * reverted and a HapStatusError is thrown, so Siri says it failed and Alexa that the device
 * is not responding. Never resolves for a command that did not happen.
 */
export async function perform(
  ctx: PartContext,
  what: string,
  run: () => Promise<CommandResult>,
  revert: () => void,
): Promise<void> {
  let result: CommandResult;
  try {
    result = await run();
  } catch (err) {
    ctx.log.error(`Rainmaker: could not ${what}:`, err);
    revert();
    throw hapError(ctx.api);
  }
  if (result.ok) {
    ctx.log.debug(`Rainmaker: ${what} (confirmed in ${result.confirmedInMs} ms)`);
    return;
  }
  ctx.log.error(`Rainmaker: could not ${what} (${result.error})`);
  revert();
  throw hapError(ctx.api);
}

/** A read handler that answers "No Response" while the controller is offline, never a stale value. */
export function whenOnline<T extends CharacteristicValue>(ctx: PartContext, value: () => T): () => T {
  return () => {
    if (!ctx.hub.store.get().online) throw hapError(ctx.api);
    return value();
  };
}

/** Turns a momentary switch back off after MOMENTARY_MS. */
export function autoOff(ctx: PartContext, service: Service): void {
  const timer = setTimeout(() => {
    ctx.timers.delete(timer);
    service.updateCharacteristic(ctx.api.hap.Characteristic.On, false);
  }, MOMENTARY_MS);
  ctx.timers.add(timer);
}

export function setInfo(api: API, acc: PlatformAccessory, model: string): void {
  const { Characteristic: C, Service: S } = api.hap;
  acc
    .getService(S.AccessoryInformation)
    ?.setCharacteristic(C.Manufacturer, 'Rainmaker')
    .setCharacteristic(C.Model, model)
    .setCharacteristic(C.SerialNumber, acc.UUID);
}

/** The accessory's single Switch service, added if it is new. */
export function switchService(api: API, acc: PlatformAccessory, name: string): Service {
  const S = api.hap.Service;
  return acc.getService(S.Switch) ?? acc.addService(S.Switch, name);
}

/**
 * Bound to every restored accessory until the hub has started (and for good if it cannot):
 * every control answers with an error instead of quietly accepting writes that nothing would
 * carry out. The live handlers replace these once the hub is up.
 */
export function bindUnavailable(api: API, acc: PlatformAccessory): void {
  const C = api.hap.Characteristic;
  // Concrete characteristic classes satisfy both the getCharacteristic and testCharacteristic signatures.
  const types: (CharacteristicType & WithUUID<typeof Characteristic>)[] = [
    C.Active,
    C.InUse,
    C.ProgramMode,
    C.On,
    C.SetDuration,
    C.RemainingDuration,
    C.ContactSensorState,
  ];
  const fail = (): never => {
    throw hapError(api);
  };
  for (const service of acc.services) {
    for (const type of types) {
      if (service.testCharacteristic(type)) service.getCharacteristic(type).onGet(fail).onSet(fail);
    }
  }
}
