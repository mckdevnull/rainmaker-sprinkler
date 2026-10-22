import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenMeteoClient } from '../../src/weather/openMeteo.js';

const HOUR = 3600e3;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16);

/** `count` hourly entries starting at startMs; probs/temps by index. */
function fixture(startMs: number, count: number, prob: (i: number) => number, temp: (i: number) => number = () => 12) {
  const idx = Array.from({ length: count }, (_, i) => i);
  return {
    hourly: {
      time: idx.map((i) => iso(startMs + i * HOUR)),
      precipitation_probability: idx.map(prob),
      temperature_2m: idx.map(temp),
    },
  };
}
// Typed params so mock.calls[0][0] is the URL.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const respond = (body: unknown) => vi.fn(async (_url: string) => new Response(JSON.stringify(body), { status: 200 }));

afterEach(() => vi.useRealTimers());

describe('OpenMeteoClient', () => {
  it('parses the max over the next 24 hourly values', async () => {
    const now = Date.UTC(2026, 5, 1, 10, 30);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const start = Date.UTC(2026, 5, 1, 10);
    const f = fixture(start, 48, (i) => (i === 30 ? 90 : i === 5 ? 20 : 0), (i) => 10 + i);
    const fetchImpl = respond(f);
    const fc = await new OpenMeteoClient(0, 0, fetchImpl as unknown as typeof fetch).getForecast();
    expect(fc.rainProbabilityPct).toBe(20);
    expect(fc.tempC).toBe(10);
    expect(fc.summary).toBe('No rain expected');
    expect(fc.fetchedAt).toBe(now);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://api.open-meteo.com/v1/forecast?latitude=0&longitude=0&hourly=precipitation_probability,temperature_2m&forecast_hours=24&timezone=UTC',
    );
  });

  it('skips entries before the current hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 5, 1, 10, 30));
    const f = fixture(Date.UTC(2026, 5, 1, 8), 30, (i) => (i === 0 ? 95 : 40));
    const fc = await new OpenMeteoClient(0, 0, respond(f) as unknown as typeof fetch).getForecast();
    expect(fc.rainProbabilityPct).toBe(40);
    expect(fc.summary).toBe('Rain possible');
  });

  it('window crosses midnight', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 5, 1, 22, 10));
    const start = Date.UTC(2026, 5, 1, 22);
    const f = fixture(start, 24, (i) => (i === 5 ? 70 : 0)); // 03:00 next day
    const fc = await new OpenMeteoClient(0, 0, respond(f) as unknown as typeof fetch).getForecast();
    expect(fc.rainProbabilityPct).toBe(70);
    expect(fc.summary).toBe('Rain likely');
  });

  it('caches for 30 minutes', async () => {
    const t0 = Date.UTC(2026, 5, 1, 10, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const fetchImpl = respond(fixture(t0, 24, () => 0));
    const client = new OpenMeteoClient(0, 0, fetchImpl as unknown as typeof fetch);
    await client.getForecast();
    vi.setSystemTime(t0 + 29 * 60e3);
    await client.getForecast();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    vi.setSystemTime(t0 + 31 * 60e3);
    await client.getForecast();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns null-safe forecast on network error', async () => {
    const t0 = Date.UTC(2026, 5, 1, 10, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(async () =>
      new Response(JSON.stringify(fixture(t0, 24, () => 10)), { status: 200 }),
    );
    const client = new OpenMeteoClient(0, 0, fetchImpl as unknown as typeof fetch);
    await expect(client.getForecast()).resolves.toEqual({
      fetchedAt: t0,
      rainProbabilityPct: -1,
      summary: 'Forecast unavailable',
      tempC: null,
    });
    // Failure is cached for under a minute only.
    await client.getForecast();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    vi.setSystemTime(t0 + 61e3);
    expect((await client.getForecast()).rainProbabilityPct).toBe(10);
  });

  it('treats malformed bodies and HTTP errors as unavailable', async () => {
    const bad = [new Response('{}', { status: 200 }), new Response('nope', { status: 500 })];
    for (const r of bad) {
      const client = new OpenMeteoClient(0, 0, (async () => r) as unknown as typeof fetch);
      expect((await client.getForecast()).summary).toBe('Forecast unavailable');
    }
  });
});
