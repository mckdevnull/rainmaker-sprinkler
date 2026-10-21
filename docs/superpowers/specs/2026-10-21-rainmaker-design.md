# Rainmaker: design

**Date:** 2026-10-21
**Status:** Draft, awaiting owner approval
**Research:** [firmware and hardware](../../research/firmware-and-hardware.md), [voice assistants](../../research/voice-assistants.md), [app and web UI](../../research/app-and-web-ui.md)
**Mockups:** [home screen options](../../mockups/home-layout.html), [chosen home screen](../../mockups/home-layout-v2.html), [schedules and pause](../../mockups/schedules.html)

## 1. What this is and why

Rainmaker is a free, open-source update for **OpenSprinkler** irrigation controllers. It is aimed first at old controllers that have wired Ethernet only. It adds:

- dependable voice control from **Siri and Alexa**
- a simple native **iPhone/iPad app**
- a refreshed **web page served by the controller itself**

It does not replace the controller's firmware logic. Scheduling and valve switching stay on the controller.

The owner's household has two users:

- **The owner** uses Siri mostly, sometimes Alexa, and uses the app.
- **The second user** uses **only Alexa voice** and will not use the app.

So voice is a primary interface, not an add-on, and Alexa must be as dependable as Siri.

**Why now:**

- **The current app is hard to use.** It is the official OpenSprinkler app, built on jQuery Mobile from 2014. Running a single zone takes too many unclear steps.
- **Voice is indirect.** Today it goes through a Vera Z-Wave hub plugin into Homebridge, and that plugin has been dormant since 2021.
- **The controller is unreliable.** It drops off the network on its own, which is a known issue with legacy Ethernet boards.

**Success looks like:**

- "Alexa, turn on the back yard", "Hey Siri, turn on the back yard" and "Hey Siri, water the back yard in Rainmaker for 15 minutes" all start water within about 2–3 seconds, every time. Phrases that carry a duration must include the app name, because that's an App Shortcuts rule.
- Running a zone from the app takes two taps.
- A controller dropout is noticed and recovered automatically, and the owner is told about it.
- Anyone else with an OpenSprinkler controller can install Rainmaker from GitHub and set it up without editing code.

## 2. Goals, non-goals, anti-goals

**Goals**

1. Siri and Alexa can start and stop each zone, pause watering, and turn the system off and on.
2. A native iOS/iPadOS app with the photo-card home screen, schedule management, pause, and warnings, as mocked up.
3. A refreshed on-controller web page matching the app's design, installed without flashing firmware.
4. Update the controller to the newest firmware its board supports.
5. Resilience: detect when the controller is offline, recover it, and report it.
6. Publish publicly on GitHub, configurable for anyone's controller.

**Non-goals (for now)**

- Replacing the controller hardware. The owner wants to keep the old board. A hardware upgrade stays documented as a future option (§10).
- Android support.
- Matter. Neither Apple Home nor Alexa supports the Matter water-valve type as of 2026-10 (see the voice research).
- Building any new integration for Vera. Vera stays for the owner's other Z-Wave devices.
- Commercial use. Rainmaker is free, with no monetization.
- Hosting any public web server or cloud service.

**Anti-goals: things that would count as failure even if everything technically works**

- **Noticeable delay** between a command (voice, app or web) and the valve opening. The owner called this the main thing they'd wince at. Slowness is a bug, not a quirk.
- Voice commands that silently do nothing, for example because the controller is offline and nobody was told.
- Exposing the controller to the internet. Its password travels as an unsalted MD5 over plain HTTP.
- Zones showing up twice in Apple Home, once from Vera and once from Rainmaker.

## 3. Constraints and known facts

**Controller**

- An old OpenSprinkler v2-family board with Ethernet only and an expansion port.
- **The exact revision is unknown.** The controller is currently offline, and the owner will read it once they're in front of it. Check `hwv` from `/jo`, or the LCD at boot.
  - **v2.0, v2.1, v2.2** (ATmega644): the last firmware is **2.1.7**. There is **no MQTT**, 4 KB RAM, and a 950-byte network buffer.
  - **v2.3** (ATmega1284P): the last firmware is **2.2.1(4) AVR hotfix 1**. It has MQTT, but needs a working microSD card.
  - Neither has OpenThings Cloud, HTTPS or over-the-air updates.
- **One request at a time.** The AVR web server handles one TCP client at a time with a 5 s timeout, and concurrent requests queue or fail. **Everything must go through a single serialized client** (the hub, §5.1).
- **The controller drops off the network.** The firmware's daily auto-reboot program needs 2.1.9 or later, so it only helps on v2.3.

**Owner's environment**

- **Homebridge** runs on a **Windows 11** PC under Node.js. That PC must be set to **never sleep**.
- An **Apple TV HD** acts as the Apple Home hub. This gives Siri and the Home app remote access. Confirm the Apple TV HD is still supported as a home hub on the current tvOS.
- Echo devices for Alexa.
- **Vera** runs other Z-Wave accessories. It currently also exposes the sprinkler zones to HomeKit, for visibility only.
- iPhone and iPad only.
- Remote control away from home is required.

**Platform facts that shape the design**

- **Alexa has no sprinkler or valve device type.** Through `homebridge-alexa`, HomeKit valves appear in Alexa as on/off devices, and Alexa can't pass a duration. `homebridge-alexa`'s cloud relay is a paid subscription, roughly the price of a coffee a month.
- **Apple Home valves run for their preset duration.** Siri may not parse "for 10 minutes" against a Home valve. A native app with App Intents can take a duration.
- **The web page can be swapped without flashing.** The controller's web page is a tiny loader that pulls the interface from the URL in the `jsp` setting (`/cu?jsp=…`). Pointing `jsp` at Rainmaker's web bundle replaces the page. Resetting it restores the stock UI.

## 4. Decisions made with the owner

| Topic | Decision |
|---|---|
| Name | **Rainmaker**. GitHub repo: `rainmaker-sprinkler`. Wording: "works with OpenSprinkler controllers" (nominative use). Never call the product "OpenSprinkler". |
| Distribution | Free and public on GitHub. Not commercialized. |
| Hardware | Keep the existing board for now. |
| App platform | Native iPhone and iPad app. No Android. |
| Home screen | **Photo cards** (mockup option C), plus the **progress bar** from A on the running zone and the **weather line** from B. It shows the forecast, the next scheduled watering, and whether rain skip is on. |
| Run a zone | Tap a card, then a bottom sheet appears with 5/10/15/20 min, a custom time, and Start. |
| Concurrent runs | A zone started while another is running **queues** behind it. |
| Schedules | Several schedules. Each has any weekdays, several start times a day, and a set of zones with per-zone minutes. **Zones run in the controller's fixed zone order**, which the owner accepted. Schedules stay on the controller, so they run even if the PC is down. The editor does not offer reordering. |
| System off + manual run | **Manual runs still work while the system is off**, by voice, app or web. Only schedules stop. |
| App distribution | The owner has a paid Apple Developer account already set up in Xcode. Ship through **TestFlight**. That enables APNs push, widgets and Live Activities. Others build from source with their own account. |
| Alexa cost | The owner **accepts** the `homebridge-alexa` subscription. It is the documented Alexa path for everyone. |
| Licence | **MIT**. Rainmaker is written fresh, with no code copied from the AGPL OpenSprinkler app. |
| Commits | Authored with the GitHub no-reply address, not a personal or work email. |
| Pause | Pause **one schedule** or **all watering**, until a date, up to years ahead. Separately, turn the **whole system off** until it's turned back on. |
| Voice pause/off | Yes. Pause and system on/off work by voice on both assistants. |
| Warnings | When starting from the app or a Rainmaker Siri command, warn if **rain is forecast** or the **zone ran within the last hour**. Each warning can be **switched off** in Settings, and the "recently" window is adjustable (default 1 hour). |
| Alexa / Home-tile commands when a warning applies | **Run anyway, with no notification.** |
| Vera | Out of scope. Remove the sprinkler devices from Vera's HomeKit bridge so they don't appear twice. |
| Remote access | Required. |
| Latency | As close to real time as possible. This is the top quality bar. |
| Docs | Kept in the repo only. No hosted document site. |
| Local services | A small local service on the owner's PC is fine. The "no web server" preference applied only to the document. |

## 5. Architecture

```
 Siri (Home app)      Alexa                 Rainmaker iOS app       Browser
      │             (Amazon cloud)        (App Intents, widgets)       │
      │                   │                        │                   │
      ▼                   ▼                        │       loads UI from controller
 ┌──────────────── Homebridge (Windows 11 PC) ─────┼───────────────────┤
 │ homebridge-alexa ◄── HomeKit accessories        │                   │
 │                         ▲                       ▼                   ▼
 │           ┌─────────── Rainmaker Hub (Node.js) ──────────────┐
 │           │ single serialized controller client · state cache │
 │           │ push events · pause-until scheduler · weather     │
 │           │ watchdog · photos & settings store · local API    │
 │           └──────────────────────┬────────────────────────────┘
 └──────────────────────────────────┼─────────────────────────────
                                    │ HTTP (one request at a time)
                                    ▼
                    OpenSprinkler v2 controller (Ethernet)
                    serves tiny loader page → jsp → Rainmaker web bundle
```

### 5.1 Rainmaker Hub (companion service)

This is the **only** thing that talks to the controller. Every other client (Homebridge accessories, the app, the web page) talks to the hub.

**Packaging (my call):** a Node.js/TypeScript package that runs as a **Homebridge platform plugin** (`homebridge-rainmaker`), in its own child bridge.

- **Why:** the owner already runs Homebridge as a Windows service. One install gives the hub, the HomeKit accessories and the Alexa path, and the hub inherits Homebridge's auto-start and restart behaviour.
- **Structure:** keep the core in a separate module with no Homebridge dependency, so it can also run standalone (`npx rainmaker-hub`) for people without Homebridge.

**Responsibilities**

1. **Serialized controller client**
   - One in-flight request at most, with a priority queue in which **commands (start, stop, pause, enable) preempt status polls**.
   - Use lightweight endpoints for polling (`/js`, `/jc`), with `/jp` and `/jn` only when something has changed.
   - Configurable timeouts, short by default, so failures surface fast.
   - Handle both password formats: a plaintext `pw` on firmware ≤2.1.6 and an MD5 `pw` on ≥2.1.7.
2. **State cache and push**
   - Keep a live model of zones, the running and queued zones, remaining time, schedules, pause state and system enabled.
   - Push changes to clients over **WebSocket or Server-Sent Events**.
   - Poll `/js` and `/jc` about every 2–5 s, faster while something is running. On a v2.3 with MQTT enabled, subscribe to station events for instant updates.
3. **Optimistic commands with confirmation**
   - On a command, reflect the "starting" state immediately to every client.
   - Send the command, then read back status right away to confirm, or roll back with a clear error.
4. **Pause-until scheduler**
   - **Pause all** uses the controller's rain delay (`/cv?rd=hours`, max 32767 h, about 3.7 years).
     - **(My call)** The controller's own weather-driven auto rain delay uses the same single value. The hub therefore records each delay it set, with the user's intended end time, and shows the reason ("Paused by you until…" or "Rain delay from weather until…").
     - If a weather delay overwrites a user pause and ends sooner than the pause would have, the hub re-applies the user's pause.
     - "Resume" and switching off "Sprinkler Pause" clear the delay entirely. That's an explicit user action, so it wins.
   - **Pause one schedule until a date** is done by the hub: it disables the program (`/cp` enable flag) and re-enables it on the date. Pending re-enables are persisted, so they survive restarts.
   - **System off/on** uses the controller's operation enable (`/cv?en=0|1`).
5. **Weather lookup for warnings and the home-screen line** (my call): use **Open-Meteo**, which is free and needs no API key, for rain probability over the next 24–48 h at a configured location. This is separate from the controller's own weather adjustment, which stays as configured on the controller.
6. **Last-run tracking:** from the controller's log endpoint (`/jl`), plus the hub's own command history. This drives the "ran recently" warning and the "Last ran…" lines.
7. **Watchdog**
   - Detect offline after N failed polls.
   - Mark everything offline right away, so commands fail fast with a clear message instead of hanging.
   - Optionally power-cycle the controller through a smart plug, rate-limited. **(My call)** There are two supported ways:
     - **(a) Direct:** a plug with a documented local API that the hub calls itself. Shelly, Tasmota and TP-Link Kasa are the first targets.
     - **(b) HomeKit automation:** the hub exposes a **"Sprinkler Controller Online" contact sensor**. The user creates a Home automation: when it opens, turn the plug off, then on after about 30 s. That works with any HomeKit plug, including a Z-Wave plug bridged from Vera.
     - The setup guide covers both.
   - Notify on offline and recovery.
8. **Store**
   - Zone photos, display names and order.
   - Default voice durations per zone.
   - Warning settings.
   - Pending pause-until jobs and pairing tokens.
   - A small local data folder (JSON or SQLite, builder's choice).
9. **Local API** (HTTP + WebSocket)
   - Used by the app and the web page.
   - Auth uses per-device tokens issued at pairing: the hub shows a QR code or pairing code, and the app or web page scans or enters it.
   - **The controller password never leaves the hub.**
   - CORS must allow the controller's origin, because the web page is served from the controller's IP.
10. **Bonjour/mDNS advertisement** so the app finds the hub on the LAN.

### 5.2 Siri

**Two paths, both supported.**

**a) Apple Home (via the hub's HomeKit accessories)**

- One **IrrigationSystem** with a linked **Valve** (type: irrigation) per zone. Valve names are the spoken zone names. SetDuration is the zone's default voice duration, and it **persists across restarts**.
- Extra **Switch** accessories:
  - **"Sprinkler System"**: on means enabled.
  - **"Sprinkler Pause"**: on means everything is paused until it is switched off. Implemented as the maximum rain delay, and cleared when switched off.
  - **"Pause Sprinklers 1 Day"** and **"Pause Sprinklers 1 Week"**: momentary switches that set a timed rain delay. (My call: this gives Alexa routines fixed durations to call.)
- This path works with no Rainmaker app installed, and it's what Alexa sees.

**b) Rainmaker app App Intents**

- App Shortcuts phrases must contain the app name, for example *"Hey Siri, water the back yard in Rainmaker for 15 minutes"* or *"…with Rainmaker"*. Zone-only phrases with no duration go through Apple Home (path a).
- Commands that take parameters: *Water [zone] for [minutes]*, *Stop watering*, *Pause watering for [duration] / until [date]*, *Resume watering*, *Turn sprinkler system off/on*, *What's watering?*.
- These run the warning checks and can ask for spoken confirmation ("Rain is forecast tomorrow. Water anyway?").
- They call the hub directly. Remotely, they go over the private network (§5.6).

### 5.3 Alexa

- Use **`homebridge-alexa`** (NorthernMan54), which exposes the hub's HomeKit accessories to Alexa.
- Valves appear as on/off devices: "Alexa, turn on back yard" runs for the zone's default duration.
- The switches give "Alexa, turn on Sprinkler Pause" and "Alexa, turn off the Sprinkler System".
- The owner configures **Alexa routines** for friendly fixed phrases, for example *"Alexa, pause sprinklers for a week"* turns on "Pause Sprinklers 1 Week". The repo includes a step-by-step routine setup guide.
- **Alexa-originated and Home-tile commands skip the warnings and send no notification**, per the owner's decision.
- Expected latency is about 2–3 s, because Alexa round-trips through Amazon's cloud. That is the floor.

### 5.4 iOS/iPadOS app

- **Native SwiftUI**, iPhone and iPad.
- **Home screen**, as mocked up in `docs/mockups/home-layout-v2.html`:
  - "Online" status.
  - A weather line: conditions, rain chance, next scheduled watering, rain-skip state.
  - **Photo cards** per zone. The owner can take or pick a photo per zone, stored on the hub. The running zone gets a highlight outline, "RUNNING", time left, a Stop button and a **progress bar**. Other cards show "Last ran…" or "Up next…" and a Run button.
- **Run sheet:** tap a card for 5/10/15/20 min chips, a custom time, and Start. If another zone is running, it says the new run will queue. Warnings appear here before starting.
- **Schedules tab**, as mocked up in `docs/mockups/schedules.html`:
  - A system on/off card.
  - "Pause all…" and "Turn system off" buttons.
  - A list of schedules, each with an on/off toggle and a "Paused until …" tag.
  - A schedule editor: weekdays, several start times, the zones with minutes listed in the controller's zone order (no drag-to-reorder), and a weather-adjust toggle. The mockup's "(IN ORDER)" label means the fixed zone order.
  - Schedules map onto controller programs.
- **Pause sheet:** until tomorrow, 3 days (with the forecast reason shown when there is one), a week, or until a date. Available for all watering and for single schedules.
- **Settings:** hub connection and pairing; zones (names, photos, order, default voice duration); warnings (rain forecast on/off, recently-ran on/off, window length); offline notifications on/off; location for the weather lookup.
- **Live updates:** a WebSocket to the hub while in the foreground. No pull-to-refresh is needed.
- **Extras, phased later:** Home Screen and Lock Screen widgets, a Live Activity countdown while a zone runs, and Control Center controls.
- **Firmware coverage (my call):**
  - **Fully supported and tested:** v2.x boards on firmware 2.1.7 through 2.2.1(4), via the simulator and the owner's board.
  - **Best effort:** newer boards (v3, v4, OSPi on current firmware). They use the same API, and the hub detects capabilities from `/jo` and `/jc` and hides what the controller lacks.
  - Firmware older than 2.1.7 isn't supported. The setup guide says to update first.

### 5.5 On-controller web page

- A small static web bundle with the same design as the app (photo cards, run sheet, schedules, pause). Keep it light: a minimal framework or none. Builder's call.
- **Hosting:** the bundle is published from the public GitHub repo and served through a public file CDN (e.g. jsDelivr, pinned to a release tag). The controller's `jsp` setting points there.
  - Nothing is self-hosted, and the controller's flash is untouched.
  - Reverting means setting `jsp` back to `https://ui.opensprinkler.com/js`.
- **Connection:**
  - If the hub is reachable, the page connects to it, with the hub address remembered in the browser and entered once, and gets live updates and photos.
  - **If the hub is unreachable, it falls back to talking to the controller directly** in a basic mode: zone list, run/stop, pause and system on/off, with no photos. It still serializes requests.
    - **(My call)** Fallback mode asks for the controller password and keeps it **in memory only for that browser tab**, never saved. That is the same trust level as the stock web page.
    - "The password never leaves the hub" applies to hub clients, not to this deliberate fallback.
  - The page must work on a phone browser too.
- The setup guide covers changing `jsp`, including the exact `/cu` call or the stock UI setting.

### 5.6 Remote access

- **Siri and the Home app** work remotely via the Apple TV HD home hub.
- **Alexa** works remotely by design.
- **The Rainmaker app** works remotely through a **private network (Tailscale)**: the Windows PC and the iPhone/iPad join the same tailnet, and the app uses the hub's tailnet address when the LAN isn't reachable.
  - No router ports are opened.
  - The controller is **never** exposed to the internet.
  - Documented as the recommended setup. Others may substitute WireGuard or similar.

### 5.7 Notifications

- **Controller offline / back online** (my call; the owner can switch it off).
- **Delivery:** APNs push from the hub, using the owner's Apple Developer account. A token-based APNs key is configured on the hub. It also powers remote Live Activity updates.
  - **(My call)** For people building from source without APNs set up, the hub can instead post to a self-chosen relay (ntfy topic or Pushover).
- **Telling the Alexa-only user about failures (my call):**
  - Through `homebridge-alexa`, a command to an offline controller can only produce Alexa's "device is not responding". There is no richer spoken error.
  - That's mitigated by fast offline detection and auto-recovery, plus the owner's offline push notification.
  - Alexa announcements are out of scope, because they would need a custom skill or cloud service.
- Warnings are in-app or spoken prompts, not push notifications.

## 6. Latency budget (top quality bar)

| Path | Target: command → valve open | How |
|---|---|---|
| App / web → hub → controller | ≤ 1.5 s on LAN | Commands preempt polls. Optimistic UI. Immediate confirm read. |
| Siri (Home valve or App Intent) | ≤ 2 s | HomeKit on LAN via the home hub. The hub sends immediately. |
| Alexa | ≤ 3 s | Floor set by Amazon's cloud round-trip. |
| UI reflecting a change made elsewhere | ≤ 1 s after the hub knows | Push over WebSocket/SSE. Faster polling while running. MQTT on v2.3. |
| Controller offline | Fail with a message in ≤ 3 s | Short timeouts. The watchdog flags offline state. |

These are estimates until measured on the real board. **Measure them in Phase 1** with a simple timing harness, and treat misses as bugs.

## 7. Firmware plan

1. Read `hwv` and `fwv`. **Export the controller configuration** first; a major-version jump resets settings and the password to `opendoor`.
2. **v2.3:** flash `os_221_rev4_avr1.hex` with avrdude over USB (CH340 driver; `-c arduino -p m1284p -b 115200`). Make sure a microSD card is present. Then:
   - Enable MQTT to a local broker (e.g. Mosquitto on the Windows PC). The hub subscribes for instant updates.
   - Add the firmware's daily reboot program as an extra guard against network dropouts.
3. **v2.0, v2.1, v2.2:** flash **2.1.7** with the board-specific avrdude command (see the firmware research). There's no MQTT, so the hub relies on polling plus its watchdog.
4. Write a step-by-step flashing guide for macOS and Windows in the repo.
5. **A custom Rainmaker firmware fork is out of scope for now.** The 644 boards have no free code space, and the hub covers the reliability gaps. Revisit only if the measured latency or dropouts need on-board fixes.

## 8. Phases

| Phase | Delivers | Done when |
|---|---|---|
| 0. Controller | Board identified, config exported, firmware updated, Vera's sprinkler devices removed from HomeKit | `hwv`/`fwv` recorded, controller stable on the LAN |
| 1. Hub core | Serialized client, state cache, push API, watchdog, pause-until, **controller simulator** for development and tests, latency harness | Latency targets measured on the real board |
| 2. Voice | Homebridge plugin accessories (valves, switches), `homebridge-alexa`, Alexa routine guide | Siri and Alexa start/stop/pause/off within targets |
| 3. App | SwiftUI app: home, run sheet, schedules, pause, warnings, settings, pairing, App Intents | Owner runs a zone in two taps and by Siri with a duration |
| 4. Web page | Web bundle via `jsp`, hub mode plus direct fallback, setup guide | The controller's own page shows the new UI and reverts cleanly |
| 5. Polish | Widgets, Live Activity, offline notifications, Tailscale remote guide | Works away from home |
| Later (optional) | Hardware upgrade path (§10) | — |

Phases 2 and 3 can overlap once the hub API is stable.

## 9. Testing approach

- **Controller simulator:** a fake OpenSprinkler HTTP API that mimics a v2 controller's single-client behaviour, timeouts and both password formats. Use it for unit and integration tests and for anyone without hardware.
- Hub unit and integration tests run against the simulator. Then a soak test against the real controller: hours of polling plus commands, watching for dropouts.
- iOS: unit tests for view models and the hub client; UI tests for the run and pause flows.
- Voice is verified manually with a written checklist of phrases per assistant.

## 10. Future hardware option (documented, not planned)

If the old board's dropouts can't be tamed, the clean fix is new controller electronics in the same enclosure:

- either a current OpenSprinkler v3.4 or v4 (about $135–$203)
- or a DIY ESP32 build

The existing 24 VAC transformer and the field wiring carry over. v2 expansion boards are not compatible with v3/v4. Rainmaker's hub and app would work unchanged, because they talk to the same API.

## 11. Left to the builder

- Choice of web framework for the bundle, storage format for the hub, and internal module layout.
- Exact polling intervals and timeouts within the latency budget.
- The app's visual polish beyond the mockups: typography, icons, dark mode.
- Test tooling choices.

## 12. Calls I made (owner to check)

- The hub is packaged as a Homebridge plugin, with a standalone mode.
- Open-Meteo is the forecast source.
- Fixed-duration pause switches ("1 Day", "1 Week") for Alexa routines.
- Offline/online notification on by default.
- Tailscale for remote app access.
- The web bundle is served from the GitHub repo via jsDelivr.
- No custom firmware for now.
- Smart-plug recovery: direct local-API plugs, or a HomeKit automation on an exposed "controller online" sensor (§5.1).
- The pause and weather rain-delay conflict is handled by the hub tracking who set the delay (§5.1).
- The web fallback asks for the controller password and keeps it per tab, in memory only (§5.5).
- Alexa-only failures surface as "not responding", mitigated by auto-recovery and the owner's push alert (§5.7).
- Supported range: v2.x on 2.1.7–2.2.1(4) tested, newer boards best effort (§5.4).
- Siri duration phrases include "Rainmaker" (§5.2).

## 13. Open items

- **Board revision and firmware** (`hwv`/`fwv`): the owner reads these when the controller is back online. Phase 0 branches on the result (§7).
- **Apple TV HD as home hub:** confirm it's still supported on the current tvOS before relying on it for remote Siri and Home access.
