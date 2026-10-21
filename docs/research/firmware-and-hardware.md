# OpenSprinkler v2.x: firmware upgrade path and hardware limits

Researched 2026-10-21. The opensprinkler.com forum, shop and support pages sit behind Cloudflare and could not be fetched directly. Facts below come from the firmware source and release notes on GitHub, the raysfiles.com firmware archive, the Freshdesk article (fetched with curl), and the GitHub Pages docs.

## 1. Hardware revisions

From `defines.h` @ tag 217 (https://github.com/OpenSprinkler/OpenSprinkler-Firmware/blob/217/defines.h) and the updater config (https://github.com/OpenSprinkler/OpenSprinkler-Updater/blob/master/desktop-app/config.json):

| HW | MCU / clock | Flash / SRAM / EEPROM | Ethernet | Built-in programmer (USB) | Max firmware |
|---|---|---|---|---|---|
| v1.x | ATmega328/644 class (uncertain) | – | ENC28J60 | – | 1.8.3 |
| v2.0 | ATmega644 @ 8 MHz | 64 KB / 4 KB / 2 KB | ENC28J60 | USBtiny ISP (`-c usbtiny -p m644`) | 2.1.7 |
| v2.1 | ATmega644 @ 12 MHz | 64 KB / 4 KB / 2 KB | ENC28J60 | USBasp bootloader (`-c usbasp -p m644`) | 2.1.5 by bootloader; 2.1.6/2.1.7 need extra steps ("v2.1_ext") |
| v2.2 | ATmega644(P) @ 16 MHz | 64 KB / 4 KB / 2 KB | ENC28J60 | CH340 USB-serial + Arduino bootloader (`-c arduino -p m644p`) | 2.1.7 |
| v2.3 | ATmega1284P @ 16 MHz | 128 KB / 16 KB / 4 KB, plus microSD | ENC28J60 | CH340 USB-serial (`-c arduino -p m1284p -b 115200`) | **2.2.1(4) AVR hotfix 1** (final) |
| v3.0–3.4 | ESP8266 (WiFi, optional ENC28J60/W5500 Ethernet module) | – | – | OTA | 2.2.1(6) (current) |
| v4.0 | ESP32-C6 | – | – | USB-C CDC | 2.2.1(6) |
| OSPi | Raspberry Pi | – | – | – | current |
| OSBo | BeagleBone | – | – | – | Dropped. `OSBO_HW_VERSION_BASE` exists at 217 but is gone from 221(4) `defines.h`. |

- Firmware maps the clock to a hardware ID: 8 MHz gives 20, 12 MHz gives 21, 16 MHz/644 gives 22, and 1284P gives 23.
- Station limits on 2.1.7: 6 expansion boards (56 zones) on the 1284P and 5 boards (48 zones) on the 644.
- The 2.1.7 release notes say program slots are 8 on OS 2.0–2.2 and 17 on OS 2.3.

**Telling the revisions apart physically:**
- **Boot screen:** the LCD shows the hardware version while booting.
- **Web UI:** About shows the hardware version (https://opensprinkler.github.io/OpenSprinkler-Firmware/troubleshooting/).
- **API:** `GET /jo?pw=<md5>` returns `hwv` (20/21/22/23) and `fwv`.
- **Power terminal:** from v2.1 the 24VAC terminal is orange, with different pin spacing (https://rayshobby.net/wordpress/opensprinkler/opensprinkler-usage-instructions/).
- **v2.3 power variants:** a v2.3 with a black barrel jack is the DC variant (forum, via search: https://opensprinkler.com/forums/topic/upgrading-from-2-3-to-3-0/).
- **USB:** v2.2 and v2.3 use a USB-B cable to a CH340 chip that shows up as a serial port. v2.0 and v2.1 enumerate as USBtiny/USBasp instead.
- **microSD slot:** this suggests v2.3, but that is uncertain because I did not verify which earlier boards also had one.
- Board silkscreen likely shows the version, but I could not verify this.

## 2. Latest firmware per board

Sources: release list at https://github.com/OpenSprinkler/OpenSprinkler-Firmware/releases and the firmware archive at http://raysfiles.com/os_compiled_firmware/.

- **v2.0, v2.1 and v2.2 (ATmega644): stuck at 2.1.7** (2016). The support article says: *"from firmware 2.1.9, only OS 2.3 (and above) will be supported. Newer firmwares can no longer run on OS 2.0, 2.1 or 2.2 due to code size… Legacy OS can be upgraded up to firmware 2.1.7."* (https://openthings.freshdesk.com/support/solutions/articles/5000832311). 2.1.8 was a 3.0/OSPi-only release.
- **v2.3 (ATmega1284P): final build is 2.2.1(4) AVR hotfix 1** (`os_221_rev4_avr1.hex`, tag `221(4)-avr1`). It still reports 2.2.1(4). Release 221(5) says: *"It no longer supports OpenSprinkler v2.3 … users should remain on Firmware 2.2.1(4)."*
- **Build target:** `[env:os23_atmega1284p]` in `platformio.ini`, using UIPEthernet, PubSubClient (MQTT) and SdFat. From 2.1.9 on, v2.3 needs a working microSD card; a missing card gives error 0x2D at boot.
- **Features compiled out on AVR:** `defines.h` @ 221(4) defines `OS_AVR` for the 1284P. Only non-AVR builds get `USE_OTF` (OpenThings Cloud), `SUPPORT_EMAIL` and `SUPPORT_HTTPS`.
- **So v2.3 on 2.2.1(4) lacks:** OTC remote access, email notifications, HTTPS stations and remote OTC stations, HTTPS weather queries, and OTA updates.
- **v2.3 on 2.2.1(4) keeps:**
  - MQTT publish and subscribe
  - IFTTT
  - the weather service, with provider choice and ETo
  - sequential groups, pause, program date ranges, monthly adjustment
  - current sensing and fault detection (2.2.1(3))
  - the `qo`/`pre` queue options on `/cm` and `/mp` (2.2.1(4))
- **2.1.7 (644 boards):** adds IFTTT, GPIO stations and HTTP stations on OS 2.3 only. The 644 boards get basic scheduling, weather (HTTP) and the JSON API, but no MQTT. MQTT arrived in a later 2.1.9 build: `mqtt.cpp` is absent at tag `219` and present at `219(9)`.

## 3. Flashing

- **v2.3:** USB-B cable plus the CH340 driver (macOS needs it). Then run:
  `avrdude -c arduino -p m1284p -P /dev/cu.wchusbserialXXXX -b 115200 -D -U flash:w:os_221_rev4_avr1.hex:i` (from `flash.sh` in the archive).
- **v2.2:** `avrdude -c arduino -p m644p -P <port> -U flash:w:firmware2.1.7.hex`
- **v2.1:** enter the bootloader by holding **B2** while plugging in USB (the LCD stays off). Then run `avrdude -c usbasp -p m644 …firmware2.1.5.hex`. 2.1.6 and 2.1.7 need additional steps from a separate article.
- **v2.0:** `avrdude -c usbtiny -p m644 …firmware2.1.7.hex`
- **GUI option:** the OpenSprinkler Updater app (last release 1.0.4, 2016) supports v2.0–v2.3 (https://github.com/OpenSprinkler/OpenSprinkler-Updater). It is dated, and its GitHub firmware source now points to raysfiles.com.
- **Factory reset:** crossing a major version (e.g. 2.1.x → 2.2.x) resets all settings to factory defaults, and the password reverts to `opendoor`. Export the configuration first.
- **Bricking risk:** low. The bootloader or programmer lives in a protected or separate area, so a failed flash can normally be retried. Recovery by ISP with a USBasp/USBtiny programmer on the 6-pin header is possible, but I did not verify that against a specific doc.
- **Reports of instability:** one forum anecdote reports reboots on v2.3 after moving to 2.1.9 and downgrading. Treat it as anecdotal.

## 4. HTTP API

- Same URL scheme on all versions, with the `pw` query parameter on every call:
  - read: `/jc` (controller variables), `/jo` (options), `/js` (station status), `/jn` (station names), `/jp` (programs), `/ja` (everything), `/jl` (logs)
  - write: `/cv`, `/co`, `/cs`
  - run: `/cm` (manual station: `sid`, `en`, `t`), `/mp` (start a program, `pid`), `/cr` (run-once)
  - edit programs and password: `/cp`, `/dp`, `/up`, `/sp`
- 2.1.7 already has all of these (`_url_keys` in `server.cpp` @ 217). `/pq` and `/db` were added later.
- **Password format:** firmware **2.1.7 and later** takes `pw` as a **lowercase MD5 hex** of the password. 2.1.6 and earlier default to the plaintext `opendoor`, so `pw` is plaintext there (verified via `DEFAULT_PASSWORD` at each tag).
- **Docs:** the current API reference is https://opensprinkler.github.io/OpenSprinkler-Firmware/api/, with 2.2.1(4) at `/2.2.1/221_4_api/`. Older PDFs are at http://raysfiles.com/os_compiled_firmware/docs/archived/ (fw 2.1.0–2.1.4). I found no 2.1.7-specific API PDF in the archive; for 2.1.7 behaviour, use the `server.cpp` comments at tag 217.
- Error codes come back as `{"result":N}`, where 1 = success and 2 = unauthorized.

## 5. OTC and upgrade options

- **OTC:** not available on any v2.x board. The docs say *"OTC is supported on OpenSprinkler v3, v4, OpenSprinkler Pi, and Linux"* (https://opensprinkler.github.io/OpenSprinkler-Firmware/guides/remote-access-otc/), and `USE_OTF` is excluded on AVR.
- **Remote access on v2.x:** use port forwarding, a VPN, or a local bridge such as Home Assistant.
- **No board-swap upgrade kit is listed.** The current lineup is v3.4 (AC, DC, Latch) and the new v4.0 AC (ESP32-C6, pre-orders since Aug 2026).
- **Price:** the store range is about **$135–$203** (search snippet of https://opensprinkler.com/product/opensprinkler/; exact v4 price unverified).
- **Discounts:** forum staff say legacy owners can contact support for case-by-case upgrade discounts, so pricing is uncertain.
- **Zone expanders:** v2.x expanders (shift-register, different connector) do **not** work with v3/v4. Expect about $50 per new expander (older forum figure, uncertain).
- **Power supply:** the existing 24VAC transformer can be reused with the v3.4 terminal-to-barrel adapter.

## 6. Limits that matter for voice control

- **Single-threaded server:** the AVR server handles **one TCP client at a time**. Each loop it accepts one `EthernetClient`, reads with a 5 s timeout, responds and closes (`main.cpp` @ 221(4)). Concurrent requests queue or fail.
- **Slow responses:** the ENC28J60 runs over SPI on a 16 MHz MCU, and `/ja` is a large JSON. Poll lightweight endpoints (`/js`, `/jc`) every 5–10 s or more, never in parallel, and serialize commands. 2.1.7 on the 644 has only 4 KB RAM and a 950-byte Ethernet buffer.
- **Long-uptime instability:** the docs recommend a daily `:>reboot` program for legacy Ethernet hardware that drops off the network. That feature needs 2.1.9 or later, so only v2.3 can use it.
- **Security:**
  - Plain HTTP only, with no TLS on AVR.
  - The password travels as an unsalted MD5 in the URL query string, which is equivalent to a password replayable by anyone on the LAN.
  - An "ignore password" option (`ipas`) exists.
  - Never expose the board directly to the internet. Put a local bridge (e.g. Home Assistant or a small proxy) in front of it, and let the voice assistant talk to that bridge.
- **Integration choice:** MQTT (v2.3 on 2.2.1(4)) is a better integration path than HTTP polling because the controller pushes station events. The 644 boards have no MQTT, so they are limited to HTTP polling.
