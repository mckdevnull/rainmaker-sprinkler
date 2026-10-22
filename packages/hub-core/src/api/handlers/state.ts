import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Hub } from '../../hub.js';
import type { Forecast } from '../../weather/openMeteo.js';
import { ok, type Handler } from './context.js';

/** /v1/state never waits longer than this for the weather; it reports null instead. */
const FORECAST_WAIT_MS = 1500;

export const photoDir = (hub: Hub): string => path.join(hub.config.dataDir, 'photos');
export const photoPath = (hub: Hub, id: number): string => path.join(photoDir(hub), `${id}.jpg`);

async function photoIds(hub: Hub): Promise<Set<number>> {
  try {
    const names = await fs.readdir(photoDir(hub));
    return new Set(names.filter((n) => /^\d+\.jpg$/.test(n)).map((n) => Number.parseInt(n, 10)));
  } catch {
    return new Set();
  }
}

async function forecastOrNull(hub: Hub): Promise<Forecast | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), FORECAST_WAIT_MS);
  });
  try {
    return await Promise.race([hub.forecast(), late]);
  } catch (err) {
    hub.logger.warn('rainmaker: forecast failed', err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The full state view shared by GET /v1/state and the WebSocket. Holds no controller secrets. */
export async function buildState(hub: Hub) {
  const [forecast, photos] = await Promise.all([forecastOrNull(hub), photoIds(hub)]);
  const state = hub.store.get();
  const zoneSettings = hub.settings.get().zones;
  const zones = state.zones.map((z) => {
    const fromHistory = hub.history.lastRunAt(z.id);
    const lastRunAt = Math.max(fromHistory ?? -Infinity, z.lastRunAt ?? -Infinity);
    return {
      ...z,
      name: zoneSettings[z.id]?.name ?? z.name,
      lastRunAt: Number.isFinite(lastRunAt) ? lastRunAt : null,
      photo: photos.has(z.id),
      voiceSeconds: hub.settings.voiceSeconds(z.id),
    };
  });
  return { ...state, zones, forecast, capabilities: hub.capabilities(), pause: hub.pause.describe() };
}

export const getState: Handler = async (hub) => ok(await buildState(hub));
