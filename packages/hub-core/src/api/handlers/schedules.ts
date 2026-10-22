import type { ProgramData } from '../../controller/types.js';
import type { Hub } from '../../hub.js';
import type { Schedule } from '../../state/model.js';
import {
  intKey,
  MAX_RUN_SECONDS,
  rejectUnknown,
  reqBool,
  reqInt,
  reqNumber,
  reqObject,
  reqString,
  ValidationError,
} from '../../validate.js';
import { commandResponse, ok, scheduleId, type Handler } from './context.js';

const MAX_DELAY_MS = 32767 * 3600e3;
const MAX_STARTS = 4;
const MINUTES_PER_DAY = 1440;
const MAX_PROGRAM_NAME = 32;
const FLAG_ENABLED = 1;
const FLAG_WEATHER = 2;
const READ_ONLY = ['kind', 'oddEven', 'fixedStartTimes'] as const;
const ALLOWED = ['id', 'name', 'enabled', 'weatherAdjust', 'days', 'startMinutes', 'zoneMinutes', 'raw', 'pausedUntil', ...READ_ONLY];

function parseUntil(body: unknown): number {
  const until = reqNumber(reqObject(body, 'body').until, 'until', 0, Number.MAX_SAFE_INTEGER);
  const now = Date.now();
  if (until <= now) throw new ValidationError('until', 'must be in the future');
  if (until > now + MAX_DELAY_MS) throw new ValidationError('until', 'is more than 32767 hours ahead');
  return until;
}

export const listSchedules: Handler = async (hub) => ok(hub.store.get().schedules);

export const pauseAll: Handler = async (hub, req) => commandResponse(await hub.pause.pauseAll(parseUntil(req.body)));
export const resumeAll: Handler = async (hub) => commandResponse(await hub.pause.resumeAll());

export const pauseSchedule: Handler = async (hub, req) => {
  const id = scheduleId(hub, req);
  return commandResponse(await hub.pause.pauseSchedule(id, parseUntil(req.body)));
};
export const resumeSchedule: Handler = async (hub, req) =>
  commandResponse(await hub.pause.resumeSchedule(scheduleId(hub, req)));

function parseDays(v: unknown, s: Schedule, days0: number): number {
  if (s.kind !== 'weekly') {
    if (v !== undefined && !(Array.isArray(v) && v.length === 0)) {
      throw new ValidationError('days', 'only applies to weekly schedules');
    }
    return days0;
  }
  if (!Array.isArray(v) || v.length !== 7) throw new ValidationError('days', 'must be 7 true/false values, Monday first');
  return v.reduce<number>((bits, d, i) => (reqBool(d, `days[${i}]`) ? bits | (1 << i) : bits), days0 & ~0x7f);
}

function parseStarts(v: unknown, s: Schedule, raw: number[]): number[] {
  if (!Array.isArray(v)) throw new ValidationError('startMinutes', 'must be a list of minutes after midnight');
  const max = s.fixedStartTimes ? MAX_STARTS : 1;
  if (v.length < 1 || v.length > max) {
    throw new ValidationError('startMinutes', s.fixedStartTimes ? 'must have 1 to 4 start times' : 'must have exactly 1 start time');
  }
  const starts = v.map((m, i) => {
    const field = `startMinutes[${i}]`;
    const n = reqInt(m, field, 0, 0xffff);
    // Values the controller already holds (e.g. sunrise-relative encodings) may be sent back unchanged.
    if (n >= MINUTES_PER_DAY && !raw.includes(n)) throw new ValidationError(field, 'must be between 0 and 1439');
    return n;
  });
  if (s.fixedStartTimes) return [...starts, ...Array<number>(MAX_STARTS - starts.length).fill(-1)];
  return raw.map((m, i) => (i === 0 ? (starts[0] as number) : m));
}

function parseDurations(v: unknown, zoneCount: number): number[] {
  const o = reqObject(v, 'zoneMinutes');
  const durations = Array<number>(zoneCount).fill(0);
  for (const [key, minutes] of Object.entries(o)) {
    const field = `zoneMinutes.${key}`;
    const id = intKey(key, field);
    if (id >= zoneCount) throw new ValidationError(field, 'is not a zone on this controller');
    durations[id] = Math.round(reqNumber(minutes, field, 0, MAX_RUN_SECONDS / 60) * 60);
  }
  return durations;
}

/** Builds the new program from the controller's raw copy plus the editable fields. */
export function scheduleBodyToProgram(body: unknown, s: Schedule, zoneCount: number): ProgramData {
  const o = reqObject(body, 'body');
  rejectUnknown(o, ALLOWED);
  if (o.id !== undefined && o.id !== s.id) throw new ValidationError('id', 'does not match the URL');
  for (const key of READ_ONLY) {
    if (o[key] !== undefined && o[key] !== s[key]) throw new ValidationError(key, 'is read-only');
  }
  const [flag, days0, days1, starts] = s.raw;
  const enabled = reqBool(o.enabled, 'enabled');
  const weatherAdjust = reqBool(o.weatherAdjust, 'weatherAdjust');
  let nextFlag = enabled ? flag | FLAG_ENABLED : flag & ~FLAG_ENABLED;
  nextFlag = weatherAdjust ? nextFlag | FLAG_WEATHER : nextFlag & ~FLAG_WEATHER;
  return [
    nextFlag,
    parseDays(o.days, s, days0),
    days1,
    parseStarts(o.startMinutes, s, starts),
    parseDurations(o.zoneMinutes, zoneCount),
    reqString(o.name, 'name', { min: 1, max: MAX_PROGRAM_NAME }),
  ];
}

export const putSchedule: Handler = async (hub: Hub, req) => {
  const id = scheduleId(hub, req);
  const { schedules, zones } = hub.store.get();
  const s = schedules[id] as Schedule;
  const data = scheduleBodyToProgram(req.body, s, zones.length || s.raw[4].length);
  const result = await hub.updateSchedule(id, data);
  if (!result.ok) return commandResponse(result);
  return ok(hub.store.get().schedules[id]);
};
