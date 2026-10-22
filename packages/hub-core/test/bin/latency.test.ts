import { afterEach, describe, expect, it } from "vitest";
import {
  parseLatencyArgs,
  runLatency,
} from "../../src/bin/rainmaker-latency.js";
import { startHub, stopHubs } from "../api/helpers.js";

afterEach(stopHubs);

describe("rainmaker-latency", () => {
  it("passes (exit 0) against a fast controller", async () => {
    const t = await startHub({ sim: { responseDelayMs: 150 } });
    const { rows, exitCode } = await runLatency({
      hub: t.url,
      token: t.token,
      zone: 0,
      runs: 3,
    });
    const confirmed = rows.find((r) => r.metric === "confirmed");
    expect(exitCode).toBe(0);
    expect(confirmed?.p95).toBeLessThan(1500);
    expect(rows.map((r) => r.metric)).toEqual([
      "api-ack",
      "confirmed",
      "ws-state",
    ]);
    expect(rows.every((r) => r.failed === 0 && r.samples === 3)).toBe(true);
  }, 30_000);

  it("fails (exit 1) when confirmed is ok:true but slower than the gate", async () => {
    const t = await startHub({ sim: { responseDelayMs: 150 } });
    const slowConfirm = (async (
      input: string | URL,
      init?: RequestInit,
    ) => {
      const res = await fetch(input, init);
      const body = (await res
        .clone()
        .json()
        .catch(() => null)) as { ok?: boolean } | null;
      if (body?.ok !== true) return res;
      return new Response(JSON.stringify({ ...body, confirmedInMs: 2000 }), {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const { exitCode, rows } = await runLatency({
      hub: t.url,
      token: t.token,
      zone: 0,
      runs: 2,
      fetchImpl: slowConfirm,
    });
    const c = rows.find((r) => r.metric === "confirmed");
    expect(c?.failed).toBe(0);
    expect(c?.p95).toBeGreaterThan(1500);
    expect(exitCode).toBe(1);
  }, 30_000);

  it("fails (exit 1) and reports failed runs against a 2 s controller", async () => {
    const t = await startHub({ sim: { responseDelayMs: 2000 } });
    const { exitCode, rows } = await runLatency({
      hub: t.url,
      token: t.token,
      zone: 0,
      runs: 1,
    });
    expect(exitCode).toBe(1);
    expect(rows.find((r) => r.metric === "confirmed")?.failed).toBeGreaterThan(
      0,
    );
  }, 60_000);

  it("reports an unreachable hub clearly", async () => {
    await expect(
      runLatency({ hub: "http://127.0.0.1:1", token: "T", zone: 0, runs: 1 }),
    ).rejects.toThrow(/cannot reach hub http:\/\/127\.0\.0\.1:1/);
  });

  it("parses flags with defaults and rejects a missing hub/token", () => {
    expect(parseLatencyArgs(["--hub", "http://h:1", "--token=T"])).toEqual({
      hub: "http://h:1",
      token: "T",
      zone: 0,
      runs: 10,
    });
    expect(() => parseLatencyArgs(["--token", "T"])).toThrow(/--hub/);
    expect(() => parseLatencyArgs(["--hub", "x"])).toThrow(/--token/);
  });
});
