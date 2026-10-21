# OpenSprinkler App: Research Report (2026-10-21)

## 1. The official OpenSprinkler-App

**Repo:** https://github.com/OpenSprinkler/OpenSprinkler-App — AGPL-3.0, about 208 stars, JavaScript. It is **actively maintained**: the last push was 2026-10-21, an Android back-nav fix landed for Cordova 15.1 (Sep 2026), and phone card-width fixes landed in Oct 2026 (PR #317). The last GitHub *release tag* is v2.4.7 (2024-11-26), but the store builds are newer (iOS shows 2.4.104).

**Tech stack** (verified from the repo):
- **jQuery Mobile 1.4.5** (built 2014-10-31, a long-dead framework) on **jQuery 2.1.1**, in `www/vendor-js/`.
- Charts and tables come from Chart.js (with the zoom plugin), ApexCharts, vis-timeline and DataTables.
- Source is hand-written ES5-style modules in `www/js/modules/` (programs, stations, weather, logs, sites, sensors, analog, groups, notifications, import-export, firmware, system-diagnostics…). There is no framework and no TypeScript.
- **Apache Cordova** wraps it for iOS, Android and macOS (cordova-ios 7, cordova-android 15.1), with Grunt builds, Karma/Mocha tests and Transifex localization.
- `www/` also includes `manifest.json` and `sw.js`, so it is PWA-ish.

**Distribution:** the app is on the Apple App Store (iOS id830988967, macOS id903464532), Google Play (`com.albahra.sprinklers`) and the Amazon Appstore, all listed in the README. The **same code base is hosted at https://ui.opensprinkler.com** (Firebase hosting, per `firebase.json`/`.firebaserc`). It also works as a hosted web app using a controller IP or an OTC token.

**How the device's on-board web page loads the UI.** The firmware serves almost no UI. `server_home()` in [api/server.cpp](https://github.com/OpenSprinkler/OpenSprinkler-Firmware/blob/master/api/server.cpp) emits:

```html
<!DOCTYPE html><html><head>…mobile header…</head><body>
<script>var ver=<fw>,ipas=<ignore_pw>;</script>
<script src="<JSP>/home.js"></script></body></html>
```

- `JSP` is the string option `SOPT_JAVASCRIPTURL`. Its default is `https://ui.opensprinkler.com/js` (`DEFAULT_JAVASCRIPT_URL` in [defines.h](https://github.com/OpenSprinkler/OpenSprinkler-Firmware/blob/master/defines.h)).
- `www/js/home.js` works out its own base URL from its `<script src>`, then injects the CSS and JS of the full app. It sets `window.currLocal = true`, which hides the multi-site menu.
- You change the JSP with **`/su`** (a "UI Source" form with a Reset button), or through the API as `/cu?pw=<md5>&jsp=<url-encoded>`. The JSP value is returned as `jsp` in `/jo` options. See the [API docs](https://github.com/OpenSprinkler/OpenSprinkler-Firmware/blob/master/docs/docs/2.2.1/221_4_api.md) and the [App README](https://github.com/OpenSprinkler/OpenSprinkler-App#unified-firmware).
- The `jsp` option has existed since firmware 2.0.3.

**Key implication for the user:** a custom UI can replace the on-device web page simply by hosting a `home.js` bootstrap (on a LAN server, a NAS, or GitHub Pages over HTTPS) and pointing `jsp` at it. No firmware change is needed, and setting `jsp` back to the default reverts it.

**Caveat: mixed content.** The device serves plain HTTP. A JSP pointing to a LAN `http://` host is fine. An `https://` script calling back to an `http://` device works today because the script is loaded *into* the HTTP page, so its origin is the device.

**Open issues** (10 open; themes from the [issue list](https://github.com/OpenSprinkler/OpenSprinkler-App/issues)):
- Login/change-password flow (#315).
- A long browser cache on ui.opensprinkler.com breaks returning browsers after a layout change (#310).
- Unit bugs, for example flow shown in L/min when metric is off (#305).
- A fertigation feature request (#283).

Recently closed issues reflect UX debt: feature discoverability (#292), truncated labels (#290), empty states showing a raw `[]` (#289), cryptic diagnostics (#288), timezone bugs (#287), basic-auth problems on Android and Firefox (#273, #274), and many "JavaScript Error: Script error" crash reports.

## 2. User complaints

The evidence is thin. Reddit search returned nothing useful, so this section is **partly uncertain**.

- **[App Store](https://apps.apple.com/us/app/opensprinkler/id830988967):** 3.9★ from only 29 ratings. Reviewers say "the UI is a bit awkward" and "the UI could be better". Several say connection or site info was **lost on app updates**; the developer's answer is Cloud Sync. One reports a broken connection after an update. These reviews are dated 2018–2021.
- **Accessibility ([AppleVis](https://www.applevis.com/comment/55306)):** buttons have no labels, and the manual-run duration slider can't be operated with VoiceOver.
- **Forums** ([Mobile & Web App forum](https://opensprinkler.com/forums/forum/opensprinkler-mobile-app/)): "[some user interface suggestions?](https://opensprinkler.com/?p=36113)" and bug threads such as "[Manual Station Status Bug](https://opensprinkler.com/forums/topic/manual-station-status-bug/)". The usual reply is to update the firmware.
- **Firmware-fork breakage:** in July 2026, opensprinklershop.de said a new official app release broke its extended (analog-sensor) firmware and pointed users to its own "OpenSprinklerASB" app ([notice](https://opensprinklershop.de/en/2026/07/30/wichtig-neue-opensprinkler-app-hersteller-usa-nicht-mehr-mit-der-opensprinklershop-firmware-kompatibel-bitte-opensprinklerasb-app-verwenden/)).
- **Inferred pain points** (from the stack and the issues, not from user quotes): dated jQuery-Mobile look, dense settings pages, slider-based duration entry, no native widgets, Live Activities or rich notifications, deep settings for common tasks, and cache/version skew between the hosted UI and the firmware.

## 3. Feature inventory (official app)

From the README, the `www/js/modules/*` names and the [firmware docs](https://github.com/OpenSprinkler/OpenSprinkler-Firmware/tree/master/docs/docs/guides):

| Area | Features |
|---|---|
| Home | Station cards with status, manual start/stop, a running-station queue, controller status |
| Programs | Add, edit, delete and preview (timeline); weekday, interval and odd/even schedules; multiple start times; sunrise/sunset starts; date ranges; per-program weather adjustment flag |
| Run-once / manual | A one-time program, manual station run, and a "single run" program date |
| Stations | Names, enable/disable, attributes (master valves, sequential groups, ignore rain/sensor), special stations (RF, remote, GPIO, HTTP) |
| Weather | Methods: Manual, Zimmerman, Auto Rain Delay, ETo, Monthly; multi-day levels, weather restrictions, choice of provider (including local PWS) |
| Rain delay | Set and clear |
| Sensors | Rain/soil and flow sensors; analog sensors (newer firmware); flow stats |
| Logs | Table, timeline and charts (water level, flow); export |
| Multi-site | Site manager in native and hosted builds (hidden in on-device mode); Cloud Sync of sites via an opensprinkler.com account |
| Remote access | OTC token sites ([OTC guide](https://github.com/OpenSprinkler/OpenSprinkler-Firmware/blob/master/docs/docs/guides/remote-access-otc.md)) |
| Integrations | MQTT, IFTTT, email notifications |
| Other | Import/export config, firmware update page, system diagnostics, ~30 languages |

**Important for an OpenSprinkler v2:**
- **OTC is supported only on OS v3, v4, OSPi and Linux**, not v2 (per the OTC guide). Remote access for v2 needs a VPN or reverse proxy.
- **Firmware 2.1.9 requires OS 2.3 (ATmega1284). Boards 2.0–2.2 are capped lower** ([support](https://support.opensprinkler.com/support/solutions/articles/5000832311-opensprinkler-2-x-firmware-update-guide), [forum](https://opensprinkler.com/?p=69209)).
- The current firmware tree (2.2.1) has **no AVR build target** in `platformio.ini` (it targets only ESP8266, ESP32-C6, Linux and demo). A v2 is therefore probably frozen at around 2.1.9 (*the exact last AVR version is uncertain*).
- A new app must target that older `/jc`, `/jo`, `/jp` API, with fewer options and no analog sensors or OTC.

## 4. Alternatives and modern UX references

**OpenSprinkler ecosystem:**
- [vinteo/hass-opensprinkler](https://github.com/vinteo/hass-opensprinkler) (Home Assistant integration, about 264 stars, active Oct 2026; Python lib [py-opensprinkler](https://github.com/vinteo/py-opensprinkler)).
- HA cards: [rianadon/opensprinkler-card](https://github.com/rianadon/opensprinkler-card), [rlsgit/hacs-ospi-card](https://github.com/rlsgit/hacs-ospi-card), [EdLeckert/opensprinkler-preview-card](https://github.com/EdLeckert/opensprinkler-preview-card).
- **[HydroDash](https://github.com/gilbertorconde/HydroDash)** (Apache-2.0, created Apr 2026): React 19, TanStack Start and React Query, mobile-first. It has two-tap zone runs with 5/10/15/30-min chips, a live "Now running" header, customizable home cards, a program editor that keeps advanced options out of the way, a history timeline, and ntfy push notifications. It uses a server-side proxy so the password never reaches the browser. This is **the closest prior art for the user's goal.**
- Also: Homebridge ([rjames86/homebridge-opensprinkler](https://github.com/rjames86/homebridge-opensprinkler)), MCP servers ([marcinn2](https://github.com/marcinn2/opensprinkler-mcp), [koolsb](https://github.com/koolsb/open-sprinkler-mcp)), an ESP32 touch panel ([gregose/opensprinkler-panel](https://github.com/gregose/opensprinkler-panel)), and the OpenSprinklerShop ASB app/firmware ([docs](https://opensprinklershop.de/en/opensprinklershop-firmware/)).
- SIP (Sprinklers Pi) and OSPy are Pi-only alternative *firmwares*. They are not relevant to a v2 board.
- **No Flutter or native-Swift OpenSprinkler client with traction was found** (uncertain).

**Commercial bar:**
- **Rachio** ([app changes](https://rachio.com/blog/rachio-app-changes)): zone photos and per-zone details, a weather feed with a 10-day forecast of scheduled runs and skips (rain, freeze, wind), cycle-and-soak, and smart schedules from soil, plant, sun and slope data. Native Live Activities are **unconfirmed**; users fake them through IFTTT with the Notify! app ([applet](https://ifttt.com/applets/dsXaC8Qi-show-a-live-tile-while-the-sprinklers-are-running)).
- **Orbit B-hyve** ([GearBrain](https://www.gearbrain.com/amp/bhyve-smart-sprinkler-timer-reviews-2467596827), [Tom's Guide](https://www.tomsguide.com/us/orbit-bhyve-faucet,review-5593.html)): a guided smart-watering setup (soil, vegetation, sun, slope, catch-cup calibration), water history, and push notifications for rain delay and watering complete. It is criticized for a confusing smart-watering UI and Wi-Fi drops.
- **Rain Bird:** keeps working locally during outages, but its app is sluggish through the Wi-Fi module ([Smart Home Hookup](https://www.thesmarthomehookup.com/test_install/?p=1138)).
- **Takeaways for a new app:**
  - Upcoming-schedule calendar with skip reasons.
  - Zone photos and nicknames.
  - Quick-run duration chips instead of sliders.
  - Push notifications: run start/end, rain delay set, offline controller.
  - Home-screen widgets and a lock-screen Live Activity for a running zone.
  - Water-use history.
  - Guided setup.
  - Accessible controls.

## 5. Licensing

- **App: AGPL-3.0** (`LICENSE`, `package.json`, file headers "Copyright (C) 2015 – present, Samer Albahra").
  - A personal fork is fully allowed: modify it and run it privately.
  - Obligations start when you *distribute* it, or let others *interact with it over a network*. You must then offer the complete corresponding source under AGPL.
  - Hosting a modified UI publicly, or serving it as the JSP to other users, counts. Your own household use effectively does not.
  - Derived code cannot be relicensed. A clean-room app that only calls the HTTP API is not a derivative and can use any license (*a general reading, not legal advice*).
- **Firmware: GPL-3.0.** You don't need to touch it, because changing `jsp` is just a setting.
- **Weather service** ([OpenSprinkler-Weather](https://github.com/OpenSprinkler/OpenSprinkler-Weather)): GitHub detects no license. *Uncertain.*
- **Trademark:** publishing to the stores under the "OpenSprinkler" name or icon could raise trademark issues. *Uncertain*; avoid it for a personal app.
