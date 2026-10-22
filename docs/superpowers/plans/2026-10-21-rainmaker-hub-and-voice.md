# Rainmaker Hub and Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Node.js hub that is the only client of an OpenSprinkler v2 controller, plus a Homebridge plugin that exposes zones, pause and system switches to Siri and (via homebridge-alexa) Alexa, with measured command latency.

**Architecture:** An npm-workspaces monorepo. `packages/controller-sim` fakes a v2 controller's HTTP API (one client at a time, both password formats) so everything is testable without hardware. `packages/hub-core` holds a serialized controller client, a polled state cache, commands with optimistic confirm, pause-until scheduling, weather and warnings, a watchdog with smart-plug recovery, and a local HTTP+WebSocket API. `packages/homebridge-rainmaker` wraps hub-core as a Homebridge platform plugin and publishes HomeKit accessories.

**Tech Stack:** Node.js 20+, TypeScript 5, vitest, `ws`, `bonjour-service`, Homebridge 1.8/2.x plugin API (`homebridge` types), no framework for HTTP (node `http`).

**Spec:** `docs/superpowers/specs/2026-10-21-rainmaker-design.md` (sections 5.1, 5.2, 5.3, 5.6, 5.7, 6, 7, 8 phases 0–2, 9). This plan does not cover the iOS app (§5.4) or the web page (§5.5); those get their own plans.

## Global Constraints

- Node.js `>=20`. TypeScript strict mode. MIT licence header not required per file; `LICENSE` at the repo root covers it.
- **At most one in-flight HTTP request to the controller at any time**, across the whole hub (spec §3, §5.1).
- Support firmware **2.1.6 through 2.2.1(4)**. Password: try MD5-hex `pw` first; on `{"result":2}` retry plaintext once and remember the mode (spec §5.1, §5.4).
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
- Endpoints, matching the firmware (research doc `docs/research/firmware-and-hardware.md` §4): `/jo`, `/jc`, `/js`, `/jn`, `/jp`, `/jl`, `/cm`, `/cv`, `/cp`. Every one requires `pw`. Wrong `pw` → `{"result":2}`. Success for commands → `{"result":1}`.
- Behaviour to model: **one request at a time** (a second concurrent socket waits until the first response is sent); stations run **sequentially** (a `/cm` while one runs appends to `queue`); `/cv?rsn=1` stops everything; `/cv?rd=H` sets `rainDelayUntil = now + H*3600e3`; `/cv?en=0|1` sets `enabled`; `/cm` works even when `enabled=false`; `/jc` returns `{devt, en, rd, rdst, sbits, ps, nbrd}`; `/js` returns `{sn, nstations}`; `/jn` returns `{snames}`; `/jo` returns `{fwv, hwv, nbrd, ipas, wl}`; `/jp` returns `{nprogs, pd: [[flag, days0, days1, [start0..3], [dur..]], ...]}` where enable is bit 0 of `flag`; `/cp?pid=&v=` replaces that program; `/jl?start=&end=` returns `[[pid, sid, durSec, endTs], ...]`.

- [ ] **Step 1: Scaffold the monorepo** (root `package.json` with `"workspaces": ["packages/*"]`, scripts `test: vitest run`, `build: tsc -b`, `lint: eslint .`; `tsconfig.base.json` with `strict`, `module: NodeNext`, `target: ES2022`; devDeps `typescript`, `vitest`, `eslint`, `@types/node`). Run `npm install` and `npm test` → vitest reports no test files, exit 0.

- [ ] **Step 2: Write the failing tests** in `packages/controller-sim/test/sim.test.ts`:
  - `rejects wrong password with result 2`: GET `/jo?pw=nope` → body `{"result":2}`.
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
Expected: PASS, 9 tests.

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
  export type Priority = 'command' | 'poll';
  export class PollSuperseded extends Error {}
  export class SerialQueue {
    constructor(opts?: { maxPollBacklog?: number }); // default 1: a new poll replaces a waiting poll
    run<T>(priority: Priority, fn: () => Promise<T>): Promise<T>;
    readonly inFlight: boolean;
  }
  // types.ts
  export interface ControllerConfig { baseUrl: string; password: string; timeoutMs?: number /* default 2500 */; }
  export interface JcResponse { devt: number; en: 0|1; rd: 0|1; rdst: number; sbits: number[]; ps: [number, number, number][]; nbrd: number; }
  export interface JsResponse { sn: (0|1)[]; nstations: number; }
  export interface JoResponse { fwv: number; hwv: number; nbrd: number; ipas: 0|1; wl: number; }
  export interface JnResponse { snames: string[]; }
  export interface JpResponse { nprogs: number; pd: ProgramData[]; }
  export type ProgramData = [number, number, number, number[], number[]];
  export type LogEntry = [number, number, number, number];
  // errors.ts
  export class ControllerUnreachable extends Error {}
  export class ControllerUnauthorized extends Error {}
  export class ControllerRejected extends Error { constructor(public result: number) }
  // client.ts
  export class ControllerClient {
    constructor(cfg: ControllerConfig, queue?: SerialQueue);
    readonly passwordMode: PasswordMode | 'unknown';
    getOptions(): Promise<JoResponse>;          // poll priority
    getStatus(): Promise<JcResponse>;           // poll
    getStations(): Promise<JsResponse>;         // poll
    getNames(): Promise<JnResponse>;            // poll
    getPrograms(): Promise<JpResponse>;         // poll
    getLog(startSec: number, endSec: number): Promise<LogEntry[]>; // poll
    runStation(sid: number, seconds: number): Promise<void>;   // command: /cm?sid&en=1&t
    stopStation(sid: number): Promise<void>;                   // command: /cm?sid&en=0
    stopAll(): Promise<void>;                                  // command: /cv?rsn=1
    setRainDelayHours(hours: number): Promise<void>;           // command: /cv?rd=; 0 clears; caps at 32767
    setEnabled(enabled: boolean): Promise<void>;               // command: /cv?en=
    setProgram(pid: number, data: ProgramData): Promise<void>; // command: /cp?pid&v=
  }
  ```

- [ ] **Step 1: Write failing queue tests** in `queue.test.ts`:
  - `runs tasks one at a time`: two 100 ms tasks → second starts after first ends; `inFlight` true during.
  - `command jumps ahead of waiting polls`: enqueue poll A (running), poll B, command C → completion order A, C, B.
  - `a new poll replaces a waiting poll`: enqueue poll A (running), poll B, poll C → B is rejected with `PollSuperseded`, order A, C.
  - `a failing task does not block the queue`.

- [ ] **Step 2: Run** `npx vitest run packages/hub-core/test/controller/queue.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `SerialQueue`** in `queue.ts`. Two arrays (commands, polls); `run` returns a promise resolved when its turn completes; drain loop picks commands first.

- [ ] **Step 4: Run** the queue tests → PASS, 4 tests.

- [ ] **Step 5: Write failing client tests** in `client.test.ts` against a simulator per test (`beforeEach` listen on port 0):
  - `negotiates md5 then plaintext on a 2.1.6 controller`: sim `passwordMode:'plain'`; `getOptions()` resolves; `client.passwordMode === 'plain'`; `sim.requestCount === 2`.
  - `uses md5 directly on a 2.1.7 controller`: sim `'md5'`; `requestCount === 1`; `passwordMode === 'md5'`.
  - `throws ControllerUnauthorized after one re-negotiation when the password changes` (Review Focus 1): after a successful call, `sim.setPassword('changed')`; next call rejects with `ControllerUnauthorized`; a further call makes **no** request for 30 s (fake timers, `requestCount` unchanged).
  - `times out and throws ControllerUnreachable`: `timeoutMs: 200`, sim `responseDelayMs: 1000` → rejects within 300 ms.
  - `throws ControllerUnreachable when offline`: `setOffline(true)` → rejects.
  - `runStation sends cm with en=1 and t`: sim state shows station running with `remainingSec` 90.
  - `setRainDelayHours caps at 32767`: `setRainDelayHours(50_000)` → sim `rainDelayUntil === now + 32767*3600e3`.
  - `never includes the password in error messages`: force a timeout; `expect(err.message).not.toContain(password)` and not the md5 either.

- [ ] **Step 6: Run** → FAIL.

- [ ] **Step 7: Implement `ControllerClient`** in `client.ts` with node `fetch` and `AbortSignal.timeout`. MD5 via `node:crypto`. On `result:2` with mode unknown: retry the other form once. On `result:2` with mode known: retry once with the other form, then throw `ControllerUnauthorized` and set a 30 s backoff during which calls reject immediately.

- [ ] **Step 8: Run** `npx vitest run packages/hub-core` → PASS, 12 tests.

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
  export interface Schedule { id: number; name: string; enabled: boolean; days: boolean[]; startMinutes: number[]; zoneMinutes: Record<number, number>; pausedUntil: number | null; }
  export interface ControllerState {
    online: boolean; unauthorized: boolean; lastSeenAt: number | null;
    enabled: boolean; rainDelayUntil: number | null;
    zones: Zone[]; schedules: Schedule[];
    firmware: { fwv: number; hwv: number } | null;
  }
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
  }
  ```
- Mapping: `sbits` bit per station → `running`; `ps[sid] = [pid, remaining, start]` → `remainingSec` and `queued` when `pid !== 0 && remaining > 0 && !running`; `rd===1` → `rainDelayUntil = rdst*1000`; `pd[i][0] & 1` → `schedule.enabled`.

- [ ] **Step 1: Write failing tests** in `poller.test.ts` (simulator + fake timers):
  - `first poll fills zones and firmware from the controller`: 8 zones, names from `/jn`, `firmware.fwv === 216`.
  - `running zone shows status running and remaining seconds`.
  - `queued zone shows status queued`.
  - `polls faster while something is running`: assert ~2000 ms spacing vs ~5000 ms idle.
  - `marks offline after 3 failed polls and zones become unknown` (Review Focus 3): `setOffline(true)`; after 3 intervals `online===false`, every `zone.status==='unknown'`, `remainingSec===null`; `'offline'` emitted once.
  - `recovers and emits online`: `setOffline(false)` → next poll `online===true`, `'online'` emitted once.
  - `shrinks zones when the controller reports fewer stations` (Review Focus 2): `sim.setStationCount(4)` between polls → `zones.length===4`, no throw.
  - `patch emits change only on real differences`.

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `model.ts`, `store.ts` (deep-equal via `node:util.isDeepStrictEqual`), `poller.ts`.
- [ ] **Step 4: Run** `npx vitest run packages/hub-core/test/state` → PASS, 8 tests.
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
  export type CommandResult = { ok: true; confirmedInMs: number } | { ok: false; error: 'offline' | 'unauthorized' | 'rejected' | 'timeout' };
  export class Commands {
    constructor(client: ControllerClient, store: StateStore, poller: Poller);
    runZone(id: number, seconds: number, source: CommandSource): Promise<CommandResult>;
    stopZone(id: number, source: CommandSource): Promise<CommandResult>;
    stopAll(source: CommandSource): Promise<CommandResult>;
    setSystemEnabled(enabled: boolean, source: CommandSource): Promise<CommandResult>;
  }
  ```
- Behaviour: patch the store immediately (`status:'running'` or `'queued'` if another zone is running, `remainingSec: seconds`), send the command, then `pollNow()` to confirm. If the poll contradicts the optimistic state, the poll wins. If the client throws, revert the optimistic patch and return `ok:false`. Pause/resume lives in Task 5, not here.

- [ ] **Step 1: Write failing tests**:
  - `runZone reflects running before the controller responds`: sim `responseDelayMs: 400`; 50 ms after calling, store shows `running`; result `ok` with `confirmedInMs < 1500`.
  - `runZone while another runs shows queued`.
  - `runZone works while the system is off` (spec §4): `setSystemEnabled(false)` then `runZone` → ok, zone running.
  - `reverts and returns offline when unreachable`: `setOffline(true)`; result `{ok:false,error:'offline'}` within 3000 ms (spec §6); zone back to `unknown`/`idle`.
  - `stopAll clears running and queued`.
  - `source is recorded on the command event`: store emits `'command'` with `{type:'runZone', id, seconds, source}`.

- [ ] **Step 2: Run** → FAIL.  **Step 3: Implement.**  **Step 4: Run** → PASS, 6 tests.
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
    pauseSchedule(id: number, untilMs: number): Promise<CommandResult>;  // clear enable bit via setProgram; persist re-enable job
    resumeSchedule(id: number): Promise<CommandResult>;
    start(): void; stop(): void;                                // timer that re-applies/re-enables; also runs on start for missed jobs
    describe(): { all: PauseRecord | null; schedules: Record<number, number> };
  }
  ```
- Owner detection: on each state change, if `rainDelayUntil` differs from the hub's record and the hub did not set it, treat it as `owner:'weather'`. If a weather delay ends before a user pause would have, re-apply the user pause (spec §5.1).

- [ ] **Step 1: JsonStore tests**: `returns fallback when missing`, `round-trips`, `write is atomic` (no `.tmp` left; concurrent `set` calls leave valid JSON).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: PauseService tests** (simulator, fake timers, injected clock):
  - `pauseAll sets rain delay to the hours until the date`: `until = now + 72h` → sim `rainDelayUntil` equals that.
  - `pauseAll beyond the max caps and re-applies` (Review Focus 4): `until = now + 5 years`; sim shows `32767 h`; advance 32767 h + 1 s → re-applied; `describe().all.until` unchanged.
  - `resumeAll clears the delay and record`.
  - `weather delay that overwrites a user pause is restored when it ends`: user pause 7 days; externally set sim `rd` to 1 day (simulating weather); advance 1 day → hub re-applies 6 days.
  - `pauseSchedule clears the enable bit and re-enables on the date`, and `persists across restart`: construct a second `PauseService` on the same `JsonStore`, `start()` → the re-enable still fires.
- [ ] **Step 6: Run** → FAIL. **Step 7: Implement.** **Step 8: Run** → PASS, 8 tests.
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
- Open-Meteo request: `https://api.open-meteo.com/v1/forecast?latitude=&longitude=&daily=precipitation_probability_max,temperature_2m_max&forecast_days=2&timezone=auto`.
- Warnings are **pure**; the API layer (Task 8) decides when to ask. Sources `homekit`/`alexa` never evaluate warnings (spec §4).

- [ ] **Step 1: Tests**: history `lastRunAt uses the later of /jl and local command events` and `survives restart`; weather `parses probability and builds summary` (stub fetch with a fixture), `caches for 30 minutes`, `returns null-safe forecast on network error` (no throw, `rainProbabilityPct: -1`, `summary: 'Forecast unavailable'`); warnings `rain warning at/above threshold`, `no rain warning when disabled`, `recent-run warning inside window`, `no warnings with null inputs`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS, 9 tests.
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
    settings: SettingsStore; watchdog: Watchdog; notifier: Notifier;
    start(): Promise<void>; stop(): Promise<void>; capabilities(): Capabilities;
  }
  export function createHub(config: HubConfig): Hub;
  // settings persisted in JsonStore key 'settings'
  export interface Settings { warnings: WarningSettings; zones: Record<number, { name?: string; order?: number; voiceSeconds: number }>; notifications: { offline: boolean } }
  export class SettingsStore { get(): Settings; update(p: Partial<Settings>): Promise<Settings>; }
  // auth.ts — tokens persisted in JsonStore key 'devices'
  export class Pairing { startPairing(): { code: string; expiresAt: number }  /* 6 digits, 5 min */; claim(code: string, deviceName: string): { token: string } | null; verify(token: string): boolean; revoke(token: string): void; list(): { name: string; createdAt: number }[] }
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
  - `POST /v1/pair {code, deviceName}` → `{token}`; `GET /v1/devices`, `DELETE /v1/devices/:token`, `PUT /v1/devices/:token/push {apnsToken}`
  - `GET /v1/ws` → WebSocket; messages `{type:'state', state}` on every store change, `{type:'event', name, payload}` for `command|offline|online|power-cycle|recovery-exhausted`.
  - CORS: allow any origin for `GET`; for other methods allow `allowedOrigins` plus `http://<controller host>` (spec §5.1).
- mDNS: advertise `_rainmaker._tcp` on `apiPort` with TXT `v=1`.
- Notifier: APNs over HTTP/2 (`node:http2`) with a token-signed JWT when the APNs fields are set; else ntfy (`POST https://ntfy.sh/<topic>`) or Pushover if set; else log. Only fires `offline`/`online` when `settings.notifications.offline` is true.
- CLI `rainmaker-hub --config path.json` starts a standalone hub and prints the pairing code on first run.

- [ ] **Step 1: Auth tests**: `claim with valid code returns token`, `code expires after 5 min`, `verify false for unknown token`, `revoke`.
- [ ] **Step 2: Route tests** (hub against simulator): `401 without token`, `GET /v1/state includes zones and capabilities`, `run returns 409 with warnings for source app when rain forecast` (stub forecast 80 %), `run with force runs`, `run with source alexa ignores warnings`, `pause then state shows rainDelayUntil`, `PUT schedule updates the simulator program`, `state response never contains the controller password or its md5`, `CORS allows controller origin for POST`, `loadConfig names a missing field`.
- [ ] **Step 3: WS tests**: `receives state on connect`, `receives state within 100 ms of a store change`, `receives offline event`.
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
- `config.schema.json` mirrors `HubConfig` and includes Homebridge's standard `_bridge` block so the plugin can run as a child bridge.

- [ ] **Step 1: Tests** using a minimal hand-written fake of the Homebridge `API`/`PlatformAccessory`/`Service`/`Characteristic` in `test/fakes.ts` (~80 lines): `creates one valve per zone with the zone name`, `removes valves for zones that disappear` (Review Focus 2), `setting Active runs the zone with the configured duration and source homekit`, `RemainingDuration follows store changes`, `Sprinkler Pause reflects rainDelayUntil`, `Pause 1 Week calls pauseAll with 168 h and turns itself off`, `online sensor follows store online`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS, 7 tests.
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

## Self-review notes

- Spec coverage: §5.1 items 1–10 map to Tasks 2–8; §5.2 (a) and §5.3 to Task 9 and the Alexa guide; §5.2 (b) App Intents belong to the iOS plan; §5.6 to Task 11; §5.7 to Task 8 notifier; §6 to Task 10; §7/§8 phase 0 to Task 0; §9 simulator to Task 1.
- Names reused across tasks: `ControllerClient`, `StateStore`, `Poller`, `Commands`, `CommandResult`, `PauseService`, `JsonStore`, `WarningSettings`, `evaluateWarnings`, `SmartPlug`, `Watchdog`, `createHub`, `Hub`, `Pairing`, `SettingsStore`, `Notifier`. Checked for consistency.
- Deferred to the iOS and web plans: App Intents, photo capture UI, widgets, Live Activities, the fallback direct-to-controller mode.
