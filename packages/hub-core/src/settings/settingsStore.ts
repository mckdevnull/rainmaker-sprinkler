import type { HubConfig } from '../config.js';
import type { JsonStore } from '../persist/jsonStore.js';
import type { WarningSettings } from '../warnings/warnings.js';

export interface ZoneSettings {
  name?: string;
  order?: number;
  voiceSeconds: number;
}
export interface Settings {
  warnings: WarningSettings;
  zones: Record<number, ZoneSettings>;
  notifications: { offline: boolean };
}

const STORE_KEY = 'settings';
/** Voice runs use this when neither settings nor config give a zone a duration. */
export const DEFAULT_VOICE_SECONDS = 600;

function freeze(s: Settings): Settings {
  const zones = Object.fromEntries(Object.entries(s.zones).map(([k, z]) => [k, Object.freeze({ ...z })]));
  return Object.freeze({
    warnings: Object.freeze({ ...s.warnings }),
    zones: Object.freeze(zones),
    notifications: Object.freeze({ ...s.notifications }),
  });
}

/**
 * Owner-editable settings, persisted under the JsonStore key 'settings'. Defaults come from the
 * config (warnings, zoneDefaults, notifications.offline); a saved value replaces its whole
 * top-level section. `get()` returns a frozen snapshot.
 */
export class SettingsStore {
  private current: Settings;

  constructor(
    private readonly persist: JsonStore,
    config: Pick<HubConfig, 'warnings' | 'zoneDefaults' | 'notifications'>,
  ) {
    const zones: Record<number, ZoneSettings> = {};
    for (const [k, z] of Object.entries(config.zoneDefaults)) zones[Number(k)] = { voiceSeconds: z.voiceSeconds };
    this.current = freeze({
      warnings: config.warnings,
      zones,
      notifications: { offline: config.notifications.offline },
    });
  }

  async load(): Promise<void> {
    const saved = await this.persist.get<Partial<Settings> | null>(STORE_KEY, null);
    if (saved) this.current = freeze({ ...this.current, ...saved });
  }

  get(): Settings {
    return this.current;
  }

  voiceSeconds(zoneId: number): number {
    return this.current.zones[zoneId]?.voiceSeconds ?? DEFAULT_VOICE_SECONDS;
  }

  /** Persists first; memory changes only once the write succeeded. */
  async update(p: Partial<Settings>): Promise<Settings> {
    const next = freeze({ ...this.current, ...p });
    await this.persist.set(STORE_KEY, next);
    this.current = next;
    return next;
  }
}
