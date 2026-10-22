# Alexa setup

Alexa reaches Rainmaker through the `homebridge-alexa` plugin (by NorthernMan54). It shows the Rainmaker HomeKit accessories to Alexa. Set up Rainmaker first: [install-hub.md](install-hub.md).

## Cost

`homebridge-alexa` uses a cloud relay that needs a paid subscription. It costs roughly a coffee a month and has a 7-day trial. Check the plugin's page for the current price before you subscribe.

## Install

1. In the Homebridge UI, go to Plugins, search for `homebridge-alexa`, and install it.
2. Follow the plugin's own instructions to create its account and start the trial or subscription.
3. Restart Homebridge.
4. In the Alexa app, go to Skills & Games, search for the skill that the `homebridge-alexa` instructions name, and enable it. Sign in with the account from step 2.
5. Say: "Alexa, discover devices". Or use Devices, then Add, in the Alexa app.

## What Alexa sees

- Each zone appears as an on/off device, named after the zone. "Alexa, turn on back yard" starts that zone. "Alexa, turn off back yard" stops it.
- A zone started by Alexa runs for that zone's voice duration. Set it in the plugin settings under **Voice run durations** (default 10 minutes).
- **Sprinkler System** and **Sprinkler Pause** appear as switches. "Alexa, turn off the sprinkler system" disables watering. "Alexa, turn on sprinkler pause" pauses everything.
- **Pause Sprinklers 1 Day** and **Pause Sprinklers 1 Week** also appear as switches. The routines below use them.

## Three routines for friendly phrases

Alexa cannot set a pause length by voice, so use routines that switch on the right device.

Make each routine in the Alexa app:

1. Open More, then Routines, then the plus sign.
2. Tap **When this happens**, choose **Voice**, and type the phrase.
3. Tap **Add action**, choose **Smart Home**, then **All Devices**, and pick the device.
4. Choose the action shown below. Save.

| Phrase | Device | Action |
|---|---|---|
| "pause sprinklers for a day" | Pause Sprinklers 1 Day | Turn on |
| "pause sprinklers for a week" | Pause Sprinklers 1 Week | Turn on |
| "resume sprinklers" | Sprinkler Pause | Turn off |

The two "Pause Sprinklers" switches turn themselves off again after about a second. That is normal. The pause itself is set on the controller.

"Resume sprinklers" clears the pause completely, including one set by the 1 Day and 1 Week switches.

## Good to know

- Alexa takes about 2 to 3 seconds. It goes through Amazon's cloud.
- If a command cannot be carried out (for example the controller is offline), Alexa says the device is not responding. It does not say it worked when it did not.
- Commands from Alexa and from Home tiles skip the rain and recent-run warnings, and send no notification. This is by design. Only the Rainmaker app shows those warnings.
- If a zone is missing after you rename it, say "Alexa, discover devices" again.

To check that everything works, use [voice-test-checklist.md](voice-test-checklist.md).
