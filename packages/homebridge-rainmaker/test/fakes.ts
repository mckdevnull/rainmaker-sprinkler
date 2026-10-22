/**
 * A minimal hand-written stand-in for the parts of the Homebridge/HAP API the plugin uses.
 * Only enough behaviour to drive the platform's handlers; not a HAP implementation.
 */
import { EventEmitter } from 'node:events';
import { vi } from 'vitest';

type Value = boolean | number | string | null;
type Handler = (value: Value) => unknown;

const type = <T extends object>(UUID: string, consts?: T) => ({ UUID, ...consts }) as { UUID: string } & T;

export const Characteristic = {
  Active: type('Active', { INACTIVE: 0, ACTIVE: 1 }),
  InUse: type('InUse', { NOT_IN_USE: 0, IN_USE: 1 }),
  ProgramMode: type('ProgramMode', { NO_PROGRAM_SCHEDULED: 0, PROGRAM_SCHEDULED: 1, PROGRAM_SCHEDULED_MANUAL_MODE_: 2 }),
  ValveType: type('ValveType', { GENERIC_VALVE: 0, IRRIGATION: 1 }),
  IsConfigured: type('IsConfigured', { NOT_CONFIGURED: 0, CONFIGURED: 1 }),
  ContactSensorState: type('ContactSensorState', { CONTACT_DETECTED: 0, CONTACT_NOT_DETECTED: 1 }),
  SetDuration: type('SetDuration'),
  RemainingDuration: type('RemainingDuration'),
  On: type('On'),
  Name: type('Name'),
  ConfiguredName: type('ConfiguredName'),
  Manufacturer: type('Manufacturer'),
  Model: type('Model'),
  SerialNumber: type('SerialNumber'),
};
type CharType = { UUID: string };

export const Service = {
  AccessoryInformation: type('AccessoryInformation'),
  IrrigationSystem: type('IrrigationSystem'),
  Valve: type('Valve'),
  Switch: type('Switch'),
  ContactSensor: type('ContactSensor'),
};
type ServiceType = { UUID: string };

export const HAPStatus = { SERVICE_COMMUNICATION_FAILURE: -70402, INVALID_VALUE_IN_REQUEST: -70410 };
export class HapStatusError extends Error {
  constructor(public hapStatus: number) {
    super(`HAP status ${hapStatus}`);
  }
}

export class FakeCharacteristic {
  value: Value = null;
  props: Record<string, unknown> = {};
  private getHandler: (() => unknown) | null = null;
  private setHandler: Handler | null = null;
  constructor(readonly type: CharType) {}
  onGet(h: () => unknown) {
    this.getHandler = h;
    return this;
  }
  onSet(h: Handler) {
    this.setHandler = h;
    return this;
  }
  updateValue(v: Value) {
    this.value = v;
    return this;
  }
  setProps(p: Record<string, unknown>) {
    this.props = { ...this.props, ...p };
    return this;
  }
  /** A read from a HomeKit controller. */
  async get(): Promise<unknown> {
    return this.getHandler ? this.getHandler() : this.value;
  }
  /** A write from the Home app, which shows the new value at once whatever the handler says. */
  async set(v: Value): Promise<void> {
    this.value = v;
    await this.setHandler?.(v);
  }
}

export class FakeService {
  readonly characteristics = new Map<string, FakeCharacteristic>();
  readonly linked: FakeService[] = [];
  constructor(readonly type: ServiceType, readonly displayName: string, readonly subtype?: string) {}
  get UUID() {
    return this.type.UUID;
  }
  getCharacteristic(t: CharType) {
    let c = this.characteristics.get(t.UUID);
    if (!c) this.characteristics.set(t.UUID, (c = new FakeCharacteristic(t)));
    return c;
  }
  testCharacteristic(t: CharType) {
    return this.characteristics.has(t.UUID);
  }
  addOptionalCharacteristic(t: CharType) {
    this.getCharacteristic(t);
  }
  setCharacteristic(t: CharType, v: Value) {
    this.getCharacteristic(t).updateValue(v);
    return this;
  }
  updateCharacteristic(t: CharType, v: Value) {
    return this.setCharacteristic(t, v);
  }
  addLinkedService(s: FakeService) {
    if (!this.linked.includes(s)) this.linked.push(s);
  }
  removeLinkedService(s: FakeService) {
    const i = this.linked.indexOf(s);
    if (i >= 0) this.linked.splice(i, 1);
  }
  value(t: CharType): Value {
    return this.getCharacteristic(t).value;
  }
}

export class FakeAccessory {
  services: FakeService[] = [new FakeService(Service.AccessoryInformation, '')];
  context: Record<string, unknown> = {};
  constructor(readonly displayName: string, readonly UUID: string, readonly category?: number) {}
  getService(t: ServiceType | string) {
    return this.services.find((s) => (typeof t === 'string' ? s.displayName === t : s.type.UUID === t.UUID));
  }
  getServiceById(t: ServiceType, subtype: string) {
    return this.services.find((s) => s.type.UUID === t.UUID && s.subtype === subtype);
  }
  addService(t: ServiceType, name: string, subtype?: string) {
    const s = new FakeService(t, name, subtype);
    this.services = [...this.services, s];
    return s;
  }
  /** Like HAP, also unlinks the removed service. */
  removeService(s: FakeService) {
    this.services = this.services.filter((x) => x !== s);
    for (const x of this.services) x.removeLinkedService(s);
  }
}

export class FakeApi extends EventEmitter {
  registered: FakeAccessory[] = [];
  readonly hap = {
    uuid: { generate: (s: string) => `uuid:${s}` },
    Service,
    Characteristic,
    HAPStatus,
    HapStatusError,
    Categories: { SPRINKLER: 28, SWITCH: 8, SENSOR: 10 },
  };
  readonly platformAccessory = FakeAccessory;
  readonly user = { storagePath: () => '/nonexistent-homebridge-storage' };
  readonly registerPlatformAccessories = vi.fn((_p: string, _n: string, accs: FakeAccessory[]) => {
    this.registered = [...this.registered, ...accs];
  });
  readonly unregisterPlatformAccessories = vi.fn((_p: string, _n: string, accs: FakeAccessory[]) => {
    this.registered = this.registered.filter((a) => !accs.includes(a));
  });
  readonly updatePlatformAccessories = vi.fn();

  accessory(name: string): FakeAccessory {
    const found = this.registered.find((a) => a.displayName === name);
    if (!found) throw new Error(`no accessory named ${name}`);
    return found;
  }
}

export const fakeLog = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
  log: vi.fn(),
});
