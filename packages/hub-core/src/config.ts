import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assertPlugHost, type PlugConfig } from './recovery/plug.js';
import {
  intKey,
  MAX_RUN_SECONDS,
  optional,
  rejectUnknown,
  reqBool,
  reqInt,
  reqNumber,
  reqObject,
  reqString,
  ValidationError,
} from './validate.js';
import type { WarningSettings } from './warnings/warnings.js';

export interface NotificationConfig {
  offline: boolean;
  apnsKeyPath?: string;
  apnsKeyId?: string;
  apnsTeamId?: string;
  apnsBundleId?: string;
  ntfyTopic?: string;
  pushoverToken?: string;
  /** Pushover also needs the user (or group) key the message goes to. */
  pushoverUser?: string;
}

export interface HubConfig {
  controller: { baseUrl: string; password: string };
  dataDir: string;
  /** Default 8787; 0 binds an ephemeral port (see `Hub.apiPort()`). */
  apiPort: number;
  allowedOrigins: string[];
  location: { lat: number; lon: number } | null;
  warnings: WarningSettings;
  plug: PlugConfig;
  notifications: NotificationConfig;
  zoneDefaults: Record<number, { voiceSeconds: number }>;
}

export const DEFAULT_WARNINGS: Readonly<WarningSettings> = Object.freeze({
  rainForecast: true,
  rainThresholdPct: 50,
  recentRun: true,
  recentRunWindowMin: 60,
});

const TOP_LEVEL = [
  'controller',
  'dataDir',
  'apiPort',
  'allowedOrigins',
  'location',
  'warnings',
  'plug',
  'notifications',
  'zoneDefaults',
] as const;
const APNS_FIELDS = ['apnsKeyPath', 'apnsKeyId', 'apnsTeamId', 'apnsBundleId'] as const;
const NTFY_TOPIC = /^[A-Za-z0-9_-]{1,64}$/;

/** Validates warning settings; fields missing from `v` keep their value in `base`. */
export function parseWarnings(v: unknown, field: string, base: WarningSettings): WarningSettings {
  const o = reqObject(v, field);
  rejectUnknown(o, ['rainForecast', 'rainThresholdPct', 'recentRun', 'recentRunWindowMin'], `${field}.`);
  return {
    rainForecast: optional(o.rainForecast, (x) => reqBool(x, `${field}.rainForecast`)) ?? base.rainForecast,
    rainThresholdPct:
      optional(o.rainThresholdPct, (x) => reqInt(x, `${field}.rainThresholdPct`, 0, 100)) ?? base.rainThresholdPct,
    recentRun: optional(o.recentRun, (x) => reqBool(x, `${field}.recentRun`)) ?? base.recentRun,
    recentRunWindowMin:
      optional(o.recentRunWindowMin, (x) => reqInt(x, `${field}.recentRunWindowMin`, 1, 1440)) ??
      base.recentRunWindowMin,
  };
}

export function parseVoiceSeconds(v: unknown, field: string): number {
  return reqInt(v, field, 1, MAX_RUN_SECONDS);
}

function parseController(v: unknown): HubConfig['controller'] {
  const o = reqObject(v, 'controller');
  rejectUnknown(o, ['baseUrl', 'password'], 'controller.');
  const baseUrl = reqString(o.baseUrl, 'controller.baseUrl', { min: 1 });
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ValidationError('controller.baseUrl', 'must be a URL such as http://192.0.2.10');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError('controller.baseUrl', 'must start with http:// or https://');
  }
  return { baseUrl, password: reqString(o.password, 'controller.password', { min: 1 }) };
}

function parseOrigins(v: unknown): string[] {
  if (!Array.isArray(v)) throw new ValidationError('allowedOrigins', 'must be a list of origins');
  return v.map((item, i) => {
    const field = `allowedOrigins[${i}]`;
    const s = reqString(item, field, { min: 1 });
    let origin: string;
    try {
      origin = new URL(s).origin;
    } catch {
      throw new ValidationError(field, 'must be an origin such as http://192.0.2.10');
    }
    if (origin !== s) throw new ValidationError(field, 'must be an origin (scheme://host[:port], no path)');
    return s;
  });
}

function parseLocation(v: unknown): HubConfig['location'] {
  if (v === null) return null;
  const o = reqObject(v, 'location');
  rejectUnknown(o, ['lat', 'lon'], 'location.');
  return { lat: reqNumber(o.lat, 'location.lat', -90, 90), lon: reqNumber(o.lon, 'location.lon', -180, 180) };
}

function parsePlug(v: unknown): PlugConfig {
  const o = reqObject(v, 'plug');
  const type = reqString(o.type, 'plug.type');
  if (type === 'none' || type === 'homekit-automation') {
    rejectUnknown(o, ['type'], 'plug.');
    return { type };
  }
  if (type !== 'shelly' && type !== 'tasmota') {
    throw new ValidationError('plug.type', 'must be one of none, shelly, tasmota, homekit-automation');
  }
  rejectUnknown(o, ['type', 'host'], 'plug.');
  const host = reqString(o.host, 'plug.host', { min: 1 });
  try {
    assertPlugHost(host);
  } catch {
    throw new ValidationError('plug.host', 'must be a bare hostname or IP address');
  }
  return { type, host };
}

function parseNotifications(v: unknown): NotificationConfig {
  const o = reqObject(v, 'notifications');
  rejectUnknown(o, ['offline', ...APNS_FIELDS, 'ntfyTopic', 'pushoverToken', 'pushoverUser'], 'notifications.');
  const out: NotificationConfig = {
    offline: optional(o.offline, (x) => reqBool(x, 'notifications.offline')) ?? true,
  };
  const str = (key: Exclude<keyof NotificationConfig, 'offline'>) =>
    optional(o[key], (x) => reqString(x, `notifications.${key}`, { min: 1, max: 4096 }));
  const set = APNS_FIELDS.filter((k) => o[k] !== undefined);
  if (set.length > 0) {
    const missing = APNS_FIELDS.find((k) => o[k] === undefined);
    if (missing) throw new ValidationError(`notifications.${missing}`, 'is required when any APNs field is set');
    for (const k of APNS_FIELDS) out[k] = str(k);
  }
  const topic = str('ntfyTopic');
  if (topic !== undefined) {
    if (!NTFY_TOPIC.test(topic)) throw new ValidationError('notifications.ntfyTopic', 'must be letters, digits, - or _');
    out.ntfyTopic = topic;
  }
  const pushoverToken = str('pushoverToken');
  const pushoverUser = str('pushoverUser');
  if ((pushoverToken === undefined) !== (pushoverUser === undefined)) {
    const missing = pushoverToken === undefined ? 'pushoverToken' : 'pushoverUser';
    throw new ValidationError(`notifications.${missing}`, 'is required when the other Pushover field is set');
  }
  if (pushoverToken !== undefined && pushoverUser !== undefined) {
    out.pushoverToken = pushoverToken;
    out.pushoverUser = pushoverUser;
  }
  return out;
}

function parseZoneDefaults(v: unknown): HubConfig['zoneDefaults'] {
  const o = reqObject(v, 'zoneDefaults');
  const out: Record<number, { voiceSeconds: number }> = {};
  for (const [key, entry] of Object.entries(o)) {
    const field = `zoneDefaults.${key}`;
    const id = intKey(key, field);
    const e = reqObject(entry, field);
    rejectUnknown(e, ['voiceSeconds'], `${field}.`);
    out[id] = { voiceSeconds: parseVoiceSeconds(e.voiceSeconds, `${field}.voiceSeconds`) };
  }
  return out;
}

function parse(obj: unknown): HubConfig {
  const o = reqObject(obj, '(root)');
  rejectUnknown(o, TOP_LEVEL);
  return {
    controller: parseController(o.controller),
    dataDir: reqString(o.dataDir, 'dataDir', { min: 1 }),
    apiPort: optional(o.apiPort, (x) => reqInt(x, 'apiPort', 0, 65535)) ?? 8787,
    allowedOrigins: optional(o.allowedOrigins, parseOrigins) ?? [],
    location: optional(o.location, parseLocation) ?? null,
    warnings: optional(o.warnings, (x) => parseWarnings(x, 'warnings', DEFAULT_WARNINGS)) ?? { ...DEFAULT_WARNINGS },
    plug: optional(o.plug, parsePlug) ?? { type: 'none' },
    notifications: optional(o.notifications, parseNotifications) ?? { offline: true },
    zoneDefaults: optional(o.zoneDefaults, parseZoneDefaults) ?? {},
  };
}

/** Validates a parsed config object and applies defaults; throws `Error('config: <field> <problem>')`. */
export function validateConfig(obj: unknown): HubConfig {
  try {
    return parse(obj);
  } catch (err) {
    if (err instanceof ValidationError) throw new Error(`config: ${err.message}`);
    throw err;
  }
}

/**
 * Reads and validates a JSON config file. A relative `dataDir` is resolved against the
 * directory holding the config file, so the hub finds its data whatever the working directory.
 */
export function loadConfig(file: string): HubConfig {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`config: ${file} could not be read (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error(`config: ${file} is not valid JSON`);
  }
  const cfg = validateConfig(obj);
  const dataDir = path.resolve(path.dirname(path.resolve(file)), cfg.dataDir);
  return { ...cfg, dataDir };
}
