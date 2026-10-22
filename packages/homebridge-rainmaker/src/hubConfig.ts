import path from 'node:path';
import { validateConfig, type HubConfig } from '@rainmaker/hub-core';
import { DEFAULT_DATA_DIR } from './constants.js';

/** Keys Homebridge adds to every platform block; they are not hub settings. */
const HOMEBRIDGE_KEYS = new Set(['platform', 'name', '_bridge']);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The Homebridge UI edits zone defaults as a list of {zone, voiceSeconds}; the hub keys them by zone id. */
function zoneDefaultsFromList(list: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  list.forEach((item, i) => {
    if (!isObject(item) || item.zone === undefined) {
      throw new Error(`config: zoneDefaults[${i}] must have a zone and voiceSeconds`);
    }
    const key = String(item.zone);
    if (key in out) throw new Error(`config: zoneDefaults lists zone ${key} twice`);
    out[key] = { voiceSeconds: item.voiceSeconds };
  });
  return out;
}

/**
 * Turns the Homebridge platform block into a validated `HubConfig`. `dataDir` defaults to
 * `<storagePath>/rainmaker`, and a relative one is resolved against the storage path.
 */
export function toHubConfig(config: Record<string, unknown>, storagePath: string): HubConfig {
  const { location, zoneDefaults, dataDir, ...rest } = Object.fromEntries(
    Object.entries(config).filter(([k]) => !HOMEBRIDGE_KEYS.has(k)),
  );
  // The UI can save an empty location block; that means "no location", not an invalid one.
  const noLocation = location === undefined || (isObject(location) && location.lat === undefined && location.lon === undefined);
  const dir = dataDir === undefined || dataDir === '' ? DEFAULT_DATA_DIR : dataDir;
  return validateConfig({
    ...rest,
    dataDir: typeof dir === 'string' ? path.resolve(storagePath, dir) : dir,
    ...(noLocation ? {} : { location }),
    ...(zoneDefaults === undefined ? {} : { zoneDefaults: Array.isArray(zoneDefaults) ? zoneDefaultsFromList(zoneDefaults) : zoneDefaults }),
  });
}
