#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

const USAGE = `usage:
  rainmaker-latency --hub <url> --token <token> [--zone 0] [--runs 10]`;

const GATE_MS = 1500;
const CAP_MS = 5000;
const RUN_SECONDS = 5;

export interface LatencyOptions {
  hub: string;
  token: string;
  zone: number;
  runs: number;
  fetchImpl?: typeof fetch;
}

export type Metric = "api-ack" | "confirmed" | "ws-state";

export interface LatencyRow {
  metric: Metric;
  p50: number | null;
  p95: number | null;
  /** Runs that produced a value. */
  samples: number;
  /** Runs with ok:false / transport failure (api-ack, confirmed) or no WS frame in time (ws-state). */
  failed: number;
}

export interface LatencyResult {
  rows: LatencyRow[];
  exitCode: 0 | 1;
}

/** Parses argv; throws a message naming the problem (callers print usage and exit 2). */
export function parseLatencyArgs(argv: readonly string[]): LatencyOptions {
  const v: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    const m = /^--(hub|token|zone|runs)(?:=(.*))?$/.exec(a);
    if (!m?.[1]) throw new Error(`unknown argument: ${a}`);
    v[m[1]] = m[2] ?? argv[++i];
  }
  if (!v.hub) throw new Error("--hub <url> is required");
  if (!v.token) throw new Error("--token <token> is required");
  const zone = Number(v.zone ?? 0);
  const runs = Number(v.runs ?? 10);
  if (!Number.isInteger(zone) || zone < 0)
    throw new Error("--zone must be a non-negative integer");
  if (!Number.isInteger(runs) || runs < 1)
    throw new Error("--runs must be a positive integer");
  return { hub: v.hub, token: v.token, zone, runs };
}

/** Nearest-rank percentile of a sorted list. */
function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
}

type Status = string | undefined;

/** One authenticated WebSocket tracking the status of a single zone. */
class StateWatcher {
  status: Status;
  private listeners = new Set<(s: Status) => void>();

  private constructor(
    private readonly ws: WebSocket,
    private readonly zone: number,
  ) {
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          type?: string;
          state?: { zones?: { status?: string }[] };
        };
        if (msg.type !== "state") return;
        this.status = msg.state?.zones?.[zone]?.status;
        for (const l of [...this.listeners]) l(this.status);
      } catch {
        /* ignore malformed frames */
      }
    });
  }

  static async open(
    hub: string,
    token: string,
    zone: number,
  ): Promise<StateWatcher> {
    const ws = new WebSocket(`${hub.replace(/^http/, "ws")}/v1/ws`);
    const w = new StateWatcher(ws, zone);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("WebSocket: no state frame after auth")),
        CAP_MS,
      );
      const done = (err?: Error) => {
        clearTimeout(timer);
        w.listeners.delete(onFrame);
        if (err) reject(err);
        else resolve();
      };
      const onFrame = () => done();
      w.listeners.add(onFrame);
      ws.once("open", () => ws.send(JSON.stringify({ type: "auth", token })));
      ws.once("error", (e) => done(e));
      ws.once("close", () => done(new Error("WebSocket closed (bad token?)")));
    });
    return w;
  }

  /** Resolves ms until a NEW frame satisfies `pred` (or `now` if already true), null on timeout. */
  waitFor(
    pred: (s: Status) => boolean,
    since: number,
    checkCurrent = false,
  ): Promise<number | null> {
    if (checkCurrent && pred(this.status))
      return Promise.resolve(performance.now() - since);
    return new Promise((resolve) => {
      const finish = (v: number | null) => {
        clearTimeout(timer);
        this.listeners.delete(onFrame);
        resolve(v);
      };
      const onFrame = (s: Status) =>
        pred(s) && finish(performance.now() - since);
      const timer = setTimeout(() => finish(null), CAP_MS);
      this.listeners.add(onFrame);
    });
  }

  close(): void {
    this.ws.terminate();
  }
}

interface Sample {
  ack: number | null;
  confirmed: number | null;
  wsState: number | null;
  failed: boolean;
}

async function oneRun(
  o: LatencyOptions,
  w: StateWatcher,
  f: typeof fetch,
): Promise<Sample> {
  const headers = {
    Authorization: `Bearer ${o.token}`,
    "Content-Type": "application/json",
  };
  const base = `${o.hub.replace(/\/+$/, "")}/v1/zones/${o.zone}`;
  const t0 = performance.now();
  const seen = w.waitFor((s) => s === "running" || s === "queued", t0);
  const sample: Sample = {
    ack: null,
    confirmed: null,
    wsState: null,
    failed: false,
  };
  try {
    const res = await f(`${base}/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        seconds: RUN_SECONDS,
        source: "app",
        force: true,
      }),
    });
    sample.ack = performance.now() - t0;
    const body = (await res.json()) as { ok?: boolean; confirmedInMs?: number };
    if (res.ok && body.ok === true && typeof body.confirmedInMs === "number")
      sample.confirmed = body.confirmedInMs;
    else sample.failed = true;
  } catch {
    sample.failed = true;
  }
  sample.wsState = await seen;
  try {
    const stopAt = performance.now();
    await f(`${base}/stop`, { method: "POST", headers });
    await w.waitFor((s) => s === "idle", stopAt, true);
  } catch {
    /* the next run will report any real problem */
  }
  return sample;
}

function row(metric: Metric, values: (number | null)[]): LatencyRow {
  const ok = values
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b);
  return {
    metric,
    p50: percentile(ok, 50),
    p95: percentile(ok, 95),
    samples: ok.length,
    failed: values.length - ok.length,
  };
}

export async function runLatency(opts: LatencyOptions): Promise<LatencyResult> {
  const f = opts.fetchImpl ?? fetch;
  const watcher = await StateWatcher.open(
    opts.hub.replace(/\/+$/, ""),
    opts.token,
    opts.zone,
  );
  const samples: Sample[] = [];
  try {
    for (let i = 0; i < opts.runs; i++)
      samples.push(await oneRun(opts, watcher, f));
  } finally {
    watcher.close();
  }
  const rows = [
    row(
      "api-ack",
      samples.map((s) => s.ack),
    ),
    row(
      "confirmed",
      samples.map((s) => s.confirmed),
    ),
    row(
      "ws-state",
      samples.map((s) => s.wsState),
    ),
  ];
  const confirmed = rows[1];
  const anyFailed = samples.some((s) => s.failed);
  const exitCode = anyFailed || (confirmed?.p95 ?? Infinity) > GATE_MS ? 1 : 0;
  return { rows, exitCode };
}

export function formatTable(rows: readonly LatencyRow[]): string {
  const ms = (n: number | null) => (n === null ? "-" : String(Math.round(n)));
  const lines = [
    "metric      p50 (ms)  p95 (ms)  samples  failed/missed",
    ...rows.map(
      (r) =>
        `${r.metric.padEnd(11)} ${ms(r.p50).padStart(8)}  ${ms(r.p95).padStart(8)}  ${String(r.samples).padStart(7)}  ${String(r.failed).padStart(13)}`,
    ),
    `gate: p95 confirmed <= ${GATE_MS} ms and no failed run`,
  ];
  return lines.join("\n");
}

async function main(): Promise<void> {
  let opts: LatencyOptions;
  try {
    opts = parseLatencyArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    process.exit(2);
  }
  const { rows, exitCode } = await runLatency(opts);
  console.log(formatTable(rows));
  console.log(exitCode === 0 ? "PASS" : "FAIL");
  process.exit(exitCode);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  main().catch((err: unknown) => {
    console.error(
      `rainmaker-latency: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
}
