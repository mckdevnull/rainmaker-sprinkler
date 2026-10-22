/** Station id used by the firmware for manually started runs. */
export const MANUAL_PID = 99;

export interface SimProgram {
  flag: number;
  days0: number;
  days1: number;
  starts: number[];
  durs: number[];
  name: string;
}

export interface LogEntry {
  pid: number;
  sid: number;
  durSec: number;
  /** UTC milliseconds; converted to controller-local seconds on output. */
  endMs: number;
}

export interface ActiveRun {
  sid: number;
  startMs: number;
  endMs: number;
}

export interface SimState {
  enabled: boolean;
  rainDelayUntil: number | null;
  stations: { name: string; running: boolean; remainingSec: number }[];
  queue: { sid: number; sec: number }[];
  programs: SimProgram[];
  log: LogEntry[];
  /** The station currently running, with absolute times. */
  current: ActiveRun | null;
  /** Hub time (ms) of the last `advance`; handlers use it as "now". */
  lastMs: number;
}

export function makeStations(n: number, existing: SimState['stations'] = []): SimState['stations'] {
  return Array.from({ length: n }, (_, i) =>
    existing[i] ?? { name: `S${String(i + 1).padStart(2, '0')}`, running: false, remainingSec: 0 },
  );
}

export function createState(nowMs: number, nStations: number): SimState {
  return {
    enabled: true,
    rainDelayUntil: null,
    stations: makeStations(nStations),
    queue: [],
    programs: [
      {
        flag: 1,
        days0: 127,
        days1: 0,
        starts: [360, -1, -1, -1],
        durs: Array.from({ length: nStations }, () => 300),
        name: 'Morning',
      },
    ],
    log: [],
    current: null,
    lastMs: nowMs,
  };
}

function finishCurrent(state: SimState, atMs: number): void {
  const run = state.current;
  if (!run) return;
  const station = state.stations[run.sid];
  if (station) {
    station.running = false;
    station.remainingSec = 0;
  }
  state.log.push({
    pid: MANUAL_PID,
    sid: run.sid,
    durSec: Math.round((atMs - run.startMs) / 1000),
    endMs: atMs,
  });
  state.current = null;
}

function startNext(state: SimState, atMs: number): void {
  const next = state.queue.shift();
  if (!next) return;
  const station = state.stations[next.sid];
  if (station) station.running = true;
  state.current = { sid: next.sid, startMs: atMs, endMs: atMs + next.sec * 1000 };
}

/** Move simulated time forward: finish elapsed runs, start queued ones, expire rain delay. */
export function advance(state: SimState, nowMs: number): void {
  while (state.current && nowMs >= state.current.endMs) {
    const endedAt = state.current.endMs;
    finishCurrent(state, endedAt);
    startNext(state, endedAt);
  }
  if (state.current) {
    const station = state.stations[state.current.sid];
    if (station) station.remainingSec = Math.ceil((state.current.endMs - nowMs) / 1000);
  }
  if (state.rainDelayUntil !== null && nowMs >= state.rainDelayUntil) state.rainDelayUntil = null;
  state.lastMs = nowMs;
}

/** Run a station now if idle, otherwise append to the sequential queue. */
export function enqueueRun(state: SimState, sid: number, sec: number, nowMs: number): void {
  state.queue.push({ sid, sec });
  if (!state.current) {
    startNext(state, nowMs);
    advance(state, nowMs);
  }
}

export function stopStation(state: SimState, sid: number, nowMs: number): void {
  if (state.current?.sid === sid) {
    finishCurrent(state, nowMs);
    startNext(state, nowMs);
    advance(state, nowMs);
  } else {
    state.queue = state.queue.filter((q) => q.sid !== sid);
  }
}

export function stopAll(state: SimState, nowMs: number): void {
  state.queue = [];
  finishCurrent(state, nowMs);
}
