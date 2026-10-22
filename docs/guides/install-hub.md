# Install the Rainmaker hub

The hub is the only thing that talks to your controller. Siri, Alexa and the Rainmaker app all go through it. You can run it inside Homebridge (recommended) or on its own.

Rainmaker works with OpenSprinkler controllers on firmware 2.1.6 to 2.2.1.

## Before you start

- A computer that is always on and never sleeps. This guide assumes a Windows 11 PC. Turn off sleep and hibernate in Windows power settings.
- Node.js 20 or newer.
- For the Homebridge route: Homebridge 1.8 or newer (2.x also works), with the Homebridge UI.
- The controller's address on your network (for example `http://192.0.2.10`) and its device password.
- Give the controller a fixed address in your router (a DHCP reservation).

## Option A: Homebridge plugin

The plugin is not on npm yet. Install it from this repository.

1. Get the code and build it.

   ```
   git clone <this repository's URL> rainmaker
   cd rainmaker
   npm install
   npm run build
   ```

2. Link the plugin into Homebridge.

   ```
   cd packages/homebridge-rainmaker
   npm link
   ```

   Then, in the folder where Homebridge is installed, run:

   ```
   npm link homebridge-rainmaker
   ```

   If you run Homebridge as a service with `hb-service`, you can instead run `hb-service add <full path to packages/homebridge-rainmaker>` if your version supports it. If neither works, see the Homebridge wiki on installing local plugins.

3. Restart Homebridge.
4. Open the Homebridge UI, go to Plugins, and open the settings of Rainmaker.
5. Fill in at least **Controller address** and **Device password** (see the table below). Save.
6. Turn on a child bridge for the plugin: in the plugin's menu, choose Bridge Settings and enable the child bridge. In `config.json` this is the `_bridge` block on the Rainmaker platform. Rainmaker should always run as a child bridge.
7. Restart Homebridge. The child bridge starts and shows its own pairing QR code.
8. In the Home app, add the accessory with that QR code (or the setup code shown in the Homebridge UI).

You should see a **Sprinklers** tile with one valve per zone, and these switches and sensors:

| Accessory | What it does |
|---|---|
| Sprinkler System | On means the controller is enabled. Off disables watering. |
| Sprinkler Pause | On pauses all watering until you turn it off. |
| Pause Sprinklers 1 Day | Tap to pause for 24 hours. Turns itself off again. |
| Pause Sprinklers 1 Week | Tap to pause for 7 days. Turns itself off again. |
| Sprinkler Controller Online | Contact sensor. Closed means online. Open means the controller is offline. |
| Rainmaker Pairing | Tap to get a pairing code for the Rainmaker app. Turns itself off again. |

## Plugin settings

Every field below is in the plugin's settings screen. Fields you leave out use the default.

| Field | Meaning |
|---|---|
| Name (`name`) | Name of the platform. Default `Rainmaker`. |
| Controller address (`controller.baseUrl`) | `http://` or `https://` address of the controller. Required. |
| Device password (`controller.password`) | The controller's device password. Required. Firmware 2.1.6 and older takes it as plain text; 2.1.7 and newer takes an MD5 hash. Rainmaker handles both. Enter the plain password. |
| Data folder (`dataDir`) | Where the hub keeps settings and paired devices. A relative path is inside the Homebridge storage folder. Default `rainmaker`. |
| App API port (`apiPort`) | Port the Rainmaker app connects to on this computer. Default `8787`. |
| Allowed web origins (`allowedOrigins`) | Browser origins allowed to call the hub API, for example `http://192.0.2.20:8080`. Leave empty if unsure. |
| Location (`location.lat`, `location.lon`) | Latitude and longitude, used for the rain forecast. Leave empty to turn the forecast off. |
| Warn when rain is forecast (`warnings.rainForecast`) | Default on. |
| Rain chance that counts (`warnings.rainThresholdPct`) | 0 to 100. Default 50. |
| Warn when the zone ran recently (`warnings.recentRun`) | Default on. |
| Recent means within (`warnings.recentRunWindowMin`) | Minutes, 1 to 1440. Default 60. |
| Plug type (`plug.type`) | `none`, `shelly`, `tasmota` or `homekit-automation`. See [smart-plug-recovery.md](smart-plug-recovery.md). |
| Plug host (`plug.host`) | Host name or IPv4 address of the plug. Only for `shelly` and `tasmota`. No `http://`, no port, no path. |
| Notify when the controller goes offline (`notifications.offline`) | Default on. |
| APNs key file path, key ID, team ID, bundle ID (`notifications.apnsKeyPath`, `apnsKeyId`, `apnsTeamId`, `apnsBundleId`) | For push notifications to the Rainmaker app. All four must be set together. |
| ntfy topic (`notifications.ntfyTopic`) | Letters, digits, `-` and `_`, up to 64 characters. Sends notifications through ntfy.sh. |
| Pushover application token and user key (`notifications.pushoverToken`, `pushoverUser`) | Both must be set together. |
| Voice run durations (`zoneDefaults`) | A list of zone id and seconds. Sets how long a zone runs when started by Siri, Alexa or the Home app. Default 600 seconds. Zone ids start at 0 for the first zone (S01). Seconds can be 1 to 64800. |

### Notifications

The notification rows in the table above (`notifications.*`) control the owner notifications: the controller went offline, came back online, or is still offline after the smart plug power-cycled it.

Rainmaker uses the first notification channel that is fully set, in this order: APNs, ntfy, Pushover. If none is set, notifications go to the log.

Example `config.json` block for the Homebridge platform:

```json
{
  "platform": "Rainmaker",
  "name": "Rainmaker",
  "controller": { "baseUrl": "http://192.0.2.10", "password": "your-device-password" },
  "zoneDefaults": [{ "zone": 0, "voiceSeconds": 900 }],
  "_bridge": { "name": "Rainmaker" }
}
```

## Pair the Rainmaker app

Pairing gives a device its own access token. The controller password never leaves the hub.

- Open the Homebridge log. The hub writes a line like this when it starts, and again every 5 minutes while no device is paired:

  ```
  Rainmaker pairing code: 123456 (enter it in the Rainmaker app within 5 minutes)
  ```

- To get a new code at any time, turn on **Rainmaker Pairing** in the Home app. The code appears in the Homebridge log and the switch turns itself off.
- Enter the code in the Rainmaker app.

The iOS app is not built yet. The codes are ready for when it is.

## Option B: Run the hub on its own (no Homebridge)

Use this if you do not run Homebridge. You get the hub and the app API, but no Siri or Alexa.

> **Run only one hub per controller.** Do not run the Homebridge plugin and the standalone `rainmaker-hub` at the same time against the same controller. Each hub has its own request queue, so two hubs break the one-request-at-a-time rule the controller needs, and the second one also fails to start with `EADDRINUSE` when both use the same API port.

1. Build the code, as in step 1 above.
2. Copy `examples/hub.config.json` and edit it. Set `controller.baseUrl` and `controller.password` to your controller. The example points at the simulator on `127.0.0.1`.
3. Start the hub.

   ```
   node packages/hub-core/dist/src/bin/rainmaker-hub.js --config path/to/hub.config.json
   ```

   (`npm link` in `packages/hub-core` also gives you the `rainmaker-hub` command.)

4. The hub prints `Rainmaker hub listening on 8787` and a pairing code. In standalone mode a relative `dataDir` is resolved against the folder that holds the config file.
5. To get a new code later, run this on the same computer while the hub is running:

   ```
   rainmaker-hub pair --config path/to/hub.config.json
   ```

   It prints `Pairing code: <code> (valid until <time>)`. The config must have a fixed `apiPort` (not 0).

Standalone `hub.config.json` uses the same fields as the table above, but `zoneDefaults` is an object keyed by zone id, for example `{ "0": { "voiceSeconds": 900 } }`. Unknown fields are rejected.

To keep it running after you log out, use a service manager such as NSSM or Windows Task Scheduler. This guide does not cover that.

## Troubleshooting

- **Settings error in the Homebridge log.** The log says `config: <field> <problem>`, for example `config: controller.baseUrl must start with http:// or https://`. The field name is the name in the table above. Fix it and restart Homebridge. Until then the log says Rainmaker is not running and the accessories report errors.
- **"Sprinklers" shows No Response.** The hub cannot reach the controller, so it reports it offline. Check the controller's power and network cable, then open its address in a browser. "Sprinkler Controller Online" will show open at the same time. See [smart-plug-recovery.md](smart-plug-recovery.md) for automatic power cycling.
- **Wrong controller password.** The hub tells the controller's old and new password formats apart on its own. If it still cannot sign in, re-check the device password on the controller. An update to firmware 2.1.7 or newer can reset it to `opendoor`.
- **Pairing code not in the log.** Turn on **Rainmaker Pairing**, or look for the line `Rainmaker pairing code:` in the Homebridge log.
- **Port already in use.** Change **App API port**.
- **The app cannot connect from outside your home.** See [remote-access-tailscale.md](remote-access-tailscale.md).
- **Windows Firewall asks about Node.js.** Allow it on private networks, so the app can reach the hub.

## Next

- Alexa: [alexa-setup.md](alexa-setup.md)
- Power-cycling the controller: [smart-plug-recovery.md](smart-plug-recovery.md)
- Away from home: [remote-access-tailscale.md](remote-access-tailscale.md)
- Test your voice commands: [voice-test-checklist.md](voice-test-checklist.md)
