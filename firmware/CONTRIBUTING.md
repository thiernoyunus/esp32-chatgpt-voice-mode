# Contributing

## The two halves move together

This folder is the device half. The computer companion is at the
[repository root](../README.md). They share one wire contract — the messages
that cross the wifi between them — so update both sides together when needed.

## Rules that are different here

This is a hard fork cut down to one purpose, so a few habits differ from the
upstream project:

- **The 2.06 watch is the current release target.** The older 1.85C source
  remains for a later physical recheck. Add other boards only with hardware.
- **Core code depends on the `Board` interfaces**, never the concrete board
  class or its `config.h`.
- **Runtime state changes go through `Application::SetDeviceState()`** and the
  state machine.
- **Callbacks may run outside the main task.** Schedule changes onto the main
  loop with `Application::Schedule()` or event bits.
- **Do not block the main loop or the audio tasks.** Avoid unbounded queues and
  repeated large allocations in audio paths.
- **Stored settings are an API.** The NVS keys the device keeps are persistent,
  so renaming one needs a migration.
- **Do not hand-edit generated or vendor output:** `build/`,
  `managed_components/`, `sdkconfig*`, `main/assets/lang_config.h`, or the
  generated mmap headers.
- **Format only the C/C++ files you touched** with the repository
  `.clang-format`; avoid unrelated reformatting.
- Read the closest existing implementation before adding a new one, and put
  board-specific behaviour in the board folder, not in core modules.

## Build and check

```sh
. ~/esp/esp-idf/export.sh
python3 scripts/build.py waveshare/esp32-s3-touch-amoled-2.06
```

The build script prints `[ERROR]` but still exits 0 when the build failed, so
read the log and confirm `build/xiaozhi.bin` exists. See
[documentation/operations/build.md](documentation/operations/build.md).

A build is not a hardware test. Before claiming anything about audio, touch,
or the display, say what was checked on a physical device and what was not.

## The simulator

`scripts/tests/watch_ui_host/` renders the watch UI on a Mac or in CI with no
board attached: it compiles the same `main/display/watch_ui.cc` the firmware
builds, against the same LVGL release the board pins, and writes one PNG per
page so a layout change can be looked at instead of flashed and squinted at.
Only the screen and its capture are replaced, by files under `host/`.

It is self-contained. The first run downloads that LVGL release itself — pass
`VOICEMODE_LVGL_DIR` to use a local checkout offline — and the round-screen
checker lives in the repository. Run it with:

```sh
python3 scripts/tests/test_watch_ui.py
```

Missing tools are an error rather than a skip, so CI cannot pass without
rendering. See `scripts/tests/watch_ui_host/README.md`. This simulates the
firmware's own UI; it is not the Mac half and does not run a call.

One older harness, `scripts/tests/caption_host`, still needs an external LVGL
simulator checkout named by `VOICEMODE_LVGL_SIM_DIR` and fails to configure
without one. It is not part of the build, and nothing here claims it passes on a
machine that lacks that checkout.

## Keep secrets out

- `sdkconfig.defaults.local` holds your Mac's address and the shared secret and
  is gitignored. Never commit it.
- Do not put a device id, MAC address, wifi name, or raw serial log into a
  commit, an issue, or a screenshot.
- A provisioning dump can carry the shared secret and stored settings; review it
  before sharing even a fragment.

## Match releases

A release is one tag containing both parts. The checks are in
[documentation/releasing.md](../documentation/releasing.md).

## Writing

Docs here are for people who may not be programmers. Prefer plain words to
jargon, describe what you did rather than the mechanism, and say plainly what has
not been verified. This matters most about audio: captions and logs are not proof
that the speaker made a sound.
