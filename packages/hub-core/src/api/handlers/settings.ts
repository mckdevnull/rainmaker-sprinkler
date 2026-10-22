import { parseVoiceSeconds, parseWarnings } from '../../config.js';
import type { Hub } from '../../hub.js';
import type { Settings, ZoneSettings } from '../../settings/settingsStore.js';
import { intKey, optional, rejectUnknown, reqBool, reqInt, reqObject, reqString, ValidationError } from '../../validate.js';
import { ok, type Handler } from './context.js';

/** Before the first poll the zone count is unknown; allow the controller maximum. */
const MAX_ZONES = 200;

function parseZones(v: unknown, hub: Hub): Settings['zones'] {
  const o = reqObject(v, 'zones');
  const count = hub.store.get().zones.length || MAX_ZONES;
  const out: Record<number, ZoneSettings> = {};
  for (const [key, entry] of Object.entries(o)) {
    const field = `zones.${key}`;
    const id = intKey(key, field);
    if (id >= count) throw new ValidationError(field, 'is not a zone on this controller');
    const e = reqObject(entry, field);
    rejectUnknown(e, ['name', 'order', 'voiceSeconds'], `${field}.`);
    const name = optional(e.name, (x) => reqString(x, `${field}.name`, { min: 1, max: 64 }));
    const order = optional(e.order, (x) => reqInt(x, `${field}.order`, 0, 10_000));
    const voiceSeconds =
      optional(e.voiceSeconds, (x) => parseVoiceSeconds(x, `${field}.voiceSeconds`)) ?? hub.settings.voiceSeconds(id);
    out[id] = { ...(name !== undefined && { name }), ...(order !== undefined && { order }), voiceSeconds };
  }
  return out;
}

export const getSettings: Handler = async (hub) => ok(hub.settings.get());

/** Each top-level section sent replaces the stored one; warnings merge field by field. */
export const putSettings: Handler = async (hub, req) => {
  const o = reqObject(req.body, 'body');
  rejectUnknown(o, ['warnings', 'zones', 'notifications']);
  const current = hub.settings.get();
  const patch: Partial<Settings> = {};
  if (o.warnings !== undefined) patch.warnings = parseWarnings(o.warnings, 'warnings', current.warnings);
  if (o.zones !== undefined) patch.zones = parseZones(o.zones, hub);
  if (o.notifications !== undefined) {
    const n = reqObject(o.notifications, 'notifications');
    rejectUnknown(n, ['offline'], 'notifications.');
    patch.notifications = { offline: reqBool(n.offline, 'notifications.offline') };
  }
  return ok(await hub.settings.update(patch));
};
