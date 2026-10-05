<a id="readme-top"></a>

[![C++][cpp-shield]][cpp-url]
[![ESP-IDF][espidf-shield]][espidf-url]
[![Espressif][espressif-shield]][espressif-url]
[![FreeRTOS][freertos-shield]][freertos-url]
[![Opus][opus-shield]][opus-url]

# Codex Voice watch software

Firmware for a small round-screen ESP32-S3 that sits on a desk and talks to
ChatGPT Voice. It connects to **one Mac on your own wifi**, and that Mac does
the thinking. This project runs no server of its own, and the device stores none
of the conversation: the spoken audio goes straight to OpenAI's realtime voice
service, and the Mac keeps the chat text.

This folder is the device half. The computer companion is at the
[repository root](../README.md); the two change together.

```
  device  ──── your wifi ────►  a Mac running Codex  ────►  OpenAI realtime
     ▲                                                             │
     └──────────────── spoken audio, directly ─────────────────────┘
```

Only the **call setup** goes through the Mac. The spoken audio travels straight
between the device and the realtime service. The Mac does not carry audio
packets, but its call setup and audio negotiation can affect whether audio arrives.

## Use it

**Start here:**
[SETUP.md](../SETUP.md)
at the repository root walks through both halves end to end, with a check after
each step. The rest of this page assumes you have done that. If you landed here
first, [SETUP.md](SETUP.md) in this repository points at the same path and lists
the device-side traps that cost the most time.

### Requirements

- **Waveshare ESP32-S3-Touch-AMOLED-2.06** (410×502 AMOLED) is the current
  verified target. The older 1.85C source is retained and needs a fresh physical
  check before it is listed as supported by this release.
- **ESP-IDF v6.0.2** — see
  [documentation/operations/toolchain.md](documentation/operations/toolchain.md).
- **One Mac** on the same wifi, running the companion listener.

### Build and flash

See [documentation/operations/build.md](documentation/operations/build.md).
Briefly, with ESP-IDF v6 installed:

```bash
python3 scripts/build.py waveshare/esp32-s3-touch-amoled-2.06
idf.py -p /dev/cu.usbmodemXXXX flash
```

The address, secret and device id live in the gitignored
`sdkconfig.defaults.local`, so never commit it. See
[documentation/operations/provisioning.md](documentation/operations/provisioning.md)
for what goes in it, and for the alternative of writing those three values into
the device's stored settings instead of rebuilding.

### Watching what it does

With the device connected over USB, in two terminals:

```bash
python3 scripts/serial_log.py
python3 scripts/monitor.py
```

Then open <http://localhost:8787/> for the conversation, the audio frames that
actually reached playback, microphone drops, and screen snapshots. Logs land in
`~/.voicemode/voicemode_live.log`. Three-byte WebRTC keepalives are excluded
from the audio count, so the number means what it says.

## Customize it

- Board pins, panel and touch task: `main/boards/waveshare/` has a separate
  folder for each supported watch.
- Round watch UI and the call orb: `main/display/` (`watch_ui.*`,
  `lcd_display.*`, `bloub/`).
- The tools the Mac can call on the device: `main/mcp_server.cc`.
- Wake word and audio: `main/audio/`.
- `scripts/build.py` is the canonical build entry point; `idf.py build` works
  too.

Format changed C/C++ files with the repository `.clang-format`, and read the
closest existing implementation before adding a new one. [CONTRIBUTING.md](CONTRIBUTING.md)
has the rules, the checks, and how to preview UI changes in the self-contained
simulator.

## Your privacy

- The device talks to one Mac on your wifi; a shared secret is the only thing
  between it and the rest of your network.
- There is no server run by this project's author.
- The **spoken audio goes from the device straight to OpenAI's realtime voice
  service**, under the account signed in on your Mac. It does not pass through
  the Mac, and the device stores none of it.
- The Mac keeps the chat text. The device keeps only its own settings and the
  wifi name and password.

Detail: [documentation/introduction/privacy.md](documentation/introduction/privacy.md).

## What it cannot do yet

- **Talking over the assistant (barge-in) does not work.** What has been tried,
  and why it failed, is in
  [documentation/reference/barge-in.md](documentation/reference/barge-in.md).
- **Without the Mac, the device only wakes, listens, and times out.** It is a
  thin client on purpose.
- **The older 1.85C build needs a physical recheck.** The current release
  targets the 2.06 AMOLED watch.
- **Captions are not sound.** A call can connect, transcribe both sides, and
  produce no audio; only a person at the device can confirm the speaker made a
  sound.
- **Only es-ES and en-US are kept.** Every other language was removed along with
  the extra boards.

## Contribute

- The firmware and the Mac listener are halves of one wire contract, so a change
  to it needs a matching change there.
- Checks, formatting rules, and the self-contained simulator:
  [CONTRIBUTING.md](CONTRIBUTING.md).
- Releases use one tag for both parts:
  [documentation/releasing.md](../documentation/releasing.md).

## Where this came from

A hard fork of [78/xiaozhi-esp32](https://github.com/78/xiaozhi-esp32), which
wrote the hardware foundation this depends on: the audio service, the board
abstraction, the LVGL display path, the ESP-IDF scaffolding. It is MIT
licensed, and [LICENSE](LICENSE) keeps their copyright.

[documentation/reference/upstream.md](documentation/reference/upstream.md) sets
out exactly what was kept and what was removed.

## Licence

MIT. See [LICENSE](LICENSE).

<!-- MARKDOWN LINKS & IMAGES -->
[cpp-shield]: https://img.shields.io/badge/C++-00599C?style=for-the-badge&logo=cplusplus&logoColor=white
[cpp-url]: https://isocpp.org/
[espidf-shield]: https://img.shields.io/badge/ESP--IDF%20v6-E7352C?style=for-the-badge&logo=espressif&logoColor=white
[espidf-url]: https://docs.espressif.com/projects/esp-idf/en/latest/
[espressif-shield]: https://img.shields.io/badge/ESP32--S3-000000?style=for-the-badge&logo=espressif&logoColor=E7352C
[espressif-url]: https://www.espressif.com/en/products/socs/esp32-s3
[freertos-shield]: https://img.shields.io/badge/FreeRTOS-4CAE4F?style=for-the-badge&logo=freertos&logoColor=white
[freertos-url]: https://www.freertos.org/
[opus-shield]: https://img.shields.io/badge/Opus-8A2BE2?style=for-the-badge&logo=xiph.org&logoColor=white
[opus-url]: https://opus-codec.org/
