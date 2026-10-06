# Watch UI host harness

This runs the watch's user interface on a Mac (or in CI) with no board attached,
and saves a picture of every page. It exists so a layout change can be *looked
at* instead of flashed and squinted at.

It is not a mock-up: it compiles the same `main/display/watch_ui.cc` the
firmware builds, and draws it with LVGL 9.5.0, a fixed baseline compatible with the firmware's
`~9.5.0` range. A device build can select a newer patch release. CMake asks you
to review this baseline if the manifest range changes. The desktop supplies:

- `host/display_driver.c` — a screen that draws into a plain memory buffer
  instead of a panel.
- `host/screenshot.c` — writes that buffer to a PNG. It packs the file by hand,
  so no image library is needed to build.
- `host/lv_conf.h` — the LVGL settings a desktop needs (16-bit colour, the
  software renderer, the machine's own memory allocator).

## Running it

```sh
python3 scripts/tests/test_watch_ui.py
```

That builds (downloading LVGL the first time) and checks the pictures, on **both
panels**: `shots/round` is the 360x360 round watch and `shots/amoled` is the
410x502 AMOLED. They are different layouts of the same `watch_ui.cc`, and the
AMOLED has pages the round watch does not, so a change can pass on one and break
the other. Override where the pictures go with `VOICEMODE_WATCH_UI_SHOTS`, and
where the build goes with `VOICEMODE_WATCH_UI_BUILD`.

To see one panel on its own, run the binary directly with the switch:

```sh
VOICEMODE_TEST_AMOLED=1 /tmp/voicemode-watch-ui-host/build/watch_ui_test
```

To build against an LVGL checkout you already have (useful offline), set
`VOICEMODE_LVGL_DIR` — the test script forwards it to CMake:

```sh
VOICEMODE_LVGL_DIR=~/src/lvgl python3 scripts/tests/test_watch_ui.py
```

Needs `cmake`, a C/C++ compiler, and Pillow (`python3 -m pip install pillow`).
Missing any of those is an error rather than a skip, so CI cannot pass without
actually rendering.

## What is checked

- The binary itself: every page renders, tapping rows and keys does what the
  labels say, and navigating in circles does not leak widgets or screens. A
  failed check there is a non-zero exit from the harness.
- One PNG per page, each exactly 360x360 — the real panel size, so an image that
  is off by a pixel or silently scaled cannot pass.
- `check_round.py`: the corners of each image, outside the round screen, must be
  the page's own background. Content painted there is invisible on the watch, so
  it is caught here instead of on the device.

Running the binary directly also works, and writes to the same default directory:

```sh
cmake -S scripts/tests/watch_ui_host -B /tmp/watch-ui-build
cmake --build /tmp/watch-ui-build -j8
/tmp/watch-ui-build/watch_ui_test
```

## All host tests

From the firmware folder, with a C/C++ compiler, Git, and CMake installed:

```sh
python3 -m venv .venv
.venv/bin/pip install -r scripts/tests/requirements.txt
.venv/bin/python scripts/tests/run_host_tests.py
```

The runner executes each test program and fails if any test fails or takes more
than ten minutes. `--timeout SECONDS` changes that limit. The old multi-board
build tests are excluded because this fork supports one board; CI builds that
board separately.

The message test downloads just `cJSON.c` and `cJSON.h` from cJSON 1.7.19 and
checks their SHA-256 fingerprints before compiling them. It does not need
`managed_components` or an ESP-IDF build. Downloads require internet access.
To also check messages produced by the Mac companion, pass
`--fixtures /path/to/messages.jsonl` to the runner or to `test_voice_messages.py`.
