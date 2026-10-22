# Voice test checklist

Fill this in after installing `homebridge-rainmaker` as a child bridge and adding it to the Home app.
Alexa reaches the same accessories through the `homebridge-alexa` plugin; run "Alexa, discover devices"
first so the new accessories appear.

**Setup**

- Date: ____________  Homebridge version: ____________  Plugin version: ____________
- Controller firmware: ____________  `homebridge-alexa` version: ____________
- In the Home app, a "Sprinklers" tile shows one valve per zone, with the zone names: ☐ yes ☐ no
- Accessories present: "Sprinkler System", "Sprinkler Pause", "Pause Sprinklers 1 Day",
  "Pause Sprinklers 1 Week", "Sprinkler Controller Online", "Rainmaker Pairing": ☐ yes ☐ no

**How to judge a phrase**

- **Pass** means the voice assistant confirms *and* the controller does it (check the OpenSprinkler
  web page or the zone itself) within the latency target: **≤ 2 s for Siri, ≤ 3 s for Alexa**,
  measured from the end of the phrase to water on/off (or the pause showing on the controller).
- A command that cannot be carried out must be **reported as a failure** (Siri says there was a
  problem, Alexa says the device is not responding). A confirmation with nothing happening is a
  **fail**, whatever the latency.
- Write the measured latency in seconds next to pass/fail, e.g. `pass 1.4`.

| # | Phrase | Expected result | Siri (pass/fail, s) | Alexa (pass/fail, s) | Notes |
|---|--------|-----------------|---------------------|----------------------|-------|
| 1 | "Turn on &lt;zone&gt;" | That zone starts for its voice duration (default 10 min) | | | |
| 2 | "Turn off &lt;zone&gt;" | That zone stops | | | |
| 3 | "Turn on sprinkler pause" | Rain delay set on the controller (until resumed) | | | |
| 4 | "Turn off sprinkler pause" | Rain delay cleared | | | |
| 5 | "Turn on pause sprinklers 1 day" | Rain delay of 24 h; switch turns itself off after ~1 s | | | |
| 6 | "Turn on pause sprinklers 1 week" | Rain delay of 168 h; switch turns itself off after ~1 s | | | |
| 7 | "Turn off the sprinkler system" | Controller disabled (no scheduled watering) | | | |
| 8 | "Turn on the sprinkler system" | Controller enabled again | | | |
| 9 | "Turn on the sprinklers" | Every zone runs in turn, each for its voice duration (the controller queues them) | | | |
| 10 | "Turn off the sprinklers" | All zones stop | | | |

**Failure check** (unplug the controller, or block it on the network, then wait about 20 s)

| # | Phrase | Expected result | Siri (pass/fail) | Alexa (pass/fail) | Notes |
|---|--------|-----------------|------------------|-------------------|-------|
| 11 | "Turn on &lt;zone&gt;" while the controller is offline | Siri reports a problem; Alexa says the device is not responding; "Sprinkler Controller Online" shows open | | | |

**Home app check** (no voice: tap in the Home app on the iPhone)

| # | Action | Expected result | Pass/fail | Notes |
|---|--------|-----------------|-----------|-------|
| 12 | In the Home app, tap one valve on the Sprinklers tile | Only that zone runs (not every zone) | | |

**Result**

- All phrases pass for both assistants: ☐ yes ☐ no
- Follow-ups: ______________________________________________
