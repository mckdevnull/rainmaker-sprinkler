export const PLUGIN_NAME = 'homebridge-rainmaker';
export const PLATFORM_NAME = 'Rainmaker';

/** Hub data lives here, under the Homebridge storage path, unless `dataDir` says otherwise. */
export const DEFAULT_DATA_DIR = 'rainmaker';

const HOUR_MS = 3600e3;
/** The longest rain delay OpenSprinkler accepts; "Sprinkler Pause" means "until resumed". */
export const INDEFINITE_PAUSE_MS = 32767 * HOUR_MS;
export const PAUSE_1_DAY_MS = 24 * HOUR_MS;
export const PAUSE_1_WEEK_MS = 168 * HOUR_MS;

/** Momentary switches turn themselves back off after this long. */
export const MOMENTARY_MS = 1000;

/** Same ceiling as the hub's voice duration (18 h). */
export const MAX_DURATION_SECONDS = 64800;
