import { ShellyPlug } from './shelly.js';
import { TasmotaPlug } from './tasmota.js';

export interface SmartPlug {
  powerCycle(offMs: number): Promise<void>;
}

export type PlugConfig =
  | { type: 'shelly'; host: string }
  | { type: 'tasmota'; host: string }
  | { type: 'homekit-automation' }
  | { type: 'none' };

const CALL_TIMEOUT_MS = 5000;
const HOST_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9.:-]*[A-Za-z0-9])?$/;

/** A hostname or IP only: no scheme, path, credentials or whitespace. */
export function assertPlugHost(host: string): void {
  if (!host || /[\s/@]/.test(host) || !HOST_PATTERN.test(host)) {
    throw new Error(
      `Invalid smart plug host "${host}": use a bare hostname or IP address (no scheme, path or credentials)`,
    );
  }
}

/** GET a URL with a 5 s timeout; a non-OK response throws. */
export async function plugGet(fetchImpl: typeof fetch, url: string): Promise<void> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`smart plug request failed: HTTP ${res.status} for ${url}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createPlug(cfg: PlugConfig, fetchImpl: typeof fetch = fetch): SmartPlug | null {
  switch (cfg.type) {
    case 'shelly':
      assertPlugHost(cfg.host);
      return new ShellyPlug(cfg.host, fetchImpl);
    case 'tasmota':
      assertPlugHost(cfg.host);
      return new TasmotaPlug(cfg.host, fetchImpl);
    default:
      return null;
  }
}
