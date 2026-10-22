# Rainmaker

Fast, dependable voice and app control for **OpenSprinkler** irrigation controllers, including old Ethernet-only boards.

> Rainmaker is an independent, free, open-source project. It works with OpenSprinkler controllers but is not affiliated with or endorsed by OpenSprinkler or OpenThings.

## What it does and will do

- **Siri and Alexa:** start and stop zones, pause watering, and turn the system off and on by voice.
- **iPhone and iPad app:** photo cards for each zone, two-tap watering, schedules, pause until a date, and rain and recent-run warnings.
- **A refreshed web page on the controller itself:** installed without flashing firmware, and reversible.
- **A small local hub** that keeps the controller responsive, notices when it drops offline, and recovers it.

## Status

Built so far:

- **The hub** (`@rainmaker/hub-core`, a private workspace package). It talks to the controller, keeps its state, recovers it through a smart plug and serves the app API. It has two command-line tools: `rainmaker-hub` and `rainmaker-latency`.
- **The Homebridge plugin** (`homebridge-rainmaker`, a self-contained bundle). It gives Siri, the Home app and Alexa the zones, a system switch, pause switches and an online sensor. It is not on npm yet; install it from this repository.
- **A controller simulator** (`@rainmaker/controller-sim`) for tests and trials.

Still planned: the iPhone and iPad app, and the web page on the controller.

Set it up:

- [Install the hub](docs/guides/install-hub.md)
- [Alexa setup](docs/guides/alexa-setup.md)
- [Smart plug recovery](docs/guides/smart-plug-recovery.md)
- [Remote access with Tailscale](docs/guides/remote-access-tailscale.md)

Other guides: [controller prep](docs/guides/phase-0-controller-prep.md), [voice test checklist](docs/guides/voice-test-checklist.md), [latency results](docs/guides/latency-results.md).

More:

- Design: [docs/superpowers/specs/2026-10-21-rainmaker-design.md](docs/superpowers/specs/2026-10-21-rainmaker-design.md)
- Build plan, hub and voice: [docs/superpowers/plans/2026-10-21-rainmaker-hub-and-voice.md](docs/superpowers/plans/2026-10-21-rainmaker-hub-and-voice.md)
- Research: [docs/research/](docs/research/)
- Mockups: [docs/mockups/](docs/mockups/) (open the HTML files in a browser)
