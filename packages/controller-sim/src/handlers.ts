import { createHash } from 'node:crypto';
import type { SimOptions } from './index.js';
import { MANUAL_PID, enqueueRun, stopAll, stopStation, type SimProgram, type SimState } from './state.js';

const RESULT_OK = { result: 1 };
const RESULT_UNAUTHORIZED = { result: 2 };
const RESULT_DATA_MISSING = { result: 16 };
const RESULT_OUT_OF_RANGE = { result: 17 };
const RESULT_DATA_FORMAT = { result: 18 };
const RESULT_NOT_FOUND = { result: 32 };

const MAX_MANUAL_SEC = 64800;

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

function passwordOk(query: URLSearchParams, opts: SimOptions): boolean {
  const pw = query.get('pw');
  if (pw === null) return false;
  return pw === (opts.passwordMode === 'md5' ? md5(opts.password) : opts.password);
}

function intParam(query: URLSearchParams, key: string): number | null {
  const raw = query.get(key);
  if (raw === null || !/^-?\d+$/.test(raw)) return null;
  return Number(raw);
}

const localSec = (state: SimState, opts: SimOptions, ms: number) => Math.floor(ms / 1000) + opts.tzOffsetSec;
const boardCount = (opts: SimOptions) => Math.ceil(opts.nStations / 8);
const rainDelayActive = (state: SimState) => state.rainDelayUntil !== null && state.rainDelayUntil > state.lastMs;

function jc(state: SimState, opts: SimOptions) {
  const sbits = Array.from({ length: boardCount(opts) }, (_, b) =>
    state.stations.slice(b * 8, b * 8 + 8).reduce((acc, s, i) => (s.running ? acc | (1 << i) : acc), 0),
  );
  const start = new Map<number, number>();
  let cursor = state.current?.endMs ?? state.lastMs;
  if (state.current) start.set(state.current.sid, state.current.startMs);
  const remaining = new Map<number, number>();
  if (state.current) remaining.set(state.current.sid, state.stations[state.current.sid]?.remainingSec ?? 0);
  for (const q of state.queue) {
    if (!start.has(q.sid)) {
      start.set(q.sid, cursor);
      remaining.set(q.sid, q.sec);
    }
    cursor += q.sec * 1000;
  }
  const ps = state.stations.map((_, sid) =>
    start.has(sid) ? [MANUAL_PID, remaining.get(sid) ?? 0, localSec(state, opts, start.get(sid) ?? 0)] : [0, 0, 0],
  );
  const last = state.log.at(-1);
  return {
    devt: localSec(state, opts, state.lastMs),
    en: state.enabled ? 1 : 0,
    rd: rainDelayActive(state) ? 1 : 0,
    rdst: rainDelayActive(state) ? localSec(state, opts, state.rainDelayUntil ?? 0) : 0,
    sbits: [...sbits, 0],
    ps,
    nbrd: boardCount(opts),
    lrun: last ? [last.sid, last.pid, last.durSec, localSec(state, opts, last.endMs)] : [0, 0, 0, 0],
  };
}

const js = (state: SimState) => ({
  sn: state.stations.map((s) => (s.running ? 1 : 0)),
  nstations: state.stations.length,
});

const jn = (state: SimState) => ({ snames: state.stations.map((s) => s.name) });

const jo = (opts: SimOptions) => ({
  fwv: opts.fwv,
  hwv: opts.hwv,
  nbrd: boardCount(opts),
  ipas: 0,
  wl: 100,
  tz: Math.round(opts.tzOffsetSec / 900) + 48,
});

const jp = (state: SimState) => ({
  nprogs: state.programs.length,
  pd: state.programs.map((p) => [p.flag, p.days0, p.days1, p.starts, p.durs, p.name]),
});

function jl(query: URLSearchParams, state: SimState, opts: SimOptions) {
  const start = intParam(query, 'start');
  const end = intParam(query, 'end');
  if (start === null || end === null) return RESULT_DATA_MISSING;
  return state.log
    .map((e) => ({ e, endLocal: localSec(state, opts, e.endMs) }))
    .filter(({ endLocal }) => {
      const day = Math.floor(endLocal / 86400);
      return day >= start && day <= end;
    })
    .map(({ e, endLocal }) => [e.pid, e.sid, e.durSec, endLocal]);
}

function cm(query: URLSearchParams, state: SimState, opts: SimOptions) {
  const sid = intParam(query, 'sid');
  const en = intParam(query, 'en');
  if (sid === null || en === null) return RESULT_DATA_MISSING;
  if (sid < 0 || sid >= state.stations.length) return RESULT_OUT_OF_RANGE;
  if (opts.dropCommands) return RESULT_OK;
  if (en === 0) {
    stopStation(state, sid, state.lastMs);
    return RESULT_OK;
  }
  const t = intParam(query, 't');
  if (t === null) return RESULT_DATA_MISSING;
  if (t <= 0 || t > MAX_MANUAL_SEC) return RESULT_OUT_OF_RANGE;
  enqueueRun(state, sid, t, state.lastMs);
  return RESULT_OK;
}

function cv(query: URLSearchParams, state: SimState, opts: SimOptions) {
  if (opts.dropCommands) return RESULT_OK;
  const en = intParam(query, 'en');
  if (en !== null) state.enabled = en !== 0;
  const rd = intParam(query, 'rd');
  if (rd !== null) state.rainDelayUntil = rd > 0 ? state.lastMs + rd * 3600e3 : null;
  if (intParam(query, 'rsn') === 1) stopAll(state, state.lastMs);
  return RESULT_OK;
}

function parseProgram(raw: string, name: string): SimProgram | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(v) || v.length !== 5) return null;
  const [flag, days0, days1, starts, durs] = v as unknown[];
  const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);
  const intArray = (x: unknown): x is number[] => Array.isArray(x) && x.every(isInt);
  if (!isInt(flag) || !isInt(days0) || !isInt(days1) || !intArray(starts) || !intArray(durs)) return null;
  return { flag, days0, days1, starts, durs, name };
}

function cp(query: URLSearchParams, state: SimState) {
  const pid = intParam(query, 'pid');
  const v = query.get('v');
  if (pid === null || v === null) return RESULT_DATA_MISSING;
  if (pid < -1 || pid >= state.programs.length) return RESULT_OUT_OF_RANGE;
  const index = pid === -1 ? state.programs.length : pid;
  const program = parseProgram(v, query.get('name') ?? `Program ${index + 1}`);
  if (!program) return RESULT_DATA_FORMAT;
  state.programs[index] = program;
  return RESULT_OK;
}

export function handle(path: string, query: URLSearchParams, state: SimState, opts: SimOptions): unknown {
  if (!passwordOk(query, opts)) {
    return path === '/jo' || path === '/ja' ? { fwv: opts.fwv } : RESULT_UNAUTHORIZED;
  }
  switch (path) {
    case '/jc':
      return jc(state, opts);
    case '/js':
      return js(state);
    case '/jn':
      return jn(state);
    case '/jo':
      return jo(opts);
    case '/jp':
      return jp(state);
    case '/jl':
      return jl(query, state, opts);
    case '/ja':
      return { settings: jc(state, opts), programs: jp(state), options: jo(opts), status: js(state), stations: jn(state) };
    case '/cm':
      return cm(query, state, opts);
    case '/cv':
      return cv(query, state, opts);
    case '/cp':
      return cp(query, state);
    default:
      return RESULT_NOT_FOUND;
  }
}
