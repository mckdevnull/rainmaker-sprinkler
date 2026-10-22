import type { ProgramData } from '../controller/types.js';

export type ZoneStatus = 'idle' | 'running' | 'queued' | 'unknown';
export interface Zone {
  id: number;
  name: string;
  status: ZoneStatus;
  remainingSec: number | null;
  lastRunAt: number | null;
}
export type ScheduleKind = 'weekly' | 'interval' | 'odd-days' | 'even-days';
export interface Schedule {
  id: number;
  name: string;
  enabled: boolean;
  weatherAdjust: boolean;
  kind: ScheduleKind;
  /** Weekly only (Mon..Sun); empty otherwise. */
  days: boolean[];
  /** Up to 4 entries, unused (-1) entries removed. */
  startMinutes: number[];
  zoneMinutes: Record<number, number>;
  pausedUntil: number | null;
  /** The untouched /jp entry; every write starts from this. */
  raw: ProgramData;
}
export interface ControllerState {
  online: boolean;
  unauthorized: boolean;
  lastSeenAt: number | null;
  /** Derived from devt each poll; 0 until the first poll. */
  tzOffsetSec: number;
  enabled: boolean;
  /** UTC ms. */
  rainDelayUntil: number | null;
  zones: Zone[];
  schedules: Schedule[];
  firmware: { fwv: number; hwv: number } | null;
}

const FLAG_ENABLED = 1;
const FLAG_WEATHER = 2;
const FLAG_ODD_EVEN = 4;
const FLAG_EVEN = 8;
const FLAG_INTERVAL = 16;

function kindOf(flag: number): ScheduleKind {
  if (flag & FLAG_ODD_EVEN) return flag & FLAG_EVEN ? 'even-days' : 'odd-days';
  if (flag & FLAG_INTERVAL) return 'interval';
  return 'weekly';
}

const cloneProgram = (pd: ProgramData): ProgramData => [pd[0], pd[1], pd[2], [...pd[3]], [...pd[4]], pd[5]];

export function programToSchedule(pid: number, pd: ProgramData): Schedule {
  const [flag, days0, , starts, durations, name] = pd;
  const kind = kindOf(flag);
  const zoneMinutes: Record<number, number> = {};
  durations.forEach((sec, sid) => {
    if (sec > 0) zoneMinutes[sid] = sec / 60;
  });
  return {
    id: pid,
    name,
    enabled: (flag & FLAG_ENABLED) !== 0,
    weatherAdjust: (flag & FLAG_WEATHER) !== 0,
    kind,
    days: kind === 'weekly' ? Array.from({ length: 7 }, (_, i) => (days0 & (1 << i)) !== 0) : [],
    startMinutes: starts.filter((m) => m >= 0),
    zoneMinutes,
    pausedUntil: null,
    raw: cloneProgram(pd),
  };
}

export function scheduleToProgram(s: Schedule): ProgramData {
  const out = cloneProgram(s.raw);
  let flag = out[0];
  flag = s.enabled ? flag | FLAG_ENABLED : flag & ~FLAG_ENABLED;
  flag = s.weatherAdjust ? flag | FLAG_WEATHER : flag & ~FLAG_WEATHER;
  out[0] = flag;
  return out;
}

export function localToUtcMs(localSec: number, tzOffsetSec: number): number {
  return (localSec - tzOffsetSec) * 1000;
}

export const emptyState: ControllerState = {
  online: false,
  unauthorized: false,
  lastSeenAt: null,
  tzOffsetSec: 0,
  enabled: true,
  rainDelayUntil: null,
  zones: [],
  schedules: [],
  firmware: null,
};
