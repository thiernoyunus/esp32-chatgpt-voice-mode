# esp32-chatgpt-voice-mode

A small round-screen ESP32 device on a desk that you talk to. It connects to
one Mac over your own wifi, and that Mac does the thinking. No server of mine
is involved, and nothing about the conversation is stored anywhere but the Mac.

This repository is the Mac half. The device half is firmware, in its own
checkout.

```
  device  ──── wifi ────►  this Mac  ──── Codex ────►  OpenAI realtime voice
     ▲                                                         │
     └───────────────── spoken audio, directly ────────────────┘
```

The arrows matter. Only the **call setup** passes through this Mac: the
device's WebRTC offer comes in, a ChatGPT Voice session is opened on the Codex
app-server running here, and the answer goes back. The **spoken audio never
touches this Mac at all** — the answer points the device straight at the
realtime service. This process sees signalling and captions and not one audio
packet, which is worth knowing before you debug a silent call: nothing here can
drop, delay, or repair the voice.

## What you need

- A Mac signed in to Codex, with the ChatGPT app installed (the Codex binary
  ships inside it).
- [Bun](https://bun.sh).
- The device, flashed and pointed at this Mac.

## Running it

```sh
bun install
bun run start
```

It reads `DEVICE_SHARED_SECRET` from `.dev.vars` and refuses any device that
does not present it. Copy `.dev.vars.example` to `.dev.vars` and put your own
secret in it — any long random string, as long as the device is flashed with
the same one.

Then point the device at this Mac. In the firmware checkout, in the gitignored
`sdkconfig.defaults.local`:

```
CONFIG_APOLLO_URL="ws://<your-mac-lan-address>:8790"
```

Rebuild and flash. On boot the device asks this host for a firmware version;
the answer is "nothing published", and it carries on. Firmware here is flashed
over the cable, not over the air.

### Give this Mac a fixed address

The device dials one address, baked in at flash time. If your router hands this
Mac a different address later, the device goes quiet until you rebuild and
reflash it. A DHCP reservation in your router settings takes two minutes and
removes the whole failure mode. Nothing in this software can work around it.

## The device's own controls

Volume, brightness and screen capture live on the device itself — its firmware
offers them and waits to be asked. This process does the asking, and offers
them on to Codex as tools, so you can say "turn it down" during a call.

Register them once:

```sh
codex mcp add desk --url http://127.0.0.1:8790/mcp
```

That endpoint answers to this Mac only. It has no password, because Codex has
no way to present one — the guard is that requests from anywhere else on the
network are refused. Four tools are offered: read the device's status, set
volume, set brightness, capture the screen. Reboot and firmware upgrade are
deliberately **not** offered; nothing said out loud in a call should be able to
replace the device's firmware.

## Running it as a service

The device dials this Mac at boot and again whenever a call starts, so a
listener living in a terminal window leaves the device with nothing to talk to.
```sh
./scripts/install-service.sh
```

It works out where this checkout is and where `bun` lives, writes the launch
agent, and starts it. Nothing machine-specific is committed.

Check it, and read its logs:

```sh
launchctl list | grep voice-mode
tail -f /tmp/esp32-voice-mode.log      # calls: offers, answers, evidence
tail -f /tmp/esp32-voice-mode.err.log  # Codex app-server diagnostics
```

Remove it with `launchctl bootout gui/$(id -u)/local.esp32-voice-mode`.

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
produced captions proves the connection works and proves nothing about whether
anything came out of the speaker. Only a person standing at the device can
confirm that, which is why the log says so instead of claiming success.

The two `Answer…` lines exist for one specific failure: a session that comes up
healthy, transcribes both sides, and stays silent. They record whether the
answer negotiated audio at all, and whether audio and events share one
transport. Compare a silent call against a good one.

## Known limits

- One device at a time in practice. Per-connection state exists, but only one
  call is tracked.
- The device is trusted on a shared token alone. Treat the port as something
  on your home network, not something on the internet.
- Some sessions deliver one or two silence-sized frames and then nothing, while
  captions keep arriving. The device catches this in about two and a half
  seconds, ends the call, and a later attempt usually gets a working session.
  This predates the direct connection and also happened on the old cloud path.

## History

This began from the Apollo starter — generated from its template rather than
forked from it — which routed every call through a Cloudflare Worker. The
Worker is gone: about 29,000 lines of it, replaced by the few hundred here.
See [LICENSE](LICENSE) for what that leaves behind.

The device firmware descends from
[78/xiaozhi-esp32](https://github.com/78/xiaozhi-esp32), which is excellent and
worth using directly if you want a general-purpose multi-board build.
