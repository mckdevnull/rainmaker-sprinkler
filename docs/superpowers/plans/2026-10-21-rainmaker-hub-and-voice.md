# Rainmaker Hub and Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Node.js hub that is the only client of an OpenSprinkler v2 controller, plus a Homebridge plugin that exposes zones, pause and system switches to Siri and (via homebridge-alexa) Alexa, with measured command latency.

**Architecture:** An npm-workspaces monorepo. `packages/controller-sim` fakes a v2 controller's HTTP API (one client at a time, both password formats) so everything is testable without hardware. `packages/hub-core` holds a serialized controller client, a polled state cache, commands with optimistic confirm, pause-until scheduling, weather and warnings, a watchdog with smart-plug recovery, and a local HTTP+WebSocket API. `packages/homebridge-rainmaker` wraps hub-core as a Homebridge platform plugin and publishes HomeKit accessories.

**Tech Stack:** Node.js 20+, TypeScript 5, vitest, `ws`, `bonjour-service`, Homebridge 1.8/2.x plugin API (`homebridge` types), no framework for HTTP (node `http`).

**Spec:** `docs/superpowers/specs/2026-10-21-rainmaker-design.md` (sections 5.1, 5.2, 5.3, 5.6, 5.7, 6, 7, 8 phases 0–2, 9). This plan does not cover the iOS app (§5.4) or the web page (§5.5); those get their own plans.

## Global Constraints

- Node.js `>=20`. TypeScript strict mode. MIT licence header not required per file; `LICENSE` at the repo root covers it.
- **At most one in-flight HTTP request to the controller at any time**, across the whole hub (spec §3, §5.1).
- Support firmware **2.1.6 through 2.2.1(4)**. Password: try MD5-hex `pw` first; on `{"result":2}` retry plaintext once and remember the mode (spec §5.1, §5.4). **Negotiate on `/jc`, never on `/jo` or `/ja`:** those two answer a wrong password with `{"fwv":N}` and HTTP 200 (firmware 2.1.7 `server.cpp` dispatch), so a `/jo` reply that contains only `fwv` means *unauthorized*.
- **Controller clocks are local time.** `devt`, `rdst`, log end times and `/jl` ranges are seconds in the controller's configured timezone (`os.now_tz()`), not UTC. The hub derives `tzOffsetSec = round((devt - nowUtcSec) / 900) * 900` on every `/jc` and converts with it. Hub-side timestamps are always UTC ms.
- **Program data is round-tripped losslessly.** `/jp` entries are `[flag, days0, days1, [starts], [durations], name]`; the `flag` byte packs enable (bit 0), weather-adjust (bit 1), odd/even and interval type bits. `/cp` must always resend `name` and the untouched `flag` bits except the one being changed.
- **End-to-end command deadline 3000 ms**, measured from the API call, covering queue wait, the request and the confirmation read.
- **The controller password never leaves the hub** (spec §5.1): it is never in API responses, logs, WebSocket events or error messages.
- Commands preempt status polls (spec §5.1, §6).
- Latency targets (spec §6): app/web command → confirmed ≤ 1.5 s on LAN; offline failure reported ≤ 3 s.
- Spec §4 decisions: manual runs still work while the system is off; zones run in the controller's fixed order; voice commands never trigger warnings.
- Naming: the product is "Rainmaker". Say "works with OpenSprinkler controllers". Never present it as OpenSprinkler.
- Commits: conventional format (`feat:`, `fix:`, `test:`, `docs:`, `chore:`), no attribution lines. Author is the repo's configured no-reply identity.
- No personal data in the repo: no real IPs, passwords, emails or home-network details, including in tests and docs.

## Review Focus

1. **Password change on the controller while the hub runs:** every call starts returning `{"result":2}`. Expected: the client re-negotiates once, then marks the controller `unauthorized` and stops hammering it; commands fail fast with "controller rejected password". Test pinned in Task 2.
2. **Fewer stations than before** (an expansion board unplugged): `/js` returns a shorter `sn` array. Expected: the state shrinks, the API and HomeKit stop advertising the missing zones, nothing throws. Test pinned in Task 3 and Task 9.
3. **Controller goes offline mid-run:** polls fail while a zone was running. Expected: `online=false`, the zone state becomes `unknown`, not `running`, and the remaining time stops counting down. Test pinned in Task 3.
4. **Pause-until past the controller's maximum** (rain delay max 32767 h): the user picks a date 5 years out. Expected: the hub sets 32767 h and re-applies when it expires, so the pause holds until the date. Test pinned in Task 5.
5. **Power-cycle loop:** the controller is really dead, and the plug keeps cycling it. Expected: at most one cycle per 10 min and at most 3 per hour, then a `recovery-exhausted` event and an offline notification. Test pinned in Task 7.

---

### Task 0: Phase 0 owner checklist (no code)

**Files:** Create `docs/guides/phase-0-controller-prep.md`

This is the manual prep from spec §7 and §8. The owner does it; the plan records it so nothing is lost.

- [ ] **Step 1: Write the checklist** with these items, in this order:
  1. On the stock web UI, export the configuration (Settings → Export). Save the file outside the repo.
  2. Record the controller's LAN IP and current password in the owner's password manager, not in the repo.
  3. Set the Windows 11 PC to never sleep (Settings → System → Power).
  4. Plug the controller's transformer into the smart plug. Add the plug to the Home app. Name it "Sprinkler Controller Power".
  5. In Vera, remove the OpenSprinkler devices from the HomeKit bridge (or hide them) so zones don't appear twice.
  6. Optional, later: firmware 2.1.7 flash per spec §7. Not needed for Rainmaker.
- [ ] **Step 2: Commit**

```bash
git add docs/guides/phase-0-controller-prep.md
git commit -m "docs: phase 0 controller prep checklist"
```

---

### Task 1: Controller simulator

**Files:**
- Create: `package.json` (root, workspaces: `packages/*`), `tsconfig.base.json`, `vitest.workspace.ts`, `.editorconfig`
- Create: `packages/controller-sim/package.json`, `packages/controller-sim/tsconfig.json`
- Create: `packages/controller-sim/src/index.ts`, `packages/controller-sim/src/state.ts`, `packages/controller-sim/src/handlers.ts`
- Test: `packages/controller-sim/test/sim.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PasswordMode = 'plain' | 'md5';
  export interface SimOptions {
    password: string;            // default 'opendoor'
    passwordMode: PasswordMode;  // 'plain' mimics 2.1.6, 'md5' mimics ≥2.1.7
    nStations: number;           // default 8
    fwv: number;                 // default 216
    hwv: number;                 // default 22
    responseDelayMs: number;     // default 150, applied to every request
    tzOffsetSec: number;         // default -21600; controller-local = UTC + offset
    dropCommands: boolean;       // default false; true acks /cm and /cv with result:1 but changes nothing
    clock?: () => number;        // ms since epoch; default Date.now
  }
  export interface Simulator {
    listen(port?: number): Promise<{ port: number; baseUrl: string }>;
    close(): Promise<void>;
    state: SimState;             // mutable, for tests
    setOffline(offline: boolean): void;   // true = refuse connections
    setPassword(password: string): void;
    setStationCount(n: number): void;
    requestCount: number;
    tick(ms: number): void;      // advance the internal clock when `clock` is injected
  }
  export function createSimulator(opts?: Partial<SimOptions>): Simulator;
  ```
- `SimState` in `state.ts`: `{ enabled: boolean; rainDelayUntil: number | null; stations: { name: string; running: boolean; remainingSec: number }[]; queue: { sid: number; sec: number }[]; programs: SimProgram[]; log: LogEntry[] }`.
- Endpoints, matching firmware 2.1.7 `server.cpp` (research doc `docs/research/firmware-and-hardware.md` §4): `/jo`, `/jc`, `/js`, `/jn`, `/jp`, `/jl`, `/cm`, `/cv`, `/cp`. Every one requires `pw`. Wrong `pw` → `{"result":2}` **except `/jo` and `/ja`, which return `{"fwv":<fwv>}` with HTTP 200**. Success for commands → `{"result":1}`.
- `SimOptions.tzOffsetSec` (default `-6*3600`): all controller-side times are `Math.floor(clock()/1000) + tzOffsetSec`.
- Behaviour to model: **one request at a time** (a second concurrent socket waits until the first response is sent); stations run **sequentially** (a `/cm` while one runs appends to `queue`); `/cv?rsn=1` stops everything; `/cv?rd=H` sets `rainDelayUntil = now + H*3600e3` (hub ms) and reports `rdst` as controller-local seconds; `/cv?en=0|1` sets `enabled`; `/cm` works even when `enabled=false`; `/jc` returns `{devt, en, rd, rdst, sbits, ps, nbrd, lrun}`; `/js` returns `{sn, nstations}`; `/jn` returns `{snames}`; `/jo` returns `{fwv, hwv, nbrd, ipas, wl, tz}`; `/jp` returns `{nprogs, pd: [[flag, days0, days1, [start0..3], [dur..], "name"], ...]}` where enable is bit 0 of `flag` and weather-adjust bit 1; `/cp?pid=&v=[flag,days0,days1,[starts],[durs]]&name=` replaces that program, and **omitting `name` renames it to `Program N`** (firmware behaviour); `/jl?start=&end=` takes **controller-local seconds** (the firmware divides by 86400 to get day numbers) or `/jl?hist=N` for the past N days, and returns `[[pid, sid, durSec, endTsLocal], ...]`. With `SimOptions.hasLog: false` (default `true`), `/jl` returns HTTP 404 with an empty body, as the firmware does on a board without an SD card (v2.0–v2.2).

- [ ] **Step 1: Scaffold the monorepo** (root `package.json` with `"workspaces": ["packages/*"]`, scripts `test: vitest run`, `build: tsc -b`, `lint: eslint .`; `tsconfig.base.json` with `strict`, `module: NodeNext`, `target: ES2022`; devDeps `typescript`, `vitest`, `eslint`, `@types/node`). Run `npm install` and `npm test` → vitest reports no test files, exit 0.

- [ ] **Step 2: Write the failing tests** in `packages/controller-sim/test/sim.test.ts`:
  - `rejects wrong password with result 2`: GET `/jc?pw=nope` → body `{"result":2}`.
  - `jo with wrong password returns only fwv`: GET `/jo?pw=nope` → HTTP 200, body exactly `{"fwv":216}`.
  - `cp without name renames the program`: `/cp?pid=0&v=[...]` with no `name` → `/jp` shows `"Program 1"`; with `name=Lawn` keeps `Lawn`.
  - `times are controller-local`: `tzOffsetSec: -21600`; `/jc.devt === floor(clock()/1000) - 21600`.
  - `plain mode accepts plaintext, md5 mode accepts md5 hex`: two simulators, same password; assert `/jo` returns `fwv` under the right form and `{"result":2}` under the other.
  - `serves one request at a time`: `responseDelayMs: 300`; fire two `/js` concurrently; assert the second resolves ≥ 250 ms after the first.
  - `cm runs a station and queues a second`: `/cm?sid=0&en=1&t=60` then `/cm?sid=1&en=1&t=30`; `state.stations[0].running === true`, `state.queue` equals `[{sid:1, sec:30}]`; `tick(60_000)` → station 1 running.
  - `cm works while disabled`: `/cv?en=0` then `/cm?sid=2&en=1&t=10` → station 2 running.
  - `rsn stops everything`: after the above, `/cv?rsn=1` → no station running, queue empty.
  - `rd sets rain delay in hours`: `/cv?rd=48` → `rainDelayUntil === clock()+48*3600e3`; `/jc` has `rd:1` and `rdst` equal to that timestamp in seconds.
  - `setOffline refuses connections`: `setOffline(true)` → fetch rejects with ECONNREFUSED (or times out ≤ 1 s).
  - `cp toggles program enable bit`: `/cp?pid=0&v=[0,...]` → `/jp` shows `flag & 1 === 0`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run packages/controller-sim`
Expected: FAIL, "createSimulator is not a function" or module not found.

- [ ] **Step 4: Implement `createSimulator`** in `src/index.ts` using node `http`. Serialize with a promise chain so the second request's handler starts only after the first response ends. Put per-endpoint logic in `handlers.ts` as `handle(path: string, query: URLSearchParams, state: SimState, opts: SimOptions): unknown`. Keep station timing in `state.ts` as `advance(state, nowMs)` driven by `tick` or a 1 s `setInterval` when no clock is injected.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/controller-sim`
Expected: PASS, 12 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.base.json vitest.workspace.ts .editorconfig packages/controller-sim
git commit -m "feat(sim): controller simulator with single-client and password modes"
```

---

### Task 2: Controller client with serialized priority queue

**Files:**
- Create: `packages/hub-core/package.json`, `packages/hub-core/tsconfig.json`
- Create: `packages/hub-core/src/controller/client.ts`, `packages/hub-core/src/controller/queue.ts`, `packages/hub-core/src/controller/types.ts`, `packages/hub-core/src/controller/errors.ts`
- Test: `packages/hub-core/test/controller/queue.test.ts`, `packages/hub-core/test/controller/client.test.ts`

**Interfaces:**
- Consumes: `createSimulator` from Task 1 (as a devDependency `@rainmaker/controller-sim`).
- Produces:
  ```ts
  // queue.ts
  export class PollSuperseded extends Error {}
  export class SerialQueue {
    constructor(opts?: { maxPollBacklog?: number }); // default 1: a new poll replaces a waiting poll
    run<T>(priority: Priority, fn: (signal: AbortSignal) => Promise<T>): Promise<T>;
    // 'command' and 'confirm' are never superseded; a queued command aborts the in-flight poll's signal
    readonly inFlight: boolean;
  }
  export type Priority = 'command' | 'confirm' | 'poll';
  // types.ts
  export interface ControllerConfig { baseUrl: string; password: string; timeoutMs?: number /* default 1500 */; }
  export interface JcResponse { devt: number; en: 0|1; rd: 0|1; rdst: number; sbits: number[]; ps: [number, number, number][]; nbrd: number; lrun: [number, number, number, number]; }
  export interface JsResponse { sn: (0|1)[]; nstations: number; }
  export interface JoResponse { fwv: number; hwv: number; nbrd: number; ipas: 0|1; wl: number; tz: number; }
  export interface JnResponse { snames: string[]; }
  export interface JpResponse { nprogs: number; pd: ProgramData[]; }
  export type ProgramData = [number, number, number, number[], number[], string]; // flag, days0, days1, starts, durations, name
  export type LogEntry = [number, number, number, number];   // pid, sid, durSec, endTsLocal
  export interface RequestOptions { deadlineMs?: number; signal?: AbortSignal; confirm?: boolean }  // deadline overrides timeoutMs; confirm → 'confirm' priority
  // errors.ts
  export class ControllerUnreachable extends Error {}
  export class ControllerUnauthorized extends Error {}
  export class ControllerRejected extends Error { constructor(public result: number) }
  // client.ts
  export class ControllerClient {
    constructor(cfg: ControllerConfig, queue?: SerialQueue);
    readonly passwordMode: PasswordMode | 'unknown';
    getOptions(o?: RequestOptions): Promise<JoResponse>;          // poll; a body with only `fwv` → ControllerUnauthorized
    getStatus(o?: RequestOptions): Promise<JcResponse>;           // poll, or 'confirm' when o.confirm is true
    getStations(o?: RequestOptions): Promise<JsResponse>;
    getNames(o?: RequestOptions): Promise<JnResponse>;
    getPrograms(o?: RequestOptions): Promise<JpResponse>;
    getLog(startLocalSec: number, endLocalSec: number, o?: RequestOptions): Promise<LogEntry[] | null>;  // null when the controller has no log (HTTP 404, no SD card)
    runStation(sid: number, seconds: number, o?: RequestOptions): Promise<void>;   // command: /cm?sid&en=1&t
    stopStation(sid: number, o?: RequestOptions): Promise<void>;                   // command: /cm?sid&en=0
    stopAll(o?: RequestOptions): Promise<void>;                                    // command: /cv?rsn=1
    setRainDelayHours(hours: number, o?: RequestOptions): Promise<void>;           // command: /cv?rd=; 0 clears; caps at 32767
    setEnabled(enabled: boolean, o?: RequestOptions): Promise<void>;               // command: /cv?en=
    setProgram(pid: number, data: ProgramData, o?: RequestOptions): Promise<void>; // command: /cp?pid&v=[flag,d0,d1,[starts],[durs]]&name=<urlencoded>
  }
  ```
- Password negotiation uses `/jc`. The first call of any kind performs negotiation with `/jc` before proceeding.

- [ ] **Step 1: Write failing queue tests** in `queue.test.ts`:
  - `runs tasks one at a time`: two 100 ms tasks → second starts after first ends; `inFlight` true during.
  - `command jumps ahead of waiting polls`: enqueue poll A (running), poll B, command C → completion order A, C, B.
  - `a new poll replaces a waiting poll`: enqueue poll A (running), poll B, poll C → B is rejected with `PollSuperseded`, order A, C.
  - `a failing task does not block the queue`.
  - `a queued command aborts the in-flight poll`: poll A's `signal.aborted` becomes true when command C is enqueued; C starts within 10 ms of A settling.
  - `confirm is never superseded`: enqueue confirm X, poll Y, poll Z → X runs; Y superseded by Z.

- [ ] **Step 2: Run** `npx vitest run packages/hub-core/test/controller/queue.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `SerialQueue`** in `queue.ts`. Two arrays (commands, polls); `run` returns a promise resolved when its turn completes; drain loop picks commands first.

- [ ] **Step 4: Run** the queue tests → PASS, 6 tests.

- [ ] **Step 5: Write failing client tests** in `client.test.ts` against a simulator per test (`beforeEach` listen on port 0):
  - `negotiates md5 then plaintext on a 2.1.6 controller`: sim `passwordMode:'plain'`; `getStatus()` resolves; `client.passwordMode === 'plain'`; `sim.requestCount === 2`.
  - `uses md5 directly on a 2.1.7 controller`: sim `'md5'`; `requestCount === 1`; `passwordMode === 'md5'`.
  - `getOptions treats a fwv-only body as unauthorized`: wrong password, mode forced; `getOptions()` rejects with `ControllerUnauthorized`, never resolves with a partial `JoResponse`.
  - `getOptions first negotiates on jc`: fresh client, `getOptions()` → sim saw `/jc` before `/jo`.
  - `setProgram always sends name and preserves flag bits`: `setProgram(0, [0b110, …, 'Lawn'])` → sim program 0 has `flag === 0b110` and name `Lawn`.
  - `deadline bounds a call even when a poll is in flight`: sim `responseDelayMs: 2000`; start `getStatus()` (poll), then `runStation(0, 60, {deadlineMs: 1000})` → the command rejects with `ControllerUnreachable` within 1100 ms of its call.
  - `throws ControllerUnauthorized after one re-negotiation when the password changes` (Review Focus 1): after a successful call, `sim.setPassword('changed')`; next call rejects with `ControllerUnauthorized`; a further call makes **no** request for 30 s (fake timers, `requestCount` unchanged).
  - `times out and throws ControllerUnreachable`: `timeoutMs: 200`, sim `responseDelayMs: 1000` → rejects within 300 ms.
  - `throws ControllerUnreachable when offline`: `setOffline(true)` → rejects.
  - `runStation sends cm with en=1 and t`: sim state shows station running with `remainingSec` 90.
  - `setRainDelayHours caps at 32767`: `setRainDelayHours(50_000)` → sim `rainDelayUntil === now + 32767*3600e3`.
  - `never includes the password in error messages`: force a timeout; `expect(err.message).not.toContain(password)` and not the md5 either.

- [ ] **Step 6: Run** → FAIL.

- [ ] **Step 7: Implement `ControllerClient`** in `client.ts` with node `fetch` and `AbortSignal.any([AbortSignal.timeout(min(timeoutMs, deadline remaining)), queueSignal, o.signal])`. MD5 via `node:crypto`. On `result:2` (or fwv-only `/jo`) with mode unknown: retry the other form once. With mode known: retry once with the other form, then throw `ControllerUnauthorized` and set a 30 s backoff during which calls reject immediately.

- [ ] **Step 8: Run** `npx vitest run packages/hub-core` → PASS, 18 tests.

- [ ] **Step 9: Commit**

```bash
git add packages/hub-core
git commit -m "feat(hub): serialized controller client with password negotiation"
```

---

### Task 3: State model and poller

**Files:**
- Create: `packages/hub-core/src/state/model.ts`, `packages/hub-core/src/state/poller.ts`, `packages/hub-core/src/state/store.ts` (in-memory with `EventEmitter`)
- Test: `packages/hub-core/test/state/poller.test.ts`

**Interfaces:**
- Consumes: `ControllerClient` (Task 2).
- Produces:
  ```ts
  // model.ts
  export type ZoneStatus = 'idle' | 'running' | 'queued' | 'unknown';
  export interface Zone { id: number; name: string; status: ZoneStatus; remainingSec: number | null; lastRunAt: number | null; }
  export type ScheduleKind = 'weekly' | 'biweekly' | 'monthly' | 'interval';   // flag bits 4–5 (firmware 2.1.7 program.h: 0 weekly, 1 biweekly, 2 monthly, 3 interval)
  export type OddEven = 'none' | 'odd' | 'even';                               // flag bits 2–3 (0 none, 1 odd, 2 even)
  export interface Schedule {
    id: number; name: string; enabled: boolean; weatherAdjust: boolean; kind: ScheduleKind; oddEven: OddEven;
    fixedStartTimes: boolean;   // flag bit 6: 1 = up to 4 fixed start times; 0 = repeating (starts[0] start, [1] repeat count, [2] repeat every)
    days: boolean[];            // weekly only (Mon..Sun, days0 bit 0 = Monday); empty otherwise
    startMinutes: number[];     // fixed type: up to 4, -1 entries removed; repeating type: [start] only
    zoneMinutes: Record<number, number>;
    pausedUntil: number | null;
    raw: ProgramData;           // the untouched /jp entry; every write starts from this
  }
  export interface ControllerState {
    online: boolean; unauthorized: boolean; lastSeenAt: number | null;   // lastSeenAt is excluded from the change diff (store keeps it outside the compared state)
    tzOffsetSec: number;        // derived from devt each poll; 0 until first poll
    enabled: boolean; rainDelayUntil: number | null;   // UTC ms
    zones: Zone[]; schedules: Schedule[];
    firmware: { fwv: number; hwv: number } | null;
  }
  // model.ts helpers
  export function programToSchedule(pid: number, pd: ProgramData): Schedule;
  export function scheduleToProgram(s: Schedule): ProgramData;   // starts from s.raw; sets bit 0 from enabled, bit 1 from weatherAdjust; keeps all other bits and name
  export function localToUtcMs(localSec: number, tzOffsetSec: number): number;
  export const emptyState: ControllerState;
  // store.ts
  export class StateStore extends EventEmitter {   // emits 'change' (state), 'online', 'offline', 'command'
    get(): ControllerState;
    patch(p: Partial<ControllerState>): void;     // emits 'change' only if something differed
  }
  // poller.ts
  export interface PollerOptions { idleIntervalMs: number /* 5000 */; activeIntervalMs: number /* 2000 */; offlineAfterFailures: number /* 3 */; }
  export class Poller {
    constructor(client: ControllerClient, store: StateStore, opts?: Partial<PollerOptions>);
    start(): void; stop(): void;
    pollNow(): Promise<void>;      // one /jc + /js round; /jn, /jp, /jo only when nbrd/nstations changed or every 60 s
    applyStatus(jc: JcResponse, js?: JsResponse): void;   // the mapping pollNow uses; Commands calls it after a confirm read
  }
  ```
- Mapping: `sbits` bit per station → `running`; `ps[sid] = [pid, remaining, start]` → `remainingSec` and `queued` when `pid !== 0 && remaining > 0 && !running`; `tzOffsetSec = round((devt - floor(Date.now()/1000)) / 900) * 900`; `rd===1` → `rainDelayUntil = localToUtcMs(rdst, tzOffsetSec)`; `pd[i][0] & 1` → `enabled`, `& 2` → `weatherAdjust`.

- [ ] **Step 1: Write failing tests** in `poller.test.ts` (simulator + fake timers):
  - `first poll fills zones and firmware from the controller`: 8 zones, names from `/jn`, `firmware.fwv === 216`.
  - `running zone shows status running and remaining seconds`.
  - `queued zone shows status queued`.
  - `polls faster while something is running`: assert ~2000 ms spacing vs ~5000 ms idle.
  - `marks offline after 3 failed polls and zones become unknown` (Review Focus 3): `setOffline(true)`; after 3 intervals `online===false`, every `zone.status==='unknown'`, `remainingSec===null`; `'offline'` emitted once.
  - `recovers and emits online`: `setOffline(false)` → next poll `online===true`, `'online'` emitted once.
  - `shrinks zones when the controller reports fewer stations` (Review Focus 2): `sim.setStationCount(4)` between polls → `zones.length===4`, no throw.
  - `patch emits change only on real differences`.
  - `rain delay end is converted from controller-local time`: sim `tzOffsetSec: -21600`, `/cv?rd=2` → `rainDelayUntil` within 1 s of `Date.now() + 2h` (not off by 6 h).
  - `program round-trip is lossless`: `scheduleToProgram(programToSchedule(0, pd))` deep-equals `pd` for a weekly, an interval (flag `0b0110001` = type 3, enabled), a weekly odd-day (`0b0000101`) and a repeating-start fixture; flipping only `enabled` changes only bit 0.
  - `lastSeenAt does not cause change events`: two identical idle polls → `'change'` emitted once (first) then zero times.
  - `goes offline on exactly the third consecutive failure`: after 2 failures `online` still true; after the 3rd `online` false.
  - `PollSuperseded does not count as a failure`.

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `model.ts`, `store.ts` (deep-equal via `node:util.isDeepStrictEqual`), `poller.ts`.
- [ ] **Step 4: Run** `npx vitest run packages/hub-core/test/state` → PASS, 10 tests.
- [ ] **Step 5: Commit** `git commit -m "feat(hub): state store and adaptive poller with offline detection"`

---

### Task 4: Commands with optimistic confirm

**Files:**
- Create: `packages/hub-core/src/commands/commands.ts`
- Test: `packages/hub-core/test/commands/commands.test.ts`

**Interfaces:**
- Consumes: `ControllerClient`, `StateStore`, `Poller.pollNow`.
- Produces:
  ```ts
  export type CommandSource = 'app' | 'web' | 'siri-intent' | 'homekit' | 'alexa';
  export type CommandResult = { ok: true; confirmedInMs: number } | { ok: false; error: 'offline' | 'unauthorized' | 'rejected' | 'timeout' | 'not-applied' };
  export const COMMAND_DEADLINE_MS = 3000;
  export class Commands {
    constructor(client: ControllerClient, store: StateStore, poller: Poller);
    runZone(id: number, seconds: number, source: CommandSource): Promise<CommandResult>;
    stopZone(id: number, source: CommandSource): Promise<CommandResult>;
    stopAll(source: CommandSource): Promise<CommandResult>;
    setSystemEnabled(enabled: boolean, source: CommandSource): Promise<CommandResult>;
  }
  ```
- Behaviour: start a deadline of `COMMAND_DEADLINE_MS`; patch the store immediately (`status:'running'` or `'queued'` if another zone is running, `remainingSec: seconds`); send the command with `{deadlineMs: remaining}`; then confirm with `client.getStatus({confirm: true, deadlineMs: remaining})` and apply it to the store. **Confirmation predicates:** `runZone` → `sbits` bit set for `id`, or `ps[id][0] !== 0` (queued); `stopZone` → bit clear and `ps[id][0] === 0`; `stopAll` → all bits clear; `setSystemEnabled` → `en` matches. If the predicate fails, re-read once more (within the deadline, ≥ 300 ms later); if still false return `{ok:false, error:'not-applied'}` and let the real state stand. If the client throws, revert the optimistic patch and map the error (`ControllerUnreachable` → `offline`/`timeout`, `ControllerUnauthorized` → `unauthorized`, `ControllerRejected` → `rejected`). Pause/resume lives in Task 5, not here.

- [ ] **Step 1: Write failing tests**:
  - `runZone reflects running before the controller responds`: sim `responseDelayMs: 400`; 50 ms after calling, store shows `running`; result `ok` with `confirmedInMs < 1500`.
  - `runZone while another runs shows queued`.
  - `runZone works while the system is off` (spec §4): `setSystemEnabled(false)` then `runZone` → ok, zone running.
  - `reverts and returns offline when unreachable`: `setOffline(true)`; result `{ok:false,error:'offline'}` within 3000 ms (spec §6); zone back to `unknown`/`idle`.
  - `stopAll clears running and queued`.
  - `source is recorded on the command event`: store emits `'command'` with `{type:'runZone', id, seconds, source}`.
  - `returns not-applied when the controller acknowledges but does not run` (Codex finding 4): sim option `dropCommands: true` (acks `/cm` with `result:1` but changes nothing) → `{ok:false, error:'not-applied'}`, zone back to `idle`.
  - `meets the 3 s deadline with a slow poll in flight` (Codex finding 5): sim `responseDelayMs: 2500`; start a poll, then `runZone` → result (ok or timeout) within 3100 ms of the call.
  - `confirmation read survives concurrent polls`: fire `poller.pollNow()` three times while a command is confirming → the command still resolves `ok` with a real `confirmedInMs`.

- [ ] **Step 2: Run** → FAIL.  **Step 3: Implement.**  **Step 4: Run** → PASS, 9 tests.
- [ ] **Step 5: Commit** `git commit -m "feat(hub): zone and system commands with optimistic confirm"`

---

### Task 5: Pause-until scheduler and persistent store

**Files:**
- Create: `packages/hub-core/src/persist/jsonStore.ts`, `packages/hub-core/src/pause/pause.ts`
- Test: `packages/hub-core/test/persist/jsonStore.test.ts`, `packages/hub-core/test/pause/pause.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // jsonStore.ts — atomic write (tmp + rename), one file per key
  export class JsonStore { constructor(dir: string); get<T>(key: string, fallback: T): Promise<T>; set<T>(key: string, value: T): Promise<void>; }
  // pause.ts
  export type PauseOwner = 'user' | 'weather';
  export interface PauseRecord { owner: PauseOwner; until: number; appliedHours: number; }
  export class PauseService {
    constructor(client: ControllerClient, store: StateStore, persist: JsonStore, clock?: () => number);
    pauseAll(untilMs: number): Promise<CommandResult>;        // user-owned rain delay, capped per call at 32767 h, re-applied on expiry until `until`
    resumeAll(): Promise<CommandResult>;                        // rd=0, forget record
    pauseSchedule(id: number, untilMs: number): Promise<CommandResult>;  // setProgram(scheduleToProgram({...s, enabled:false})); persist re-enable job
    resumeSchedule(id: number): Promise<CommandResult>;
    start(): void; stop(): void;                                // timer that re-applies/re-enables; also runs on start for missed jobs
    describe(): { all: PauseRecord | null; schedules: Record<number, number> };
  }
  ```
- Owner detection: on each state change, if `rainDelayUntil` (UTC) differs from the hub's record by more than 90 s and the hub did not set it, treat it as `owner:'weather'`. If a weather delay ends before a user pause would have, re-apply the user pause (spec §5.1).
- **Jobs are durable until they succeed** (Codex finding 8): a re-enable or re-apply job stays persisted until its command returns `ok:true`. Failed attempts are retried on every `'online'` event and every 60 s while online. Jobs are removed only on success or an explicit `resumeSchedule`/`resumeAll`.

- [ ] **Step 1: JsonStore tests**: `returns fallback when missing`, `round-trips`, `write is atomic` (no `.tmp` left; concurrent `set` calls leave valid JSON).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: PauseService tests** (simulator, fake timers, injected clock):
  - `pauseAll sets rain delay to the hours until the date`: `until = now + 72h` → sim `rainDelayUntil` equals that.
  - `pauseAll beyond the max caps and re-applies` (Review Focus 4): `until = now + 5 years`; sim shows `32767 h`; advance 32767 h + 1 s → re-applied; `describe().all.until` unchanged.
  - `resumeAll clears the delay and record`.
  - `weather delay that overwrites a user pause is restored when it ends`: user pause 7 days; externally set sim `rd` to 1 day (simulating weather); advance 1 day → hub re-applies 6 days.
  - `pauseSchedule clears the enable bit and re-enables on the date`, and `persists across restart`: construct a second `PauseService` on the same `JsonStore`, `start()` → the re-enable still fires.
  - `pauseSchedule changes only the enable bit and keeps the name` (Codex finding 2): program named `Lawn` with flag `0b111` → after pause, sim shows flag `0b110` and name `Lawn`; after resume, `0b111`.
  - `re-enable is retried when the controller is offline at the deadline` (Codex finding 8): `setOffline(true)` before the date; advance past it → job still in `describe().schedules`; `setOffline(false)` and emit online → program re-enabled and job gone.
  - `restart while a job is pending and overdue restores it`: offline at deadline, stop service, new service `start()` while online → re-enabled.
- [ ] **Step 6: Run** → FAIL. **Step 7: Implement.** **Step 8: Run** → PASS, 11 tests.
- [ ] **Step 9: Commit** `git commit -m "feat(hub): pause-until with persistence and weather-delay reconciliation"`

---

### Task 6: Run history, weather and warnings

**Files:**
- Create: `packages/hub-core/src/history/history.ts`, `packages/hub-core/src/weather/openMeteo.ts`, `packages/hub-core/src/warnings/warnings.ts`
- Test: `packages/hub-core/test/history/history.test.ts`, `packages/hub-core/test/weather/openMeteo.test.ts`, `packages/hub-core/test/warnings/warnings.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // history.ts — merges controller /jl with the hub's own command events
  export class RunHistory { constructor(client: ControllerClient, store: StateStore, persist: JsonStore); refresh(): Promise<void>; lastRunAt(zoneId: number): number | null; }
  // openMeteo.ts
  export interface Forecast { fetchedAt: number; rainProbabilityPct: number /* max over next 24 h; -1 when unavailable */; summary: string /* e.g. "No rain expected" */; tempC: number | null; }
  export class OpenMeteoClient { constructor(lat: number, lon: number, fetchImpl?: typeof fetch); getForecast(): Promise<Forecast>; }  // caches 30 min
  // warnings.ts
  export interface WarningSettings { rainForecast: boolean; rainThresholdPct: number /* 50 */; recentRun: boolean; recentRunWindowMin: number /* 60 */; }
  export type Warning = { kind: 'rain'; probabilityPct: number } | { kind: 'recent-run'; minutesAgo: number };
  export function evaluateWarnings(zoneId: number, settings: WarningSettings, forecast: Forecast | null, lastRunAt: number | null, now: number): Warning[];
  ```
- Open-Meteo request: `https://api.open-meteo.com/v1/forecast?latitude=&longitude=&hourly=precipitation_probability,temperature_2m&forecast_hours=24&timezone=UTC`. `rainProbabilityPct` is the max of the 24 hourly values starting from the current hour (Codex finding 9). `tempC` is the current hour's temperature.
- `RunHistory.refresh()` calls `getLog(nowLocalSec - 7*86400, nowLocalSec)` where `nowLocalSec = floor(Date.now()/1000) + tzOffsetSec`, and converts each `endTsLocal` with `localToUtcMs`. **When `getLog` returns `null` (no SD card, e.g. the owner's v2.2), history comes only from the hub's own command events plus `/jc.lrun` (`[sid, pid, durSec, endTsLocal]`), persisted so it survives restarts.** Add test `falls back to lrun and local events when the controller has no log` (sim `hasLog: false`).
- Warnings are **pure**; the API layer (Task 8) decides when to ask. Sources `homekit`/`alexa` never evaluate warnings (spec §4).

- [ ] **Step 1: Tests**: history `lastRunAt uses the later of /jl and local command events`, `log end times are converted from controller-local time` (sim `tzOffsetSec: -21600`; a run that ended 10 min ago reports `lastRunAt` within 60 s of `Date.now() - 10 min`), and `survives restart`; weather `parses the max over the next 24 hourly values` (fixture with 90 % at hour 30 and 20 % within the window → 20), `window crosses midnight` (fixture at 22:00 UTC with 70 % at 03:00 next day → 70), `caches for 30 minutes`, `returns null-safe forecast on network error` (no throw, `rainProbabilityPct: -1`, `summary: 'Forecast unavailable'`); warnings `rain warning at/above threshold`, `no rain warning when disabled`, `recent-run warning inside window`, `no warnings with null inputs`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS, 12 tests.
- [ ] **Step 5: Commit** `git commit -m "feat(hub): run history, Open-Meteo forecast and warning evaluation"`

---

### Task 7: Watchdog and smart-plug recovery

**Files:**
- Create: `packages/hub-core/src/recovery/plug.ts`, `packages/hub-core/src/recovery/shelly.ts`, `packages/hub-core/src/recovery/tasmota.ts`, `packages/hub-core/src/recovery/watchdog.ts`
- Test: `packages/hub-core/test/recovery/watchdog.test.ts`, `packages/hub-core/test/recovery/drivers.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // plug.ts
  export interface SmartPlug { powerCycle(offMs: number): Promise<void>; }
  export type PlugConfig = { type: 'shelly'; host: string } | { type: 'tasmota'; host: string } | { type: 'homekit-automation' } | { type: 'none' };
  export function createPlug(cfg: PlugConfig, fetchImpl?: typeof fetch): SmartPlug | null; // null for 'none' and 'homekit-automation'
  // watchdog.ts
  export interface WatchdogOptions { minGapMs: number /* 10 min */; maxPerHour: number /* 3 */; offMs: number /* 30 s */; }
  export class Watchdog extends EventEmitter {   // 'power-cycle', 'recovery-exhausted', 'recovered'
    constructor(store: StateStore, plug: SmartPlug | null, opts?: Partial<WatchdogOptions>, clock?: () => number);
    start(): void; stop(): void;
  }
  ```
- Shelly Gen1 `GET /relay/0?turn=off|on`; Tasmota `GET /cm?cmnd=Power%20Off|On`. The `homekit-automation` type does nothing here; the plugin (Task 9) exposes the online sensor for it.

- [ ] **Step 1: Driver tests** with stubbed fetch: `shelly cycles off then on after offMs`, `tasmota cycles off then on`. Watchdog tests with a fake plug and fake timers: `cycles once when store goes offline`, `does not cycle again within 10 minutes`, `stops after 3 cycles in an hour and emits recovery-exhausted` (Review Focus 5), `emits recovered when store comes back online`, `does nothing when plug is null`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS, 7 tests.
- [ ] **Step 5: Commit** `git commit -m "feat(hub): watchdog with rate-limited smart-plug power cycling"`

---

### Task 8: Local API (HTTP + WebSocket), pairing, mDNS

**Files:**
- Create: `packages/hub-core/src/hub.ts` (composes everything: `createHub(config): Hub`), `packages/hub-core/src/config.ts`, `packages/hub-core/src/api/server.ts`, `packages/hub-core/src/api/auth.ts`, `packages/hub-core/src/api/routes.ts`, `packages/hub-core/src/api/ws.ts`, `packages/hub-core/src/api/mdns.ts`, `packages/hub-core/src/notify/notifier.ts`, `packages/hub-core/src/bin/rainmaker-hub.ts`, `examples/hub.config.json` (simulator address, placeholder password)
- Test: `packages/hub-core/test/api/auth.test.ts`, `packages/hub-core/test/api/routes.test.ts`, `packages/hub-core/test/api/ws.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // config.ts
  export interface HubConfig {
    controller: { baseUrl: string; password: string };
    dataDir: string; apiPort: number /* 8787 */;
    allowedOrigins: string[];
    location: { lat: number; lon: number } | null;
    warnings: WarningSettings;
    plug: PlugConfig;
    notifications: { offline: boolean; apnsKeyPath?: string; apnsKeyId?: string; apnsTeamId?: string; apnsBundleId?: string; ntfyTopic?: string; pushoverToken?: string };
    zoneDefaults: Record<number, { voiceSeconds: number }>;
  }
  export function loadConfig(path: string): HubConfig;   // throws a readable error naming the bad field
  // hub.ts
  export interface Capabilities { mqtt: boolean; pauseUntil: true; maxRainDelayHours: 32767; firmware: number | null }
  export interface Hub {
    store: StateStore; commands: Commands; pause: PauseService; history: RunHistory; forecast(): Promise<Forecast | null>;
    settings: SettingsStore; watchdog: Watchdog; notifier: Notifier; pairing: Pairing;
    start(): Promise<void>; stop(): Promise<void>; capabilities(): Capabilities;
  }
  export function createHub(config: HubConfig): Hub;
  // settings persisted in JsonStore key 'settings'
  export interface Settings { warnings: WarningSettings; zones: Record<number, { name?: string; order?: number; voiceSeconds: number }>; notifications: { offline: boolean } }
  export class SettingsStore { get(): Settings; update(p: Partial<Settings>): Promise<Settings>; }
  // auth.ts — tokens persisted in JsonStore key 'devices'
  export class Pairing extends EventEmitter {  // emits 'code' ({code, expiresAt}) whenever a code is issued
    startPairing(): { code: string; expiresAt: number };  /* 6 digits, 5 min; replaces any live code */
    claim(code: string, deviceName: string): { token: string } | null;
    verify(token: string): boolean; revoke(token: string): void; list(): { name: string; createdAt: number }[];
  }
  ```
- **Pairing entry points** (Codex finding 7): (1) `Hub.start()` calls `startPairing()` when **no devices are paired** and logs the code, re-issuing every 5 min until one is claimed; (2) `POST /v1/pairing/start` (authenticated) lets an already-paired device add another and returns the code; (3) the standalone CLI `rainmaker-hub pair --config …` sends that POST using a token read from `dataDir/cli-token`, which the hub writes on first start; (4) the Homebridge plugin logs the code from the `'code'` event and exposes a momentary **"Rainmaker Pairing"** switch that calls `startPairing()` (Task 9).
  ```ts
  // notifier.ts
  export type NotifyKind = 'offline' | 'online' | 'recovery-exhausted';
  export class Notifier { constructor(cfg: HubConfig['notifications'], persist: JsonStore); notify(kind: NotifyKind, text: string): Promise<void>; registerPush(deviceToken: string, apnsToken: string): Promise<void>; }
  ```
- Routes (all JSON; all except `/pair` need `Authorization: Bearer <token>`):
  - `GET /v1/state` → `ControllerState & { forecast, capabilities, pause: describe() }`
  - `POST /v1/zones/:id/run {seconds, source, force?:boolean}` → if `!force` and source is `app|web|siri-intent`, evaluate warnings; when non-empty return `409 {warnings}` without running; else run and return `CommandResult`.
  - `POST /v1/zones/:id/stop`, `POST /v1/stop-all`, `POST /v1/system {enabled}`
  - `POST /v1/pause {until}` , `POST /v1/resume`, `POST /v1/schedules/:id/pause {until}`, `POST /v1/schedules/:id/resume`
  - `GET /v1/schedules`, `PUT /v1/schedules/:id` (`Schedule` minus `pausedUntil`) → `setProgram` mapping; zones in controller order.
  - `GET/PUT /v1/settings` (`Settings`)
  - `GET /v1/zones/:id/photo`, `PUT /v1/zones/:id/photo` (JPEG ≤ 2 MB, stored under `dataDir/photos/<id>.jpg`)
  - `POST /v1/pair {code, deviceName}` → `{token, id}`; `POST /v1/pairing/start` → `{code, expiresAt}`; `GET /v1/devices` → `[{id, name, createdAt}]` (id = SHA-256 of the token, hex); `DELETE /v1/devices/:id`, `PUT /v1/devices/:id/push {apnsToken}`. Bearer tokens never appear in URLs (Ruling M).
  - `GET /v1/ws` → WebSocket. **Browser-compatible auth** (Codex finding 6): no header required; the client's first message must be `{type:'auth', token}` within 2 s, otherwise the socket closes with code 4401 and nothing is sent. After auth: `{type:'state', state}` immediately and on every store change, `{type:'event', name, payload}` for `command|offline|online|power-cycle|recovery-exhausted`.
  - CORS: allow any origin for `GET`; for other methods allow `allowedOrigins` plus `http://<controller host>` (spec §5.1).
- mDNS: advertise `_rainmaker._tcp` on `apiPort` with TXT `v=1`.
- Notifier: APNs over HTTP/2 (`node:http2`) with a token-signed JWT when the APNs fields are set; else ntfy (`POST https://ntfy.sh/<topic>`) or Pushover if set; else log. Only fires `offline`/`online` when `settings.notifications.offline` is true.
- CLI `rainmaker-hub --config path.json` starts a standalone hub and prints the pairing code on first run.

- [ ] **Step 1: Auth tests**: `claim with valid code returns token`, `code expires after 5 min`, `verify false for unknown token`, `revoke`, `startPairing after expiry issues a new code`, `hub start with no devices issues a code and re-issues after 5 min`, `pairing/start route returns a claimable code`.
- [ ] **Step 2: Route tests** (hub against simulator): `401 without token`, `GET /v1/state includes zones and capabilities`, `run returns 409 with warnings for source app when rain forecast` (stub forecast 80 %), `run with force runs`, `run with source alexa ignores warnings`, `pause then state shows rainDelayUntil`, `PUT schedule updates the simulator program`, `state response never contains the controller password or its md5`, `CORS allows controller origin for POST`, `loadConfig names a missing field`.
- [ ] **Step 3: WS tests**: `receives state after auth message`, `closes with 4401 and sends nothing on a bad token`, `closes with 4401 when no auth within 2 s`, `receives state within 100 ms of a store change`, `receives offline event`.
- [ ] **Step 4: Run** → FAIL. **Step 5: Implement** `hub.ts`, `config.ts` (hand-written checks, no schema lib), `server.ts` on node `http`, `ws` package for WebSocket, `bonjour-service` for mDNS. **Step 6: Run** `npx vitest run packages/hub-core` → PASS.
- [ ] **Step 7: Manual check**: `npx rainmaker-hub --config examples/hub.config.json` (pointing at a running simulator) → logs "Rainmaker hub listening on 8787" and a pairing code; `curl -H "Authorization: Bearer <token>" localhost:8787/v1/state` returns zones.
- [ ] **Step 8: Commit** `git commit -m "feat(hub): local API with pairing, WebSocket push, mDNS and notifications"`

---

### Task 9: Homebridge plugin

**Files:**
- Create: `packages/homebridge-rainmaker/package.json` (name `homebridge-rainmaker`, keywords `homebridge-plugin`, `engines.homebridge: "^1.8.0 || ^2.0.0"`), `config.schema.json`, `src/index.ts`, `src/platform.ts`, `src/accessories/irrigation.ts`, `src/accessories/switches.ts`, `src/accessories/onlineSensor.ts`
- Test: `packages/homebridge-rainmaker/test/fakes.ts`, `test/irrigation.test.ts`, `test/switches.test.ts`

**Interfaces:**
- Consumes: `createHub`, `Hub`, `StateStore` events, `Commands`, `PauseService`, `SettingsStore` (Task 8).
- Produces HomeKit accessories:
  - **"Sprinklers"** `IrrigationSystem` (Active, ProgramMode, InUse) with one linked `Valve` per zone: `ValveType=IRRIGATION`, `Name=zone.name`, `SetDuration` from `settings.zones[id].voiceSeconds` (default 600) and **written back via `settings.update` when changed in Home**, `RemainingDuration` from `remainingSec`, `Active` set → `commands.runZone(id, SetDuration, 'homekit')`, cleared → `stopZone`.
  - Switches: **"Sprinkler System"** (`setSystemEnabled`), **"Sprinkler Pause"** (on → `pauseAll(now + 32767 h)`, off → `resumeAll`; state reflects `rainDelayUntil !== null`), **"Pause Sprinklers 1 Day"**, **"Pause Sprinklers 1 Week"** (momentary: on → `pauseAll(now + 24 h | 168 h)` then auto-off after 1 s).
  - **"Sprinkler Controller Online"** `ContactSensor`: `CONTACT_DETECTED` when online, `CONTACT_NOT_DETECTED` when offline (for the `homekit-automation` plug path).
  - **"Rainmaker Pairing"** momentary switch: on → `pairing.startPairing()`, logs the code, auto-off after 1 s.
- **Failures reach Siri and Alexa** (Codex finding 10): every characteristic `set` handler awaits the `CommandResult`; on `{ok:false}` it throws `new this.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)` so HomeKit reports the failure and Alexa says the device isn't responding, and it reverts the characteristic to the store's value.
- `config.schema.json` mirrors `HubConfig` and includes Homebridge's standard `_bridge` block so the plugin can run as a child bridge.

- [ ] **Step 1: Tests** using a minimal hand-written fake of the Homebridge `API`/`PlatformAccessory`/`Service`/`Characteristic` in `test/fakes.ts` (~80 lines): `creates one valve per zone with the zone name`, `removes valves for zones that disappear` (Review Focus 2), `setting Active runs the zone with the configured duration and source homekit`, `RemainingDuration follows store changes`, `Sprinkler Pause reflects rainDelayUntil`, `Pause 1 Week calls pauseAll with 168 h and turns itself off`, `online sensor follows store online`, `changing SetDuration in Home persists and survives a platform restart` (new platform on the same `SettingsStore` → valve reports the changed value), `a failed command throws HapStatusError and reverts Active` (`commands.runZone` stubbed to `{ok:false, error:'offline'}`), `Pairing switch issues a code`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS, 10 tests.
- [ ] **Step 5: Manual check on the owner's Windows PC**: `npm link` the plugin into Homebridge, configure it as a child bridge, open the Home app → "Sprinklers" tile with named zones; "Hey Siri, turn on <zone>" starts water. Record in `docs/guides/voice-test-checklist.md` with pass/fail per phrase (Siri and Alexa columns).
- [ ] **Step 6: Commit** `git commit -m "feat(homebridge): Rainmaker platform with irrigation valves, pause and system switches"`

---

### Task 10: Latency harness

**Files:**
- Create: `packages/hub-core/src/bin/rainmaker-latency.ts`
- Test: `packages/hub-core/test/bin/latency.test.ts`

**Interfaces:** CLI `rainmaker-latency --hub http://localhost:8787 --token T --zone 0 --runs 10` → table with p50/p95 for: `api-ack` (POST returns), `confirmed` (`confirmedInMs`), `ws-state` (WebSocket shows running), and exit code 1 if p95 `confirmed` > 1500 ms (spec §6). Each run uses `seconds: 5` and stops the zone before the next.

- [ ] **Step 1: Test**: run the harness against hub+simulator with `responseDelayMs: 150` → exit 0 and p95 < 1500; with `responseDelayMs: 2000` → exit 1.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Measure on the real controller** (owner present): record results in `docs/guides/latency-results.md` (board v2.2, fw 2.1.6). If p95 > 1500 ms, open an issue; tune `timeoutMs`/intervals before moving on.
- [ ] **Step 6: Commit** `git commit -m "feat(hub): latency harness with p95 gate"`

---

### Task 11: Setup guides and README

**Files:**
- Create: `docs/guides/install-hub.md`, `docs/guides/alexa-setup.md`, `docs/guides/smart-plug-recovery.md`, `docs/guides/remote-access-tailscale.md`
- Modify: `README.md` (replace "Status: Planning" with install links)

- [ ] **Step 1: Write the guides**: install (Homebridge UI → search `homebridge-rainmaker` or `npm link` for now; child bridge; config fields; pairing code location in the log); Alexa (install `homebridge-alexa`, subscription note per spec §5.3, "Alexa, discover devices", three routines: "pause sprinklers for a day/week", "resume sprinklers"); smart plug (Shelly/Tasmota direct; HomeKit automation on the "Sprinkler Controller Online" sensor: when it opens, turn plug off, wait 30 s, turn on); Tailscale (install on PC and phone, hub reachable at the tailnet name, controller stays LAN-only).
- [ ] **Step 2: Run** `npm test` → all green. **Step 3: Commit** `git commit -m "docs: hub, Alexa, smart plug and remote access guides"`

---

## Codex review (2026-10-21)

Ten findings, all folded in: `/jo` fwv-only unauthorized reply (Task 1–2), lossless program round-trip with names (Tasks 1–3, 5), controller-local timestamps (Global, Tasks 1, 3, 6), confirmation predicates and `not-applied` (Task 4), end-to-end 3 s deadline with poll abort and protected confirms (Tasks 2, 4), browser WebSocket auth (Task 8), pairing entry points (Tasks 8–9), durable pause jobs (Task 5), hourly forecast window (Task 6), HomeKit failure propagation and SetDuration persistence (Task 9).

## Self-review notes

- Spec coverage: §5.1 items 1–10 map to Tasks 2–8; §5.2 (a) and §5.3 to Task 9 and the Alexa guide; §5.2 (b) App Intents belong to the iOS plan; §5.6 to Task 11; §5.7 to Task 8 notifier; §6 to Task 10; §7/§8 phase 0 to Task 0; §9 simulator to Task 1.
- Names reused across tasks: `ControllerClient`, `StateStore`, `Poller`, `Commands`, `CommandResult`, `PauseService`, `JsonStore`, `WarningSettings`, `evaluateWarnings`, `SmartPlug`, `Watchdog`, `createHub`, `Hub`, `Pairing`, `SettingsStore`, `Notifier`. Checked for consistency.
- Deferred to the iOS and web plans: App Intents, photo capture UI, widgets, Live Activities, the fallback direct-to-controller mode.
