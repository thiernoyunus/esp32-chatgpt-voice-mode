# Settings, controls, and reading the log

Everything here is optional; the defaults work. Nothing in this file is
committed — the settings are passed in when you install the background service,
so nobody else inherits your setup.

## Settings

Pass them on the install command:

```sh
VOICEMODE_CODEX_MODEL=gpt-6-luna \
VOICEMODE_CODEX_DISABLE_MCP=slow-server,another \
  ./scripts/install-service.sh
```

| Setting | What it does |
|:--|:--|
| `VOICEMODE_CODEX_MODEL` | Pin a model for calls, for example `gpt-6-luna`. Left unset, Codex uses your configured model. |
| `VOICEMODE_CODEX_DISABLE_MCP` | Comma-separated MCP servers to switch off for calls. Useful for ones slow to start, since each one delays the first call after a restart. |
| `VOICEMODE_CODEX_BIN` | Path to the Codex program, if it is not the one inside ChatGPT.app. |
| `VOICEMODE_CODEX_ROOT` | Absolute folder for new voice chats. If unset, follows Codex's projectless task folder, or `~/Documents/Codex` when Codex has no custom folder. |
| `ESP32_VOICE_PORT` | Port the device dials. Defaults to `8790`; changing it means telling the device a new address, which SETUP.md covers. |

Use a model your Codex actually offers. A retired name is remapped where a
replacement is known — asking for `gpt-5.6-luna` resolves to `gpt-6-luna` — and a
name with no replacement fails the call with `Unknown voice model:` in the log,
listing what is available.

## The device's own controls

Volume, brightness and screen capture live on the device itself — its firmware
offers them and waits to be asked. The Mac listener does the asking, and offers
them on to Codex as tools, so you can say "turn it down" during a call. Which
controls are offered is decided in `src/controls.ts`.

That control endpoint answers to this Mac only. It has no password, because
Codex has no way to present one — the guard is that requests from anywhere else
on the network are refused. Reboot and firmware upgrade are deliberately **not**
offered; nothing said out loud in a call should be able to replace the device's
firmware.

## Reading the log

One call prints something like:

```
Device "desk" connected on the local network.
Voice offer 419…: 919 bytes of SDP, voice "Spruce".
Voice answer 419…: chat 01a0…, bridge in 2558 ms.
Answer audio: m=audio 9 UDP/TLS/RTP/SAVPF 111 (sendrecv, 111 opus/48000/2)
Answer transports: bundle=0 1; audio ice=hiRk…, application ice=hiRk…; shared-transport=true
Call ended: answer in 2558 ms; microphone heard; assistant spoke 7 words; speaker audio must be confirmed by ear
```

That last line is deliberately careful. **Captions are not sound.** A call that
produced captions proves the connection works, and proves nothing about whether
anything came out of the speaker; only a person standing at the device can
confirm that.

The two `Answer…` lines exist for one specific failure: a session that comes up
healthy, transcribes both sides, and stays silent. They record whether the
answer negotiated audio at all, and whether audio and events share one
transport. Compare a silent call against a good one.

For the full picture, including what has already been ruled out,
see [why-a-call-goes-silent.md](why-a-call-goes-silent.md).

## The health report

`bun run doctor` reads one small, read-only report the listener serves on this
Mac. You can read it yourself:

```sh
curl -s http://127.0.0.1:8790/health
```

```json
{"service":"esp32-voice-mode","schemaVersion":1,"companion":{"status":"ready"},
 "device":{"connected":true},"calls":{"active":0},"lastError":null}
```

- `companion.status` is `starting`, `ready`, or `failed`. The report answers
  `503` until Codex is up, and `200` once it is, so a program can check the
  status code alone.
- `device.connected` says whether the device currently holds its control
  connection open. The device opens it at boot, so `false` means it is not
  connected — off, or off the network.
- `calls.active` counts calls in progress.
- `lastError` is either `null` or a short, fixed object with a `code` and a
  `message`, for example
  `{"code":"sign_in_required","message":"Codex isn't signed in on your Mac. Open the Codex app and sign in."}`.
  Raw errors are deliberately not returned, because they can contain private
  paths or the shared secret.

Requests from anywhere but this Mac are refused with `403`, and anything other
than a `GET` with `405`.

`bun run doctor` reads this report and adds its own checks — file permissions,
the device config, and the Codex program. `bun run doctor --json` prints the
combined result as JSON, and `--report <path>` also saves it to a new file
(never overwriting one). The command exits non-zero when something needs
attention, which makes it usable from a script.
