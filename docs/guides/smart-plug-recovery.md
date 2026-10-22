# Smart plug recovery

## Why

The older OpenSprinkler v2.2 board can drop off the network and cannot restart itself. Only a power cycle brings it back. A smart plug on the controller's power adapter lets Rainmaker do that for you.

Use a plug on the controller's low-voltage power adapter. Keep the plug switched on normally.

There are two ways to set it up. Pick one.

## Option A: Direct (Shelly or Tasmota)

The hub calls the plug on your home network. It needs no Home app automation.

Supported plugs:

- **Shelly Gen1.** The hub calls `http://<host>/relay/0?turn=off&timer=30`, which turns the plug off and makes the plug itself turn back on after 30 seconds. After 30 seconds the hub also calls `http://<host>/relay/0?turn=on`.
- **Tasmota.** The hub calls `http://<host>/cm?cmnd=Backlog%20Power%20Off%3B%20Delay%20300%3B%20Power%20On` (Power Off, wait 30 seconds, Power On, all run by the plug). After 30 seconds the hub also calls `http://<host>/cm?cmnd=Power%20On`.

Because the plug runs its own timer, it turns the controller back on even if the hub stops or loses the network in the middle of a power cycle.

Steps:

1. Set up the plug on your network and give it a fixed address in your router.
2. Make sure the plug does not need a password for local calls. Rainmaker does not send one.
3. In the Rainmaker plugin settings, set **Plug type** to Shelly or Tasmota, and **Plug host name or IP address** to the plug's host name or IPv4 address. Do not add `http://`, a port or a path.

   In a standalone `hub.config.json`:

   ```json
   "plug": { "type": "shelly", "host": "192.0.2.30" }
   ```

4. Save and restart.
5. Test it. Open `http://<host>/relay/0?turn=off` (Shelly) in a browser, then `...turn=on`. The controller should lose and regain power.

If the host is not valid, the hub says `config: plug.host must be a bare hostname or IP address`.

### Limits

To avoid power cycling in a loop, the hub stops after a few tries:

- At most one power cycle every 10 minutes.
- At most three per hour.
- After the third, the hub sends a `recovery-exhausted` notification: "The controller is still offline after power-cycling it; please check it."
- After that it does not try again until the controller comes back online.

## Option B: HomeKit automation

Use this with any HomeKit plug, including one bridged from another hub. The plug is controlled by the Home app, not by Rainmaker.

1. Add the plug to the Home app and name it, for example "Sprinkler Controller Power".
2. In the Rainmaker plugin settings, set **Plug type** to HomeKit automation. Save and restart. (You can also leave it at None; this setting does not change what the hub does.)
3. In the Home app, open Automation, then the plus sign, then **A Sensor Detects Something**.
4. Choose **Sprinkler Controller Online**, then **Opens** (the sensor opens when the controller goes offline). Next.
5. Under Accessories, pick **Sprinkler Controller Power** and set it to **Off**.
6. Add the wait and the turn-on step. Tap **Convert to Shortcut**, then add **Wait** with 30 seconds, then add **Control Home** to turn **Sprinkler Controller Power** on. Save.

   Without Convert to Shortcut, use two automations instead: one turns the plug off when the sensor opens, and a second turns it back on after a delay you set up yourself. The Shortcut way is simpler.
7. Test it by turning the controller's network cable off for a minute. The sensor should open, the plug should switch off for 30 seconds, then on.

### Limits

For this option, the rate limits above (one cycle per 10 minutes, three per hour, the `recovery-exhausted` notification) do not apply. The hub does not power cycle anything itself. The automation runs each time the sensor opens. If the controller stays offline, the sensor stays open, so the automation does not fire again until it closes and opens again.

The hub still sends the normal offline and back-online notifications (see [Notifications in install-hub.md](install-hub.md#notifications)).

## Notifications for both options

The hub sends a notification when the controller goes offline and when it comes back, if **Notify when the controller goes offline** is on and a channel is set.
