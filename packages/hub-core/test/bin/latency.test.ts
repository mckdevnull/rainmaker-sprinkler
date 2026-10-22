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

  it("fails (exit 1) against a slow controller", async () => {
    const t = await startHub({ sim: { responseDelayMs: 2000 } });
    const { exitCode, rows } = await runLatency({
      hub: t.url,
      token: t.token,
      zone: 0,
      runs: 1,
    });
    expect(exitCode).toBe(1);
    // Slow controller: confirmed p95 breaches the gate, or the runs are reported failed.
    const c = rows.find((r) => r.metric === "confirmed");
    expect((c?.p95 ?? Infinity) > 1500 || (c?.failed ?? 0) > 0).toBe(true);
  }, 60_000);

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
