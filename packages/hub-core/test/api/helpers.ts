import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSimulator, type SimOptions, type Simulator } from '@rainmaker/controller-sim';
import { vi } from 'vitest';
import { validateConfig } from '../../src/config.js';
import { createHub, type Hub, type HubDeps } from '../../src/hub.js';

export const PASSWORD = 'opendoor';

export interface TestHub {
  hub: Hub;
  sim: Simulator;
  url: string;
  dir: string;
  token: string;
  logger: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  api(method: string, p: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
}

const running: TestHub[] = [];

export function silentLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A real hub on an ephemeral port against a fresh simulator, with a paired test device. */
export async function startHub(
  opts: { config?: Record<string, unknown>; deps?: HubDeps; sim?: Partial<SimOptions>; pair?: boolean } = {},
): Promise<TestHub> {
  const sim = createSimulator({ password: PASSWORD, passwordMode: 'plain', responseDelayMs: 2, ...opts.sim });
  const { baseUrl } = await sim.listen(0);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rainmaker-hub-'));
  const logger = silentLogger();
  const config = validateConfig({
    controller: { baseUrl, password: PASSWORD },
    dataDir: dir,
    apiPort: 0,
    ...opts.config,
  });
  const hub = createHub(config, { logger, mdns: false, ...opts.deps });
  const t: TestHub = { hub, sim, dir, logger, url: '', token: '', api: async () => new Response() };
  running.push(t);
  await hub.start();
  t.url = `http://127.0.0.1:${hub.apiPort()}`;
  if (opts.pair !== false) t.token = hub.pairing.claim(hub.pairing.startPairing().code, 'test device')?.token ?? '';
  t.api = (method, p, body, headers = {}) =>
    fetch(`${t.url}${p}`, {
      method,
      headers: {
        ...(t.token ? { Authorization: `Bearer ${t.token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return t;
}

/** The most recently created test hub (also when its start() failed). */
export const lastHub = (): TestHub | undefined => running[running.length - 1];

export async function stopHubs(): Promise<void> {
  for (const t of running.splice(0)) {
    await t.hub.stop();
    await t.sim.close();
    await t.hub.pairing.flush().catch(() => undefined);
    await fs.rm(t.dir, { recursive: true, force: true });
  }
}

/** An Open-Meteo stub answering `pct` % rain for the next 24 hours. */
export function rainForecastFetch(pct: number): typeof fetch {
  return (async () => {
    const hour = Math.floor(Date.now() / 3600e3) * 3600e3;
    const time = Array.from({ length: 24 }, (_, i) => new Date(hour + i * 3600e3).toISOString().slice(0, 16));
    const hourly = { time, precipitation_probability: time.map(() => pct), temperature_2m: time.map(() => 12) };
    return new Response(JSON.stringify({ hourly }), { status: 200 });
  }) as unknown as typeof fetch;
}

/** Real-time poll for a condition. */
export async function eventually(pred: () => boolean, ms = 2000): Promise<boolean> {
  for (let waited = 0; waited < ms && !pred(); waited += 20) await new Promise((r) => setTimeout(r, 20));
  return pred();
}

/** Response JSON, loosely typed for assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const json = (res: Response): Promise<any> => res.json();
