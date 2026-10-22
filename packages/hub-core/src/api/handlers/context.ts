import type { CommandResult, CommandSource } from '../../commands/commands.js';
import type { Hub } from '../../hub.js';
import { reqString, ValidationError } from '../../validate.js';

export interface ApiRequest {
  readonly params: Readonly<Record<string, string>>;
  /** Parsed JSON body ({} when empty) for JSON routes; undefined otherwise. */
  readonly body: unknown;
  /** Raw body for binary routes. */
  readonly raw: Buffer | null;
  readonly contentType: string;
}

export type ApiResponse =
  | { status: number; json: unknown }
  | { status: number; bytes: Buffer; contentType: string };

export type Handler = (hub: Hub, req: ApiRequest) => Promise<ApiResponse>;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const ok = (json: unknown, status = 200): ApiResponse => ({ status, json });

const SOURCES: readonly CommandSource[] = ['app', 'web', 'siri-intent', 'homekit', 'alexa'];

export function parseSource(v: unknown, fallback?: CommandSource): CommandSource {
  if (v === undefined && fallback) return fallback;
  const s = reqString(v, 'source');
  if (!(SOURCES as readonly string[]).includes(s)) {
    throw new ValidationError('source', `must be one of ${SOURCES.join(', ')}`);
  }
  return s as CommandSource;
}

function indexParam(raw: string | undefined, count: number, what: string): number {
  if (raw === undefined || !/^\d{1,4}$/.test(raw) || Number(raw) >= count) throw new HttpError(404, `no such ${what}`);
  return Number(raw);
}

export const zoneId = (hub: Hub, req: ApiRequest): number =>
  indexParam(req.params.id, hub.store.get().zones.length, 'zone');

export const scheduleId = (hub: Hub, req: ApiRequest): number =>
  indexParam(req.params.id, hub.store.get().schedules.length, 'schedule');

const FAILURE_STATUS: Record<string, number> = {
  offline: 503,
  timeout: 504,
  unauthorized: 502,
  rejected: 422,
  'not-applied': 502,
};

/** 200 with the result when ok; otherwise a 4xx/5xx carrying the same `{ok:false, error}` body. */
export const commandResponse = (r: CommandResult): ApiResponse =>
  ok(r, r.ok ? 200 : (FAILURE_STATUS[r.error] ?? 502));
