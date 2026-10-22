import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { parseVoiceSeconds, type CommandResult, type ControllerState, type Zone } from '@rainmaker/hub-core';
import { MAX_DURATION_SECONDS, SYSTEM_ACTIVE_GRACE_MS } from '../constants.js';
import { hapError, perform, revertSoon, whenOnline, type Part, type PartContext } from './common.js';

export const IRRIGATION_NAME = 'Sprinklers';
const SUBTYPE_PREFIX = 'zone-';
const isActive = (z: Zone | undefined) => z?.status === 'running' || z?.status === 'queued';

/**
 * "Sprinklers": an IrrigationSystem with one linked Valve per zone (subtype `zone-<id>`).
 * The zone names last applied are kept in `context.zoneNames`, so a rename in the Home app
 * survives restarts until the controller's own name changes.
 */
export class IrrigationAccessory implements Part {
  private readonly system: Service;
  private readonly valves = new Map<number, Service>();

  constructor(
    private readonly ctx: PartContext,
    private readonly acc: PlatformAccessory,
  ) {
    const { Service: S, Characteristic: C } = ctx.api.hap;
    this.system = acc.getService(S.IrrigationSystem) ?? acc.addService(S.IrrigationSystem, IRRIGATION_NAME);
    this.system
      .getCharacteristic(C.Active)
      .onGet(whenOnline(ctx, () => this.systemActive()))
      .onSet((v) => this.setSystemActive(v));
    this.system.getCharacteristic(C.InUse).onGet(whenOnline(ctx, () => this.systemInUse()));
    this.system.getCharacteristic(C.ProgramMode).onGet(whenOnline(ctx, () => this.programMode()));
    for (const service of acc.services) {
      const id = service.UUID === S.Valve.UUID ? zoneIdOf(service.subtype) : null;
      if (id !== null) this.bindValve(id, service);
    }
  }

  update(state: ControllerState): void {
    const { Characteristic: C } = this.ctx.api.hap;
    this.syncValves(state.zones);
    this.system.updateCharacteristic(C.Active, this.systemActive());
    this.system.updateCharacteristic(C.InUse, this.systemInUse());
    this.system.updateCharacteristic(C.ProgramMode, this.programMode());
    for (const [id, valve] of this.valves) {
      valve.updateCharacteristic(C.Active, this.zoneActive(id));
      valve.updateCharacteristic(C.InUse, this.zoneInUse(id));
      valve.updateCharacteristic(C.RemainingDuration, this.zone(id)?.remainingSec ?? 0);
      valve.updateCharacteristic(C.SetDuration, this.ctx.hub.settings.voiceSeconds(id));
    }
  }

  // ---- valves --------------------------------------------------------------------------

  /** Adds valves for new zones, renames, and removes valves whose zone is gone. */
  private syncValves(zones: readonly Zone[]): void {
    // No zones means the controller has not answered yet; keep the valves the owner arranged.
    if (zones.length === 0) return;
    const { Service: S, Characteristic: C } = this.ctx.api.hap;
    const names = { ...((this.acc.context.zoneNames ?? {}) as Record<string, string>) };
    let changed = false;
    for (const zone of zones) {
      if (!this.valves.has(zone.id)) {
        const subtype = `${SUBTYPE_PREFIX}${zone.id}`;
        const valve = this.acc.addService(S.Valve, zone.name, subtype);
        valve.setCharacteristic(C.ValveType, C.ValveType.IRRIGATION);
        valve.setCharacteristic(C.IsConfigured, C.IsConfigured.CONFIGURED);
        this.system.addLinkedService(valve);
        this.bindValve(zone.id, valve);
        changed = true;
      }
      if (names[zone.id] !== zone.name) {
        const valve = this.valves.get(zone.id);
        valve?.updateCharacteristic(C.Name, zone.name);
        valve?.updateCharacteristic(C.ConfiguredName, zone.name);
        names[zone.id] = zone.name;
        changed = true;
      }
    }
    const ids = new Set(zones.map((z) => z.id));
    for (const [id, valve] of [...this.valves]) {
      if (ids.has(id)) continue;
      this.acc.removeService(valve);
      this.valves.delete(id);
      delete names[id];
      this.ctx.log.info(`Rainmaker: removed the valve for zone ${id}, which the controller no longer has`);
      changed = true;
    }
    if (!changed) return;
    this.acc.context = { ...this.acc.context, zoneNames: names };
    this.ctx.save(this.acc);
  }

  private bindValve(id: number, valve: Service): void {
    const { Characteristic: C } = this.ctx.api.hap;
    if (!valve.testCharacteristic(C.ConfiguredName)) valve.addOptionalCharacteristic(C.ConfiguredName);
    valve
      .getCharacteristic(C.Active)
      .onGet(whenOnline(this.ctx, () => this.zoneActive(id)))
      .onSet((v) => this.setZoneActive(id, valve, v));
    valve.getCharacteristic(C.InUse).onGet(whenOnline(this.ctx, () => this.zoneInUse(id)));
    valve
      .getCharacteristic(C.RemainingDuration)
      .setProps({ maxValue: MAX_DURATION_SECONDS })
      .onGet(whenOnline(this.ctx, () => this.zone(id)?.remainingSec ?? 0));
    valve
      .getCharacteristic(C.SetDuration)
      .setProps({ maxValue: MAX_DURATION_SECONDS })
      .onGet(() => this.ctx.hub.settings.voiceSeconds(id))
      .onSet((v) => this.setDuration(id, valve, v));
    this.valves.set(id, valve);
  }

  private async setZoneActive(id: number, valve: Service, value: CharacteristicValue): Promise<void> {
    const { hub } = this.ctx;
    const C = this.ctx.api.hap.Characteristic;
    const start = value === C.Active.ACTIVE;
    const label = this.zone(id)?.name ?? `zone ${id}`;
    await perform(
      this.ctx,
      start ? `start ${label}` : `stop ${label}`,
      () => (start ? hub.commands.runZone(id, hub.settings.voiceSeconds(id), 'homekit') : hub.commands.stopZone(id, 'homekit')),
      () => revertSoon(valve, C.Active, () => this.zoneActive(id)),
    );
  }

  /** Home's duration picker sets the zone's voice duration (persisted in the hub's settings). */
  private async setDuration(id: number, valve: Service, value: CharacteristicValue): Promise<void> {
    const { hub, api, log } = this.ctx;
    const revert = () => revertSoon(valve, api.hap.Characteristic.SetDuration, () => hub.settings.voiceSeconds(id));
    let seconds: number;
    try {
      seconds = parseVoiceSeconds(value, 'SetDuration');
    } catch {
      revert();
      throw hapError(api, api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
    const zones = hub.settings.get().zones;
    try {
      await hub.settings.update({ zones: { ...zones, [id]: { ...zones[id], voiceSeconds: seconds } } });
    } catch (err) {
      log.error(`Rainmaker: could not save the duration for zone ${id}:`, err);
      revert();
      throw hapError(api);
    }
  }

  // ---- system --------------------------------------------------------------------------

  /** On (while idle) runs every zone in controller order for its voice duration; off stops all. */
  private async setSystemActive(value: CharacteristicValue): Promise<void> {
    const { hub, api } = this.ctx;
    const C = api.hap.Characteristic;
    const revert = () => revertSoon(this.system, C.Active, () => this.systemActive());
    if (value !== C.Active.ACTIVE) {
      await perform(this.ctx, 'stop all zones', () => hub.commands.stopAll('homekit'), revert);
      return;
    }
    if (this.systemActive() === C.Active.ACTIVE) return;
    // The Home app may write Active=1 here when one valve is tapped; that valve's write then starts a zone.
    await new Promise((resolve) => setTimeout(resolve, SYSTEM_ACTIVE_GRACE_MS));
    if (this.systemActive() === C.Active.ACTIVE) return;
    await perform(this.ctx, 'run all zones', () => this.runAllZones(), revert);
  }

  /**
   * One runZone per zone, in order (the firmware queues them). At the first failure, zones already
   * started are stopped again, so a failed "run all" never leaves part of the garden watering.
   */
  private async runAllZones(): Promise<CommandResult> {
    const { hub } = this.ctx;
    const zones = hub.store.get().zones;
    if (zones.length === 0) return { ok: false, error: 'offline' };
    let total = 0;
    for (const zone of zones) {
      const result = await hub.commands.runZone(zone.id, hub.settings.voiceSeconds(zone.id), 'homekit');
      if (!result.ok) {
        if (zone !== zones[0]) await this.stopAfterPartialRun();
        return result;
      }
      total += result.confirmedInMs;
    }
    return { ok: true, confirmedInMs: total };
  }

  private async stopAfterPartialRun(): Promise<void> {
    const stopped = await this.ctx.hub.commands.stopAll('homekit');
    if (!stopped.ok) this.ctx.log.error(`Rainmaker: could not stop zones after a failed run all (${stopped.error})`);
  }

  private zone(id: number): Zone | undefined {
    return this.ctx.hub.store.get().zones.find((z) => z.id === id);
  }

  private zoneActive(id: number): number {
    const C = this.ctx.api.hap.Characteristic;
    return isActive(this.zone(id)) ? C.Active.ACTIVE : C.Active.INACTIVE;
  }

  private zoneInUse(id: number): number {
    const C = this.ctx.api.hap.Characteristic;
    return this.zone(id)?.status === 'running' ? C.InUse.IN_USE : C.InUse.NOT_IN_USE;
  }

  private systemActive(): number {
    const C = this.ctx.api.hap.Characteristic;
    return this.ctx.hub.store.get().zones.some(isActive) ? C.Active.ACTIVE : C.Active.INACTIVE;
  }

  private systemInUse(): number {
    const C = this.ctx.api.hap.Characteristic;
    return this.ctx.hub.store.get().zones.some((z) => z.status === 'running') ? C.InUse.IN_USE : C.InUse.NOT_IN_USE;
  }

  private programMode(): number {
    const C = this.ctx.api.hap.Characteristic;
    return this.ctx.hub.store.get().enabled ? C.ProgramMode.PROGRAM_SCHEDULED : C.ProgramMode.NO_PROGRAM_SCHEDULED;
  }
}

function zoneIdOf(subtype: string | undefined): number | null {
  if (!subtype?.startsWith(SUBTYPE_PREFIX)) return null;
  const id = Number(subtype.slice(SUBTYPE_PREFIX.length));
  return Number.isInteger(id) && id >= 0 ? id : null;
}
