import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EMPTY_404, handle } from './handlers.js';
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
  /** False mimics a board without an SD card: /jl answers 404 with an empty body. */
  hasLog: boolean;
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
  hasLog: true,
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

  const serve = async (req: IncomingMessage, res: ServerResponse, closed: Promise<void>): Promise<void> => {
    if (res.destroyed) return; // client went away while queued
    await sleep(opts.responseDelayMs);
    if (res.destroyed) return;
    advance(state, now());
    const url = new URL(req.url ?? '/', 'http://controller');
    let status = 200;
    let body = '';
    try {
      const result = handle(url.pathname, url.searchParams, state, opts);
      if (result === EMPTY_404) status = 404;
      else body = JSON.stringify(result);
    } catch (err) {
      console.error('controller-sim handler error', err);
      status = 500;
      body = '{"result":0}';
    }
    res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(body);
    await closed;
  };

  const sim: Simulator = {
    state,
    requestCount: 0,
    async listen(requested = 0) {
      server = createServer((req, res) => {
        sim.requestCount += 1;
        // Register before queueing so an abort while waiting is never missed.
        const closed = new Promise<void>((resolve) => res.once('close', resolve));
        queue = queue.then(() => serve(req, res, closed)).catch(() => undefined);
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
