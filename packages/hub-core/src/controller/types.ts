export type PasswordMode = 'plain' | 'md5';

export interface ControllerConfig {
  baseUrl: string;
  password: string;
  /** Per-request timeout; default 1500. */
  timeoutMs?: number;
}

export interface JcResponse {
  devt: number;
  en: 0 | 1;
  rd: 0 | 1;
  rdst: number;
  sbits: number[];
  ps: [number, number, number][];
  nbrd: number;
  lrun: [number, number, number, number];
}
export interface JsResponse {
  sn: (0 | 1)[];
  nstations: number;
}
export interface JoResponse {
  fwv: number;
  hwv: number;
  nbrd: number;
  ipas: 0 | 1;
  wl: number;
  tz: number;
}
export interface JnResponse {
  snames: string[];
}
export interface JpResponse {
  nprogs: number;
  pd: ProgramData[];
}
/** flag, days0, days1, starts, durations, name */
export type ProgramData = [number, number, number, number[], number[], string];
/** pid, sid, durSec, endTsLocal */
export type LogEntry = [number, number, number, number];

export interface RequestOptions {
  /** Absolute budget from the call, queue wait included; overrides timeoutMs. */
  deadlineMs?: number;
  signal?: AbortSignal;
  /** Run a read at 'confirm' priority instead of 'poll'. */
  confirm?: boolean;
}
