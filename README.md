# Codex Voice

A small ESP32 watch that you talk to. It connects to a computer on your wifi,
which uses Codex to handle your requests. The setup in this repository has been
tested on a Mac. Windows setup has not been tested yet.

This repository contains both parts: the computer companion at the top level
and the watch software in [firmware/](firmware/). They are released together.

```
  device  ──── wifi ────►  this Mac  ──── Codex ────►  OpenAI realtime voice
     ▲                                                         │
     └───────────────── spoken audio, directly ────────────────┘
```

Only the **call setup** passes through this Mac: the device's WebRTC offer comes
in, a ChatGPT Voice session is opened on the Codex app-server running here, and
the answer goes back. The **spoken audio never touches this Mac at all** — the
answer points the device straight at the realtime service. The Mac does not carry
audio packets, but its call setup and audio negotiation can affect whether sound
arrives. Check both sides when a call stays silent.

## Start here

```sh
git clone https://github.com/thiernoyunus/esp32-chatgpt-voice-mode.git
cd esp32-chatgpt-voice-mode
bun install
bun run setup --board esp32-s3-touch-amoled-2.06
./scripts/install-service.sh
bun run doctor     # run after the service starts; reads only
```

**[SETUP.md](SETUP.md)** is the full path — device and Mac — with a check after
every step. Follow it the first time; it is the only place those steps are
written down. Continue with its device build, USB installation, and wifi steps;
the commands above only prepare the Mac and the device's local settings file.
Doctor reports a missing listener if run before the service starts. A ready
listener does not prove that the device is connected or its speaker works.

- `bun run setup --board <watch-name>` writes the two files that must hold the same secret — this
  checkout's `.dev.vars` and the firmware's `sdkconfig.defaults.local`. It shows
  the plan and asks before writing, never overwrites a file that already exists,
  and finds the `firmware/` folder in this checkout.
- `bun run doctor` checks an install and changes nothing: the shared secret and
  its file permissions, whether the device config holds the same one, where Codex
  is, and whether a listener is answering on this Mac. It exits non-zero when
  something needs attention.
- `bun run doctor --json` prints the same report for a script to read. Either
  command takes `--help`.

Running it day to day:

```sh
bun run start                          # foreground
launchctl list | grep voice-mode       # is the background service up
tail -f /tmp/esp32-voice-mode.log      # calls: offers, answers, evidence
```

Stop the background service with
`launchctl bootout gui/$(id -u)/local.esp32-voice-mode`.

## Requirements

- One **Mac**, on the same wifi as the device, signed in to the **ChatGPT app**
  — the Codex program this uses ships inside it.
- [Bun](https://bun.sh).
- **Waveshare ESP32-S3-Touch-AMOLED-2.06** (410×502 AMOLED). Source for the older
  1.85C watch is present, but its current build and UI need a new physical test
  before we call it supported by this release.
- ESP-IDF **v6.0.2**, only for building the firmware.

## Your privacy

No server run by this project sits between your device and your Mac, and the
audio does not pass through your Mac at all.

| What moves | Where it goes |
|:--|:--|
| Call setup (the offer and the answer) | Device ⇄ this Mac, then Codex on this Mac |
| Captions, tool calls, status | Device ⇄ this Mac, then Codex on this Mac |
| **Spoken audio, both directions** | Device ⇄ **OpenAI's realtime voice service, directly** |
| Saved voice chats and work folders | Codex on your Mac; new work folders follow its projectless task folder (usually `~/Documents/Codex`) |

The audio reaches OpenAI as part of the call, under your own ChatGPT/Codex
account and its terms; nothing here stores it or forwards it anywhere else.

## What it cannot do yet

- **Captions are not sound.** A call can connect, transcribe both sides, and
  stay silent. Only a person standing at the device can confirm the speaker made
  a sound.
- **Talking over the assistant does not work yet.** Interrupting a reply is
  still an open problem.
- Device controls take an optional `device_id`; list connected devices before
  targeting one. The port is trusted
  on a shared secret alone — treat it as something on your home network, not the internet.
- **Codex compatibility is experimental.** The companion uses
  `features.realtime_conversation`. Available models depend on the installed
  Codex and signed-in account; choose one from its current list.
- **Account eligibility is not established by this project.** Doctor can check
  the program and listener, but cannot certify plan eligibility or voice access.
  Use the reported sign-in, model, or usage-limit error to guide troubleshooting.
- **macOS can block the chat folder.** New chats follow Codex's projectless
  task folder (`~/Documents/Codex` unless customized); see SETUP.md for
  permission help or a watch-only alternate folder.

## Go deeper

- [SETUP.md](SETUP.md) — the full first-time path, both halves, with checks.
- [documentation/settings.md](documentation/settings.md) — model, storage, port,
  and the device's own volume/brightness/screen controls.
- [documentation/why-a-call-goes-silent.md](documentation/why-a-call-goes-silent.md)
  — the known silent-call failure, and how to read a run.
- [CONTRIBUTING.md](CONTRIBUTING.md) — the two-halves rule and the checks to run.
- [documentation/releasing.md](documentation/releasing.md) — how one release
  contains both parts.
- `.claude/skills/desk-voice/SKILL.md` — the wire contract, and a symptom/fix
  table for debugging.

## History

This began from the Apollo starter — generated from its template rather than
forked from it — which routed every call through a Cloudflare Worker. The
Worker is gone: about 29,000 lines of it, replaced by the few hundred here.
See [LICENSE](LICENSE) for what that leaves behind.

The device firmware descends from
[78/xiaozhi-esp32](https://github.com/78/xiaozhi-esp32), which is excellent and
worth using directly if you want a general-purpose multi-board build.
