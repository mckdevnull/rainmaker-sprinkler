import { createHash } from 'node:crypto';
import { ControllerRejected, ControllerUnauthorized, ControllerUnreachable } from './errors.js';
import { PollSuperseded, SerialQueue, type Priority } from './queue.js';
import type {
  ControllerConfig,
  JcResponse,
  JnResponse,
  JoResponse,
  JpResponse,
  JsResponse,
  LogEntry,
  PasswordMode,
  ProgramData,
  RequestOptions,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 1500;
const UNAUTHORIZED_BACKOFF_MS = 30_000;
const MAX_RAIN_DELAY_HOURS = 32767;
const RESULT_OK = 1;
const RESULT_UNAUTHORIZED = 2;
/** Endpoints that answer a wrong password with HTTP 200 and a body of only `{fwv}`. */
const FWV_ONLY_PATHS = new Set(['/jo', '/ja']);

interface Ctx {
  readonly queueSignal: AbortSignal;
  readonly userSignal?: AbortSignal;
  readonly deadlineAt?: number;
}
interface Reply {
  readonly status: number;
  readonly body: unknown;
}

const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const other = (m: PasswordMode): PasswordMode => (m === 'md5' ? 'plain' : 'md5');

export class ControllerClient {
  private mode: PasswordMode | 'unknown' = 'unknown';
  private backoffUntil = 0;
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly cfg: ControllerConfig,
    private readonly queue: SerialQueue = new SerialQueue(),
  ) {
    this.base = cfg.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get passwordMode(): PasswordMode | 'unknown' {
    return this.mode;
  }

  getOptions(o: RequestOptions = {}): Promise<JoResponse> {
    return this.read<JoResponse>('poll', o, '/jo', '');
  }
  getStatus(o: RequestOptions = {}): Promise<JcResponse> {
    return this.read<JcResponse>(o.confirm ? 'confirm' : 'poll', o, '/jc', '');
  }
  getStations(o: RequestOptions = {}): Promise<JsResponse> {
    return this.read<JsResponse>('poll', o, '/js', '');
  }
  getNames(o: RequestOptions = {}): Promise<JnResponse> {
    return this.read<JnResponse>('poll', o, '/jn', '');
  }
  getPrograms(o: RequestOptions = {}): Promise<JpResponse> {
    return this.read<JpResponse>('poll', o, '/jp', '');
  }

  async getLog(startLocalSec: number, endLocalSec: number, o: RequestOptions = {}): Promise<LogEntry[] | null> {
    const reply = await this.submit('poll', o, '/jl', `start=${startLocalSec}&end=${endLocalSec}`);
    if (reply.status === 404) return null;
    if (!Array.isArray(reply.body)) throw this.rejectedOrMalformed('/jl', reply.body);
    return reply.body as LogEntry[];
  }

  runStation(sid: number, seconds: number, o: RequestOptions = {}): Promise<void> {
    return this.command(o, '/cm', `sid=${sid}&en=1&t=${seconds}`);
  }
  stopStation(sid: number, o: RequestOptions = {}): Promise<void> {
    return this.command(o, '/cm', `sid=${sid}&en=0`);
  }
  stopAll(o: RequestOptions = {}): Promise<void> {
    return this.command(o, '/cv', 'rsn=1');
  }
  setRainDelayHours(hours: number, o: RequestOptions = {}): Promise<void> {
    const capped = Math.min(MAX_RAIN_DELAY_HOURS, Math.max(0, Math.floor(hours)));
    return this.command(o, '/cv', `rd=${capped}`);
  }
  setEnabled(enabled: boolean, o: RequestOptions = {}): Promise<void> {
    return this.command(o, '/cv', `en=${enabled ? 1 : 0}`);
  }
  setProgram(pid: number, data: ProgramData, o: RequestOptions = {}): Promise<void> {
    const [flag, days0, days1, starts, durs, name] = data;
    const v = JSON.stringify([flag, days0, days1, starts, durs]);
    return this.command(o, '/cp', `pid=${pid}&v=${encodeURIComponent(v)}&name=${encodeURIComponent(name)}`);
  }

  private async read<T>(priority: Priority, o: RequestOptions, path: string, query: string): Promise<T> {
    const reply = await this.submit(priority, o, path, query);
    if (!isRecord(reply.body) || 'result' in reply.body) throw this.rejectedOrMalformed(path, reply.body);
    return reply.body as T;
  }

  private async command(o: RequestOptions, path: string, query: string): Promise<void> {
    const { body } = await this.submit('command', o, path, query);
    if (!isRecord(body) || typeof body.result !== 'number') throw this.rejectedOrMalformed(path, body);
    if (body.result !== RESULT_OK) throw new ControllerRejected(body.result);
  }

  private rejectedOrMalformed(path: string, body: unknown): Error {
    if (isRecord(body) && typeof body.result === 'number') return new ControllerRejected(body.result);
    return new ControllerUnreachable(`unexpected response from ${this.base}${path}`);
  }

  /** Queue the request, bounding queue wait plus execution by the caller's deadline. */
  private submit(priority: Priority, o: RequestOptions, path: string, query: string): Promise<Reply> {
    const deadlineAt = o.deadlineMs === undefined ? undefined : Date.now() + o.deadlineMs;
    const run = this.queue.run(priority, (queueSignal) =>
      this.send({ queueSignal, userSignal: o.signal, deadlineAt }, path, query),
    );
    if (deadlineAt === undefined) return run;
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ControllerUnreachable(`deadline exceeded for ${this.base}${path}`)),
        Math.max(0, deadlineAt - Date.now()),
      );
    });
    run.catch(() => undefined); // the race may already have settled
    return Promise.race([run, expired]).finally(() => clearTimeout(timer));
  }

  private async send(ctx: Ctx, path: string, query: string): Promise<Reply> {
    if (Date.now() < this.backoffUntil) {
      throw new ControllerUnauthorized('controller password rejected; backing off before retrying');
    }
    if (this.mode === 'unknown') {
      const probe = await this.negotiate(ctx);
      if (path === '/jc') return probe;
    }
    const known = this.mode as PasswordMode;
    const first = await this.attempt(ctx, known, path, query);
    if (first) return first;
    const second = await this.attempt(ctx, other(known), path, query);
    if (second) {
      this.mode = other(known);
      return second;
    }
    throw this.denied();
  }

  /** Probe /jc with md5 first (2.1.7+), then plaintext (2.1.6). */
  private async negotiate(ctx: Ctx): Promise<Reply> {
    for (const mode of ['md5', 'plain'] as const) {
      const reply = await this.attempt(ctx, mode, '/jc', '');
      if (reply) {
        this.mode = mode;
        return reply;
      }
    }
    throw this.denied();
  }

  private denied(): ControllerUnauthorized {
    this.backoffUntil = Date.now() + UNAUTHORIZED_BACKOFF_MS;
    return new ControllerUnauthorized('controller rejected the password');
  }

  /** One request with the password in the given form; null when the controller says unauthorized. */
  private async attempt(ctx: Ctx, mode: PasswordMode, path: string, query: string): Promise<Reply | null> {
    const pw = encodeURIComponent(mode === 'md5' ? md5(this.cfg.password) : this.cfg.password);
    const reply = await this.fetchJson(ctx, path, `${query}${query ? '&' : ''}pw=${pw}`);
    return this.isUnauthorized(path, reply.body) ? null : reply;
  }

  private isUnauthorized(path: string, body: unknown): boolean {
    if (!isRecord(body)) return false;
    const keys = Object.keys(body);
    if (keys.length === 1 && body.result === RESULT_UNAUTHORIZED) return true;
    return FWV_ONLY_PATHS.has(path) && keys.length === 1 && keys[0] === 'fwv';
  }

  private async fetchJson(ctx: Ctx, path: string, query: string): Promise<Reply> {
    const where = `${this.base}${path}`;
    const budget = ctx.deadlineAt === undefined ? this.timeoutMs : Math.min(this.timeoutMs, ctx.deadlineAt - Date.now());
    if (budget <= 0) throw new ControllerUnreachable(`deadline exceeded for ${where}`);
    const signals = [AbortSignal.timeout(budget), ctx.queueSignal, ...(ctx.userSignal ? [ctx.userSignal] : [])];
    const signal = AbortSignal.any(signals);
    try {
      const res = await fetch(`${where}?${query}`, { signal });
      const text = await res.text();
      if (res.status === 404) return { status: 404, body: null };
      if (!res.ok) throw new ControllerUnreachable(`HTTP ${res.status} from ${where}`);
      try {
        return { status: res.status, body: JSON.parse(text) as unknown };
      } catch {
        throw new ControllerUnreachable(`invalid response from ${where}`);
      }
    } catch (err) {
      if (err instanceof ControllerUnreachable) throw err;
      if (ctx.queueSignal.aborted) throw new PollSuperseded();
      if (ctx.userSignal?.aborted) throw new ControllerUnreachable(`request to ${where} aborted`);
      throw new ControllerUnreachable(`${signal.aborted ? 'timed out' : 'unreachable'}: ${where}`);
    }
  }
}
