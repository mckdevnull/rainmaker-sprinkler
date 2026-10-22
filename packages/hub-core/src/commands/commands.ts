import { ControllerRejected, ControllerUnauthorized, ControllerUnreachable } from '../controller/errors.js';
import type { ControllerClient } from '../controller/client.js';
import type { JcResponse } from '../controller/types.js';
import type { Zone } from '../state/model.js';
import type { Poller } from '../state/poller.js';
import type { StateStore } from '../state/store.js';

export type CommandSource = 'app' | 'web' | 'siri-intent' | 'homekit' | 'alexa';
export type CommandError = 'offline' | 'unauthorized' | 'rejected' | 'timeout' | 'not-applied';
export type CommandResult = { ok: true; confirmedInMs: number } | { ok: false; error: CommandError };

export const COMMAND_DEADLINE_MS = 3000;
const RETRY_GAP_MS = 300;

interface Plan {
  readonly event: Record<string, unknown>;
  readonly zoneIds: readonly number[] | 'all';
  readonly touchesEnabled: boolean;
  optimistic(zones: readonly Zone[], enabled: boolean): { zones?: Zone[]; enabled?: boolean };
  send(client: ControllerClient, deadlineMs: number): Promise<void>;
  confirmed(jc: JcResponse): boolean;
}

const bit = (jc: JcResponse, id: number): boolean => (((jc.sbits[id >> 3] ?? 0) >> (id & 7)) & 1) === 1;
const pid = (jc: JcResponse, id: number): number => jc.ps[id]?.[0] ?? 0;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const mapZones = (zones: readonly Zone[], f: (z: Zone) => Zone): Zone[] => zones.map(f);

export class Commands {
  constructor(
    private readonly client: ControllerClient,
    private readonly store: StateStore,
    private readonly poller: Poller,
  ) {}

  runZone(id: number, seconds: number, source: CommandSource): Promise<CommandResult> {
    return this.execute(source, {
      event: { type: 'runZone', id, seconds },
      zoneIds: [id],
      touchesEnabled: false,
      optimistic: (zones) => {
        const othersRunning = zones.some((z) => z.id !== id && z.status === 'running');
        const status = othersRunning ? 'queued' : 'running';
        return { zones: mapZones(zones, (z) => (z.id === id ? { ...z, status, remainingSec: seconds } : z)) };
      },
      send: (c, deadlineMs) => c.runStation(id, seconds, { deadlineMs }),
      confirmed: (jc) => bit(jc, id) || pid(jc, id) !== 0,
    });
  }

  stopZone(id: number, source: CommandSource): Promise<CommandResult> {
    return this.execute(source, {
      event: { type: 'stopZone', id },
      zoneIds: [id],
      touchesEnabled: false,
      optimistic: (zones) => ({
        zones: mapZones(zones, (z) => (z.id === id ? { ...z, status: 'idle', remainingSec: null } : z)),
      }),
      send: (c, deadlineMs) => c.stopStation(id, { deadlineMs }),
      confirmed: (jc) => !bit(jc, id) && pid(jc, id) === 0,
    });
  }

  stopAll(source: CommandSource): Promise<CommandResult> {
    return this.execute(source, {
      event: { type: 'stopAll' },
      zoneIds: 'all',
      touchesEnabled: false,
      optimistic: (zones) => ({ zones: mapZones(zones, (z) => ({ ...z, status: 'idle', remainingSec: null })) }),
      send: (c, deadlineMs) => c.stopAll({ deadlineMs }),
      confirmed: (jc) => jc.sbits.every((b) => b === 0),
    });
  }

  setSystemEnabled(enabled: boolean, source: CommandSource): Promise<CommandResult> {
    return this.execute(source, {
      event: { type: 'setSystemEnabled', enabled },
      zoneIds: [],
      touchesEnabled: true,
      optimistic: () => ({ enabled }),
      send: (c, deadlineMs) => c.setEnabled(enabled, { deadlineMs }),
      confirmed: (jc) => (jc.en === 1) === enabled,
    });
  }

  private async execute(source: CommandSource, plan: Plan): Promise<CommandResult> {
    const start = Date.now();
    const remaining = () => COMMAND_DEADLINE_MS - (Date.now() - start);
    const before = this.store.get();
    const touched = before.zones.filter((z) => plan.zoneIds === 'all' || plan.zoneIds.includes(z.id));
    this.store.patch(plan.optimistic(before.zones, before.enabled));
    this.store.emit('command', { ...plan.event, source });
    try {
      await plan.send(this.client, remaining());
      if (await this.confirm(plan, remaining)) return { ok: true, confirmedInMs: Date.now() - start };
      return { ok: false, error: 'not-applied' };
    } catch (err) {
      this.revert(touched, plan.touchesEnabled ? before.enabled : undefined);
      return { ok: false, error: this.mapError(err) };
    }
  }

  /** Read back the real state; one retry after a short gap if the predicate is not yet true. */
  private async confirm(plan: Plan, remaining: () => number): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const jc = await this.client.getStatus({ confirm: true, deadlineMs: Math.max(1, remaining()) });
      this.poller.applyStatus(jc);
      if (plan.confirmed(jc)) return true;
      if (attempt === 0) {
        if (remaining() < RETRY_GAP_MS) return false;
        await sleep(RETRY_GAP_MS);
      }
    }
    return false;
  }

  private revert(touched: readonly Zone[], enabled: boolean | undefined): void {
    const byId = new Map(touched.map((z) => [z.id, z]));
    const zones = mapZones(this.store.get().zones, (z) => {
      const old = byId.get(z.id);
      return old ? { ...z, status: old.status, remainingSec: old.remainingSec } : z;
    });
    this.store.patch(enabled === undefined ? { zones } : { zones, enabled });
  }

  private mapError(err: unknown): CommandError {
    if (err instanceof ControllerUnauthorized) return 'unauthorized';
    if (err instanceof ControllerRejected) return 'rejected';
    if (err instanceof ControllerUnreachable) return this.store.get().online === false ? 'offline' : 'timeout';
    console.error('rainmaker command error', err);
    return 'timeout';
  }
}
