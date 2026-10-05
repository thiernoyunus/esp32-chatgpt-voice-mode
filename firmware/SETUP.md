# Setting up

The full path — device and Mac — lives in exactly one place:
[SETUP.md](../SETUP.md)
at the repository root. Follow that; it has a check after every step, and because
it is the only copy, it cannot drift out of sync with another page.

Three things about the device half are worth knowing before you start.

## Choose your watch

- Waveshare **ESP32-S3-Touch-AMOLED-2.06**: 410×502 touch AMOLED.

The older 1.85C source is retained for a later physical check.

Build the matching board with `python3 scripts/build.py waveshare/<board-name>`;
the exact names and checks are in [Build](documentation/operations/build.md).
The two watches share the voice software but need different hardware settings.

## The traps that cost the most time

- **Check the build output and board name before flashing.** A file left by a
  previous build can still be in `build/`; confirm the latest run says
  `Project build complete` and the generated settings name your watch. See
  [documentation/operations/build.md](documentation/operations/build.md).
- **Never toggle DTR/RTS on the serial port.** It lands the chip in ROM download
  mode, silent until you physically unplug and replug. Opening the port at all
  resets the chip; that is normal. See
  [documentation/operations/flash.md](documentation/operations/flash.md).
- **The address, secret and device id live in the gitignored
  `sdkconfig.defaults.local`**, and the build script reads it before the chosen
  board's settings. Delete the file, or build without it, and
  the device comes up with an empty address: it shows "connecting" for a moment
  and gives up, with nothing in the log to explain why. See
  [documentation/operations/provisioning.md](documentation/operations/provisioning.md).
- **`bun run setup` at the repository root writes this file for you.** It never
  overwrites one that already exists.

## Where to go next

- [documentation/index.md](documentation/index.md) — the handbook: build, flash,
  provisioning, protocol, audio, the watch UI, and the barge-in record.
- [CONTRIBUTING.md](CONTRIBUTING.md) — the rules for changing the firmware, the
  checks to run, and the self-contained UI simulator.
- [README.md](README.md) — what this is, and what it cannot do yet.
