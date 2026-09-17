---
name: desk-voice
description: Operating and debugging the ESP32 desk voice device and the Mac it talks to — the wire contract between them, what to check when a call fails or comes up silent, how to read the device's own serial log, and how its controls reach Codex. Load when a call will not start, comes up with captions and no sound, when the device cannot be found, when changing what passes between the two halves, or when adding a device control.
---

# The desk voice device

Two halves that must be changed together: the firmware (its own checkout) and
the Mac listener (this one). The wire contract below is the seam.

## The shape of it

```
device  ──wifi──►  this Mac  ──►  Codex app-server  ──►  OpenAI realtime
   ▲                                                            │
   └──────────── spoken audio, never via this Mac ──────────────┘
```

**The audio never passes through the Mac.** The answer points the device
straight at the realtime service. This process sees signalling and captions and
not one audio packet. Before blaming the Mac for silence, remember it cannot
drop, delay or repair a single frame of voice.

## Connection

```
ws://<mac-lan-address>:8790/agents/voicemode/<deviceId>?token=<DEVICE_SHARED_SECRET>
```

The path is named for the project this was forked from. It is what the firmware
dials, so changing it means reflashing. The token is checked before the upgrade;
a wrong one gets `401` and a line in the log.

## The whole wire contract

Nine message types. Not eight, not thirty — the dialect was much larger when a
Cloudflare Worker was on the other end, and the rest is gone.

**Device → Mac** (`firmware/main/protocols/codex_voice_protocol.cc`):

| Type | Meaning |
|---|---|
| `hello` | Announces itself on connect. Dropped: identity comes from the URL. |
| `realtime_offer` | Start a call. Carries SDP, and optionally model, chat, voice. |
| `realtime_stop` | End a call. |
| `mcp` (with `result`/`error`) | Answering a tool call we sent it. |

**Mac → device** (`mac/src/protocol.ts`):

| Type | Meaning |
|---|---|
| `realtime_answer` | SDP back, plus the model and chat lists the pickers show. |
| `realtime_transcript_delta` / `_done` | Captions, each tagged user or assistant. |
| `realtime_status` | One-line caption plus optional icon. |
| `realtime_error` | Why the call failed, in words a person can read. |
| `mcp` (with `method`) | Asking the device to run one of its own tools. |

Anything else is dropped **and logged by name**, so a message nobody handles
shows up rather than vanishing.

Inside the firmware, `tts` and `stt` messages are synthesised by the voice
protocol itself and fed to `Application::OnIncomingJson` for the captions.
They never cross the wire. Do not add handlers for them on the Mac.

## The doctor loop

```sh
launchctl list | grep voice-mode                    # is it running
tail -30 /tmp/esp32-voice-mode.log                  # calls
tail -30 /tmp/esp32-voice-mode.err.log              # Codex diagnostics
curl -s -X POST http://127.0.0.1:8790/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

That last one is the fastest single check: it proves the port is open, the MCP
server is answering, and (from the reply to a `tools/call`) whether the device
is connected.

To read the device's own side, over USB:

```sh
python3 firmware/scripts/serial_log.py
tail -f ~/.voicemode/voicemode_live.log
```

## When something is wrong

| Symptom | Meaning | Fix |
|---|---|---|
| No `Device … connected` line ever | The device only dials when a call starts. | Tap it or say the wake word. Not a fault on its own. |
| Device never finds the Mac | The Mac's address changed; the device has one baked in at flash time. | Reserve this Mac's address in the router. Nothing in software can work around it. |
| `Refused a device connection with the wrong token` | Token mismatch. | The device's `CONFIG_VOICEMODE_TOKEN` must equal `DEVICE_SHARED_SECRET` in `.dev.vars`, byte for byte. |
| Call answers, captions appear, **no sound** | Not a signalling fault — the captions prove the transport works. | See `mac/documentation/why-a-call-goes-silent.md`. Compare the `Answer audio:` and `Answer transports:` lines against a good call. |
| Assistant states a device fact it never looked up | It is answering from memory instead of calling a tool. | Check the log for `Asking the device:`. No line means no call was made — the instructions in `mac/src/codex.ts`'s CODEX_DEVELOPER_INSTRUCTION_LIST are what name the controls. |
| `Could not do that: the device is not connected` | Honest and correct. | Start a call first; the socket opens with it. |
| Tool call logged, no `Device answered` within 20s | The device got it and did not reply. | Read the serial log; the device logs every `tools/call` it parses. |
| Codex has no `desk` tools | Not registered, or registered after the app-server started. | `codex mcp add desk --url http://127.0.0.1:8790/mcp`, then restart the listener. |
| Two sets of device tools | An old Cloudflare-era MCP server is still registered and reaches nothing. | `codex mcp list`, remove the dead one. This has happened once and cost an afternoon. |

## Adding a device control

The device already offers more tools than are exposed (`firmware/main/mcp_server.cc`).
To surface one, add it in `mac/src/controls.ts` with `registerTool` and forward via
`bridge.call('<the firmware tool name>', args)`.

Do **not** expose `self.reboot`, `self.upgrade_firmware`, or
`self.assets.set_download_url`. Nothing said out loud in a call should be able
to restart the device or replace its firmware.

## Two things that are easy to get wrong

**Start order.** The port must open before the Codex app-server starts, because
Codex reaches back to that same port for the device controls. Starting Codex
first leaves it with a control endpoint that refused its first connection.

**Captions are not sound.** A run only passes for audio if the assistant's words
were heard from the speaker. The log says so in those words on purpose; do not
report a call as working because it transcribed.
