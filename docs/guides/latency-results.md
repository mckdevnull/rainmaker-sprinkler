# Latency results (real controller)

Spec target: command to confirmed in 1.5 s or less on the LAN. This page is a template; fill it in
from a run against your own controller. Nothing here is a measurement until you write it in.

## Setup

- Controller: OpenSprinkler board v2.2, firmware 2.1.6
- Hub host / network: _fill in_
- Date: _fill in_

## Command

Pair a device first (`rainmaker-hub pair --config <path>`), then:

```sh
rainmaker-latency --hub http://localhost:8787 --token <token> --zone 0 --runs 10
```

Each run starts zone 0 for 5 s, then stops it and waits for the zone to be idle before the next run.

## Results

| Metric      | What it measures                                        | p50 (ms) | p95 (ms) | Failed / missed |
|-------------|---------------------------------------------------------|----------|----------|-----------------|
| `api-ack`   | POST sent until the hub's response arrives              |          |          |                 |
| `confirmed` | `confirmedInMs` reported by the hub                     |          |          |                 |
| `ws-state`  | POST sent until a WebSocket frame shows running/queued  |          |          |                 |

## Pass criterion

Pass (exit 0): p95 of `confirmed` is 1500 ms or less and no run returned `ok:false`.
Fail (exit 1): otherwise. A fail is a bug: open an issue and tune the controller `timeoutMs` and
polling intervals before moving on.

Result: _PASS / FAIL_
