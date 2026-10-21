# OpenSprinkler voice control (Siri and Alexa): research report

_Researched 2026-10-21. Package and repository dates come from the npm registry and the GitHub API on that day. Items marked **(uncertain)** have not been verified._

## 0. First check your hardware and firmware version

Everything below depends on which board you have. Call `http://<os-ip>/jo?pw=<md5>` and read `hwv` and `fwv`.

- **OS 2.3** (the last AVR board with Ethernet only) is limited to **firmware 2.2.1(4)**. Firmware 2.2.1(5) dropped v2.3 and told v2.3 users to stay on 2.2.1(4) ([release notes](https://newreleases.io/project/github/OpenSprinkler/OpenSprinkler-Firmware/release/221%285%29)). Current builds target only ESP8266 (OS3), ESP32-C6 (OS4) and Linux ([platformio.ini](https://github.com/OpenSprinkler/OpenSprinkler-Firmware/blob/master/platformio.ini)).
- **OS 2.0 to 2.2** cannot run firmware 2.1.9 or later because of code size ([2.x update guide](https://support.opensprinkler.com/support/solutions/articles/5000832311-opensprinkler-2-x-firmware-update-guide)). On those boards you get no MQTT, and the plugins below that need 2.1.6+ or MQTT may be affected.

## 1. Homebridge plugins for OpenSprinkler

| Plugin | Last publish | Homebridge v2 | HomeKit model | Notes |
|---|---|---|---|---|
| [`@rjames86/homebridge-opensprinkler`](https://github.com/rjames86/homebridge-opensprinkler) | v0.1.3, 2026-10-11 | engines `^1.8 \|\| ^2.0` ✅ | **IrrigationSystem + linked Valve per zone** | Optional rain-delay switch, program trigger switches, rain/soil ContactSensor, water level as HumiditySensor. SetDuration is persisted across restarts. Uses MQTT for live state and falls back to REST polling. Needs the MD5 password hash. Very new: 0 stars, one author, not verified. |
| [`homebridge-opensprinkler-api`](https://github.com/homebridge-plugins/homebridge-opensprinkler-api) (koryhutchison, now in the homebridge-plugins org) | v2.0.4, 2023-06-08 (last commit) | engines `>=1.4.0` (v2 not stated, **uncertain**) | IrrigationSystem + Valves (with `defaultDuration`) | **Homebridge Verified** ([verified list](https://github.com/homebridge/verified)). Needs firmware **2.1.6+**. Durations you change in the Home app reset on restart. No program support. Polling only. |
| [`homebridge-opensprinkler`](https://github.com/timcharper/homebridge-opensprinkler) (timcharper) | v0.2.1, 2018 | No (built for HB 0.4.x) | Irrigation and valves, rain delay | Abandoned |
| `homebridge-opensprinkler-system`, `homebridge-http-opensprinkler(-api)` | 2019–2020 | No | Switch-style | Abandoned |
| `@7fab-co/homebridge-opensprinkler` | v0.1.0, 2026 | engines `>=1.8` | Unknown | The GitHub repo returns 404. **Avoid (uncertain status)** |

**How zones map to HomeKit.** The controller becomes one `IrrigationSystem` service. Each zone is a linked `Valve` with `ValveType = IRRIGATION`, with `SetDuration` (seconds) and `RemainingDuration` characteristics. The Home app shows a "Sprinklers" tile with per-zone run times.

**Siri.** "Hey Siri, turn on the front lawn" or "turn off the sprinklers" works with valve and irrigation accessories. Spoken durations ("…for 10 minutes") are **not** reliably parsed for valves **(uncertain; test this)**. Instead, the zone runs for its configured `SetDuration`. Workarounds:
- Set the per-zone duration in the Home app.
- Create Siri Shortcuts or Home scenes named, for example, "Water front lawn ten minutes".
- Add extra Homebridge switches that start a zone for a fixed time.

## 2. Alexa options

- **Official OpenSprinkler Alexa skill: none.** A community skill was never published, because Amazon would not approve it with an embedded password hash. It needed a personal AWS Lambda and an exposed controller ([forum](https://opensprinkler.com/forums/topic/amazon-echo-alexa-skil-for-open-sprinkler/)).
- **Alexa has no native valve or sprinkler type.** The 56 Smart Home display categories include nothing for valves or irrigation; the closest are `WATER_HEATER` and `OTHER` ([Alexa Discovery](https://developer.amazon.com/en-US/docs/alexa/device-apis/alexa-discovery.html)). Vendors such as Rachio and Hydrawise use custom skills ("Alexa, ask Rachio…").
- **[`homebridge-alexa`](https://github.com/NorthernMan54/homebridge-alexa)** (NorthernMan54): v0.9.3 (2025-12), active, verified, and v2-compatible (`^1.6 || ^2.0`). It exposes HomeKit **Valves and Sprinklers as a "light bulb" / Other**, so "Alexa, turn on front lawn" works. The duration still comes from the HomeKit `SetDuration`. Alexa routines can trigger zones. The cloud service now needs a **paid subscription** (about one coffee a month, PayPal, 7-day trial).
- **Home Assistant + Nabu Casa / Alexa Smart Home**: HA exposes `valve` entities to Alexa as an "unknown type" with open/close phrasing, and exposes `switch` with on/off ([HA Alexa docs](https://www.home-assistant.io/integrations/alexa.smart_home/)). This works, but it means running a whole HA instance.
- **IFTTT**: the 2016 approach was an Alexa trigger plus a Webhooks GET request to a port-forwarded controller ([openthings.io](https://openthings.io/category/iot/)). It requires port forwarding, a fixed phrase per zone/duration, and a cloud dependency. **Not recommended.**

## 3. Matter

- Matter 1.3+ defines a **Water Valve device type (0x0042)** with the Valve Configuration and Control cluster (0x0081), including auto-close after a duration ([CSA handbook](https://handbook.buildwithmatter.com/how-it-works/device-types/)).
- **Apple Home does NOT support it** as of September 2026. An Apple DTS engineer confirmed that Home rejects 0x0042 and that HAP's Valve/IrrigationSystem has no Matter equivalent. In his words, "for full Home support today, HAP is the only option" ([thread 844646](https://developer.apple.com/forums/thread/844646), [844622](https://developer.apple.com/forums/thread/844622)).
- **Alexa does NOT list it.** Its supported Matter categories have no valve or irrigation type ([Amazon](https://developer.amazon.com/en-US/docs/alexa/smarthome/supported-matter-device-categories.html)).
- Homebridge 2.0 (released 2026-05) can expose plugins over Matter. HB 2.2.0 fixed Matter water-valve open/close. One irrigation plugin (`homebridge-rainbird-local`) publishes zones as Matter WaterValves ([repo](https://github.com/chundla/homebridge-rainbird-local)). **No OpenSprinkler plugin offers Matter yet.**
- **No `matterbridge-opensprinkler` package exists on npm.** Matterbridge ([luligu](https://github.com/Luligu/matterbridge), v3.10.14) would need a custom plugin.
- **Verdict:** exposing zones as Matter Water Valves today would **not** give one integration covering both Siri and Alexa, because neither controller supports that type. The only cross-ecosystem Matter fallback is exposing each zone as an **On/Off Plug-in Unit**. Developers use this workaround, but it loses valve semantics, durations and the Sprinklers UI. It is not worth it while HAP plus homebridge-alexa works.

## 4. Vera

- [`dbochicchio/vera-OpenSprinkler`](https://github.com/dbochicchio/vera-OpenSprinkler) shows each zone as a dimmer (level = minutes), plus programs and rain delay. It supports Vera and openLuup. The last release was v1.50 in February 2021 and the last push was July 2021, so it is dormant.
- **Vera/Ezlo**: the legacy Vera Edge, Plus and Secure hubs are no longer sold, and their firmware is not being developed ([HA Vera docs](https://www.home-assistant.io/integrations/vera/)). No official shutdown date was found **(uncertain)**. Treat Vera as a legacy path.
- **Keeping Vera alongside Homebridge is fine.** Both are just HTTP API clients of the controller. Remove the Vera-to-HomeKit bridging of the zones, though, so they don't appear twice in Apple Home.

## 5. Home Assistant reference ([vinteo/hass-opensprinkler](https://github.com/vinteo/hass-opensprinkler))

v2.2.3 was released 2026-10-12 and is actively maintained (264 stars). It creates per-station/program switches, running binary sensors, status/water-level/rain-delay sensors, and a calendar. It provides the actions `run_station(run_seconds)`, `run_program`, `run_once`, `stop`, `set_rain_delay` and `pause_stations`. It is tested against API 2.2.1(4), which is also the ceiling for OS 2.3 and therefore a good match. It is useful as a reference for API usage, for example `/cm?sid=&en=1&t=` and `/cr` (run-once).

## 6. Firmware MQTT and OTC

- **MQTT publish** arrived in 2.1.9(4), on OS 2.3, 3.x and OSPi ([announcement](https://opensprinkler.com/forums/topic/announcing-opensprinkler-unified-firmware-2-1-94/)). Topics:
  - `<prefix>/station/N`, with payload `{"state":1,"duration":s}` / `{"state":0,...}`, not retained
  - `<prefix>/program/N`, `/sensorN`, `/raindelay`, `/weather`, `/system`
  - retained `/availability` ([MQTT guide](https://github.com/OpenSprinkler/OpenSprinkler-Firmware/blob/master/docs/docs/guides/mqtt.md))
- **MQTT subscribe** arrived in 2.2.1. Commands use HTTP-API syntax (for example `cm?pw=<md5>&sid=0&en=1&t=600`, or `cv?pw=...&rsn=1`). They are fire-and-forget, and topics are limited to 24 characters. Whether this works on the OS 2.3 AVR build **is uncertain**; a `221(4)-avr1` build exists.
- **OTC (OpenThings Cloud)** works only on OS 3.x and Linux, **not OS 2.3**.
- **IFTTT** in firmware is notifications only (outbound).
- Integrations mostly use the HTTP JSON API (`/jc`, `/js`, `/jo`, `/cm`, `/cr`, `/cv`). The rjames86 plugin also uses MQTT for push state.

## Recommendation

**Use Homebridge as the single hub, with HomeKit (HAP) as the canonical model and Alexa layered on top.**

1. Confirm `hwv` and `fwv`. If the board is OS 2.3, update to **2.2.1(4)**. Enable MQTT publishing to a local Mosquitto broker on the Homebridge host (optional).
2. Install **`homebridge-opensprinkler-api`** (Verified, conservative). Alternatively, install **`@rjames86/homebridge-opensprinkler`** if you want MQTT push updates, persisted durations, programs and sensors; it is newer and less battle-tested. Run either one as a **child bridge** so a crash can't take Homebridge down.
3. Install **`homebridge-alexa`**, which needs its subscription. Zones appear in Alexa as on/off devices. For "10 minutes", rely on the per-zone HomeKit duration, or add Homebridge switches or Alexa routines that start a zone for a fixed time.
4. Siri: name the valves the way you will speak them ("Front Lawn"), and create Shortcuts or scenes for specific durations.
5. Keep Vera only if other automations need it. Take its OpenSprinkler devices out of HomeKit to avoid duplicates.
6. **Skip Matter for now.** Water Valve (0x0042) is unsupported in both Apple Home and Alexa. Revisit if Apple or Amazon add it.
7. The fallback or alternative is Home Assistant with vinteo plus the HA HomeKit Bridge (sprinkler type with `linked_valve_duration`) and Nabu Casa for Alexa. It is heavier, but it gives the richest duration and automation control.

**Avoid** IFTTT, port forwarding and custom Alexa Lambdas. They expose the controller, whose MD5 password travels in the URL over plain HTTP.
