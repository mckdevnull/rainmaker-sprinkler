import type { Forecast } from '../weather/openMeteo.js';

export interface WarningSettings {
  rainForecast: boolean;
  /** Default 50. */
  rainThresholdPct: number;
  recentRun: boolean;
  /** Default 60. */
  recentRunWindowMin: number;
}
export type Warning = { kind: 'rain'; probabilityPct: number } | { kind: 'recent-run'; minutesAgo: number };

/**
 * Pure. The API layer decides when to ask; homekit/alexa sources never evaluate warnings.
 * `now` and `lastRunAt` are UTC ms. A -1 (unavailable) forecast never warns.
 */
export function evaluateWarnings(
  _zoneId: number,
  settings: WarningSettings,
  forecast: Forecast | null,
  lastRunAt: number | null,
  now: number,
): Warning[] {
  const out: Warning[] = [];
  if (settings.rainForecast && forecast && forecast.rainProbabilityPct >= settings.rainThresholdPct) {
    out.push({ kind: 'rain', probabilityPct: forecast.rainProbabilityPct });
  }
  if (settings.recentRun && lastRunAt !== null && now - lastRunAt < settings.recentRunWindowMin * 60e3) {
    out.push({ kind: 'recent-run', minutesAgo: Math.floor((now - lastRunAt) / 60e3) });
  }
  return out;
}
