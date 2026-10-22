export interface Forecast {
  fetchedAt: number;
  /** Max over the 24 hourly values starting at the current hour; -1 when unavailable. */
  rainProbabilityPct: number;
  summary: string;
  tempC: number | null;
}

const HOUR_MS = 3_600_000;
const WINDOW_HOURS = 24;
const CACHE_MS = 30 * 60e3;
const FAILURE_CACHE_MS = 60e3;
const REQUEST_TIMEOUT_MS = 10_000;
/** Summary thresholds (rain probability %): below 30 none, 30-59 possible, 60 and above likely. */
const POSSIBLE_PCT = 30;
const LIKELY_PCT = 60;

const summarize = (pct: number): string =>
  pct >= LIKELY_PCT ? 'Rain likely' : pct >= POSSIBLE_PCT ? 'Rain possible' : 'No rain expected';

interface Hourly {
  time: string[];
  precipitation_probability: (number | null)[];
  temperature_2m: (number | null)[];
}

function parse(body: unknown, now: number): Forecast {
  const h = (body as { hourly?: Partial<Hourly> } | null)?.hourly;
  if (!h || !Array.isArray(h.time) || !Array.isArray(h.precipitation_probability)) {
    throw new Error('unexpected Open-Meteo response shape');
  }
  const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const start = h.time.findIndex((t) => Date.parse(`${t}Z`) >= currentHour);
  if (start < 0) throw new Error('Open-Meteo response has no entry for the current hour');
  const probs = h.precipitation_probability
    .slice(start, start + WINDOW_HOURS)
    .filter((p): p is number => typeof p === 'number');
  if (probs.length === 0) throw new Error('Open-Meteo response has no precipitation values');
  const pct = Math.max(...probs);
  const temp = h.temperature_2m?.[start];
  return { fetchedAt: now, rainProbabilityPct: pct, summary: summarize(pct), tempC: typeof temp === 'number' ? temp : null };
}

export class OpenMeteoClient {
  private cached: { forecast: Forecast; ttlMs: number } | null = null;

  constructor(
    private readonly lat: number,
    private readonly lon: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Never throws: failures yield an "unavailable" forecast, cached for one minute. */
  async getForecast(): Promise<Forecast> {
    const now = Date.now();
    if (this.cached && now - this.cached.forecast.fetchedAt < this.cached.ttlMs) return this.cached.forecast;
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${this.lat}&longitude=${this.lon}` +
      `&hourly=precipitation_probability,temperature_2m&forecast_hours=24&timezone=UTC`;
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
      this.cached = { forecast: parse(await res.json(), now), ttlMs: CACHE_MS };
    } catch {
      const forecast: Forecast = { fetchedAt: now, rainProbabilityPct: -1, summary: 'Forecast unavailable', tempC: null };
      this.cached = { forecast, ttlMs: FAILURE_CACHE_MS };
    }
    return this.cached.forecast;
  }
}
