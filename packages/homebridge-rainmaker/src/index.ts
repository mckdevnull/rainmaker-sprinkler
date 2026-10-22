import type { API } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './constants.js';
import { RainmakerPlatform } from './platform.js';

/** Homebridge entry point. */
export default (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, RainmakerPlatform);
};
