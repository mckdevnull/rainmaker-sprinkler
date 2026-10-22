import { describe, expect, it } from 'vitest';
import type { Forecast } from '../../src/weather/openMeteo.js';
import { evaluateWarnings, type WarningSettings } from '../../src/warnings/warnings.js';

const NOW = 1_700_000_000_000;
const settings: WarningSettings = { rainForecast: true, rainThresholdPct: 50, recentRun: true, recentRunWindowMin: 60 };
const forecast = (rainProbabilityPct: number): Forecast => ({
  fetchedAt: NOW,
  rainProbabilityPct,
  summary: 'x',
  tempC: 10,
});

describe('evaluateWarnings', () => {
  it('rain warning at/above threshold', () => {
    expect(evaluateWarnings(0, settings, forecast(50), null, NOW)).toEqual([{ kind: 'rain', probabilityPct: 50 }]);
    expect(evaluateWarnings(0, settings, forecast(49), null, NOW)).toEqual([]);
    expect(evaluateWarnings(0, settings, forecast(-1), null, NOW)).toEqual([]);
  });

  it('no rain warning when disabled', () => {
    expect(evaluateWarnings(0, { ...settings, rainForecast: false }, forecast(90), null, NOW)).toEqual([]);
  });

  it('recent-run warning inside window', () => {
    const w = evaluateWarnings(0, settings, null, NOW - 20 * 60e3 - 5_000, NOW);
    expect(w).toEqual([{ kind: 'recent-run', minutesAgo: 20 }]);
    expect(evaluateWarnings(0, settings, null, NOW - 60 * 60e3, NOW)).toEqual([]);
    expect(evaluateWarnings(0, { ...settings, recentRun: false }, null, NOW - 60e3, NOW)).toEqual([]);
  });

  it('no warnings with null inputs', () => {
    expect(evaluateWarnings(0, settings, null, null, NOW)).toEqual([]);
  });
});
