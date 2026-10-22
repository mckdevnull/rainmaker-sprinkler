import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSimulator, type SimOptions, type Simulator } from '@rainmaker/controller-sim';
import type { API, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { RainmakerPlatform } from '../src/platform.js';
import { FakeApi, fakeLog, type FakeAccessory } from './fakes.js';

const PASSWORD = 'opendoor';
/** A fixed clock, so pause deadlines can be asserted exactly. */
export const NOW = Date.UTC(2026, 6, 1, 12);

export interface Running {
  platform: RainmakerPlatform;
  api: FakeApi;
  log: ReturnType<typeof fakeLog>;
  sim: Simulator;
  dir: string;
}

const running: Running[] = [];
const dirs: string[] = [];

export async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'homebridge-rainmaker-'));
  dirs.push(dir);
  return dir;
}

/** A platform on a fake Homebridge API, launched against a fresh simulator. */
export async function launch(
  opts: {
    config?: Record<string, unknown>;
    cached?: FakeAccessory[];
    dir?: string;
    sim?: Partial<SimOptions>;
    /** Runs after cached accessories are restored, before 'didFinishLaunching'; gets the start promise trigger. */
    duringStartup?: (r: Running, launch: () => void) => Promise<void>;
  } = {},
): Promise<Running> {
  const sim = createSimulator({ password: PASSWORD, passwordMode: 'plain', responseDelayMs: 2, ...opts.sim });
  const { baseUrl } = await sim.listen(0);
  const dir = opts.dir ?? (await tempDir());
  const api = new FakeApi();
  const log = fakeLog();
  const config = {
    platform: 'Rainmaker',
    name: 'Rainmaker',
    controller: { baseUrl, password: PASSWORD },
    dataDir: dir,
    apiPort: 0,
    ...opts.config,
  } as PlatformConfig;
  const platform = new RainmakerPlatform(log as unknown as Logging, config, api as unknown as API, {
    mdns: false,
    clock: () => NOW,
  });
  const r: Running = { platform, api, log, sim, dir };
  running.push(r);
  for (const acc of opts.cached ?? []) {
    api.registered = [...api.registered, acc];
    platform.configureAccessory(acc as unknown as PlatformAccessory);
  }
  if (opts.duringStartup) await opts.duringStartup(r, () => api.emit('didFinishLaunching'));
  else api.emit('didFinishLaunching');
  await platform.ready();
  return r;
}

/** Stops a platform the way Homebridge does on shutdown. */
export async function shutdown(r: Running): Promise<void> {
  const i = running.indexOf(r);
  if (i >= 0) running.splice(i, 1);
  r.api.emit('shutdown');
  await r.platform.stopped();
  await r.platform.hub?.pairing.flush().catch(() => undefined);
  await r.sim.close();
}

export async function cleanup(): Promise<void> {
  for (const r of [...running]) await shutdown(r);
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
}

/** Lets queued microtasks and a zero-delay timer (characteristic reverts) run. */
export const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));
