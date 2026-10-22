import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handle } from './handlers.js';
import { advance, createState, makeStations, type SimState } from './state.js';

export type { LogEntry, SimProgram, SimState } from './state.js';

export type PasswordMode = 'plain' | 'md5';

export interface SimOptions {
  password: string;
  passwordMode: PasswordMode;
  nStations: number;
  fwv: number;
  hwv: number;
  responseDelayMs: number;
  tzOffsetSec: number;
  dropCommands: boolean;
  clock?: () => number;
}

export interface Simulator {
  listen(port?: number): Promise<{ port: number; baseUrl: string }>;
  close(): Promise<void>;
  state: SimState;
  setOffline(offline: boolean): void;
  setPassword(password: string): void;
  setStationCount(n: number): void;
  requestCount: number;
  tick(ms: number): void;
}

const HOST = '127.0.0.1';

const DEFAULTS = {
  password: 'opendoor',
  passwordMode: 'plain',
  nStations: 8,
  fwv: 216,
  hwv: 22,
  responseDelayMs: 150,
  tzOffsetSec: -21600,
  dropCommands: false,
} satisfies Omit<SimOptions, 'clock'>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createSimulator(overrides: Partial<SimOptions> = {}): Simulator {
  const opts: SimOptions = { ...DEFAULTS, ...overrides };
  let offsetMs = 0;
  const now = () => (opts.clock ?? Date.now)() + offsetMs;
  const state = createState(now(), opts.nStations);
  let server: Server | null = null;
  let port = 0;
  let timer: NodeJS.Timeout | null = null;
  // One request at a time, like the AVR: each request waits for the previous response.
  let queue: Promise<void> = Promise.resolve();

  const serve = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const finished = new Promise<void>((resolve) => res.once('close', resolve));
    await sleep(opts.responseDelayMs);
    advance(state, now());
    const url = new URL(req.url ?? '/', 'http://controller');
    const body = JSON.stringify(handle(url.pathname, url.searchParams, state, opts));
    res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(body);
    await finished;
  };

  const sim: Simulator = {
    state,
    requestCount: 0,
    async listen(requested = 0) {
      server = createServer((req, res) => {
        sim.requestCount += 1;
        queue = queue.then(() => serve(req, res)).catch(() => undefined);
      });
      await new Promise<void>((resolve, reject) => {
        server?.once('error', reject);
        server?.listen(requested, HOST, resolve);
      });
      port = (server.address() as AddressInfo).port;
      if (!overrides.clock) {
        timer = setInterval(() => advance(state, now()), 1000);
        timer.unref();
      }
      return { port, baseUrl: `http://${HOST}:${port}` };
    },
    async close() {
      if (timer) clearInterval(timer);
      timer = null;
      const s = server;
      server = null;
      if (!s) return;
      s.closeAllConnections();
      if (s.listening) await new Promise<void>((resolve) => s.close(() => resolve()));
    },
    setOffline(offline) {
      if (!server) return;
      if (offline) {
        server.closeAllConnections();
        if (server.listening) server.close();
      } else if (!server.listening) {
        server.listen(port, HOST);
      }
    },
    setPassword(password) {
      opts.password = password;
    },
    setStationCount(n) {
      opts.nStations = n;
      state.stations = makeStations(n, state.stations);
    },
    tick(ms) {
      offsetMs += ms;
      advance(state, now());
    },
  };
  return sim;
}
