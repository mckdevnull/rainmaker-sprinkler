# Phase 0: Controller prep checklist

Do these by hand before any Rainmaker software is installed. Each one protects your setup or makes the later phases easier.

- [ ] Export the controller configuration from the stock web UI (Settings → Export). Save the file outside the repo.
  Why: it is your rollback point if anything goes wrong later.

- [ ] Record the controller's LAN IP and current password in your password manager, not in the repo.
  Why: you will need both again, and the repo is public-facing, so secrets must never live in it.

- [ ] Set the Windows 11 PC to never sleep (Settings → System → Power).
  Why: a sleeping PC stops the Rainmaker hub, and voice control silently stops with it.

- [ ] Plug the controller's transformer into the smart plug. Add the plug to the Home app and name it "Sprinkler Controller Power".
  Why: a named plug gives you a clean, reliable way to power-cycle the controller from Siri.

- [ ] In Vera, remove the OpenSprinkler devices from the HomeKit bridge (or hide them).
  Why: otherwise each zone shows up twice in the Home app, once from Vera and once from Rainmaker.

- [ ] Optional, later: flash firmware 2.1.7 per spec §7. Not needed for Rainmaker.
  Why: it is a separate upgrade, so skip it for now and keep this phase small.
