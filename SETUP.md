# Setting this up from nothing

Two halves: a small ESP32 device, and one Mac on the same wifi. This walks
through both, in the order that works, with a way to check each step actually
worked before moving on.

**If you are an AI agent doing this for someone:** every command here is meant
to be run as written, and every step has a check. Do not skip the checks — the
failure most likely to waste an hour is a secret that does not match on both
sides, and it shows up as silence with no error.

## What you need before starting

| | |
|---|---|
| Device | Waveshare **ESP32-S3-Touch-LCD-1.85C (V2)**, round 360×360 touch display, and a USB-C cable that carries data |
| Computer | A **Mac**, on the same wifi as the device will be |
| On that Mac | The **ChatGPT app**, signed in — the Codex binary ships inside it |
| | [Bun](https://bun.sh) |
| | [ESP-IDF **v6.0.2**](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/get-started/) — only for building the firmware |

Only this one board is supported. Around a hundred other board definitions
were deliberately removed. For a general-purpose, many-board build, use
[78/xiaozhi-esp32](https://github.com/78/xiaozhi-esp32) instead.

### Two things that may block you

This is built against **Codex CLI 0.154.0-alpha**, and it turns on an
experimental setting called `features.realtime_conversation`. If your Codex is
older or on a stable channel, the voice call may not start at all. Check with:

```sh
/Applications/ChatGPT.app/Contents/Resources/codex --version
```

Whether a particular ChatGPT plan is required for realtime voice, I do not
know — if calls fail to start and your Codex version is current, that is the
next thing to suspect.

## 1. The Mac half (`mac/`)

One clone gets you both halves:

```sh
git clone https://github.com/thiernoyunus/esp32-chatgpt-voice-mode.git
cd esp32-chatgpt-voice-mode/mac
bun install
```

Make a shared secret. The device and the Mac must present the same one:

```sh
cp .dev.vars.example .dev.vars
openssl rand -base64 32
```

Put that value after `DEVICE_SHARED_SECRET=` in `.dev.vars`, and **keep it
somewhere** — you need the identical string when you build the firmware.

Find this Mac's address on your wifi:

```sh
ipconfig getifaddr en0
```

Write that down too. Something like `192.168.1.20`.

Start it:

```sh
bun run start
```

**Check:** within about thirty seconds you should see

```
Listening for the device on ws://0.0.0.0:8790/agents/voicemode/<deviceId>
Device controls for Codex on http://127.0.0.1:8790/mcp
Codex app-server ready.
```

If `Codex app-server ready` never appears, Codex could not start — open the
ChatGPT app and make sure you are signed in.

### Give this Mac a fixed address

Do this now, not later. The device dials one address, **baked in when you flash
it**. If your router hands the Mac a different address next week, the device
goes silent until you rebuild and reflash. A DHCP reservation in your router
settings takes two minutes and removes the problem permanently. Nothing in this
software can work around it.

## 2. The device half (`firmware/`)

Already cloned — it is the `firmware/` folder beside `mac/`:

```sh
cd ../firmware
```

Create `firmware/sdkconfig.defaults.local` — it is gitignored because it holds your
secret, so **never commit it**:

```
CONFIG_VOICEMODE_URL="ws://192.168.1.20:8790"
CONFIG_VOICEMODE_TOKEN="the-same-secret-from-step-1"
CONFIG_VOICEMODE_DEVICE_ID="desk"
```

Use your own address, and the exact secret from step 1.

Build. The `set-target` line is only needed the first time, and skipping it is
the most likely way to fail here — without it the build assumes a plain ESP32,
the board never gets selected, and configuration stops with *"The selected
board does not define BOARD_DIR"*:

```sh
. ~/esp/esp-idf/export.sh
idf.py set-target esp32s3
idf.py build
```

**Check:** the last lines say `Project build complete` and report a binary
size, with about 13% of the partition free.

Note the trap in
[firmware/documentation/operations/build.md](firmware/documentation/operations/build.md):
the older `scripts/build.py` wrapper exits 0 even when the build failed. `idf.py`
itself reports failure honestly, which is why it is used here.

Plug the device in and flash:

```sh
ls /dev/cu.usbmodem*
idf.py -p /dev/cu.usbmodemXXXX flash
```

**Check:** five `Hash of data verified.` lines, then `Hard resetting`.

## 3. Wifi on the device

On first boot the device opens its own wifi hotspot and shows instructions on
screen. Join it from a phone, open `192.168.4.1`, and give it your wifi name
and password.

**Check:** the Mac's log prints `Device "desk" connected on the local network.`

If it does not, the two most likely causes, in order: the address in
`CONFIG_VOICEMODE_URL` is not this Mac's, or the secret does not match. A
mismatched secret shows up as `Refused a device connection with the wrong
token` in the Mac's log.

## 4. Make a call

Tap the screen, or say the wake word, and ask something out loud.

**Check**, in the Mac's log:

```
Voice offer …: 919 bytes of SDP
Voice answer …: chat …, bridge in 2558 ms
Answer audio: m=audio … (sendrecv, 111 opus/48000/2)
Call ended: … microphone heard; assistant spoke 7 words
```

**Captions are not sound.** All of the above can appear on a call you could not
hear. The only proof of working audio is a person standing at the device
hearing it. If it connects but stays silent, see
[mac/documentation/why-a-call-goes-silent.md](mac/documentation/why-a-call-goes-silent.md)
— most of the obvious theories are already ruled out there.

## 5. The device's own controls

Volume, brightness and screen capture live in the firmware and need something
to ask for them. Register them with Codex once:

```sh
codex mcp add desk --url http://127.0.0.1:8790/mcp
```

Then restart the listener, so Codex picks them up.

**Check:** on a call, say "what's your volume?" then "set it to 50". The log
should show:

```
Asking the device: self.get_device_status {}
Device answered #1: {"audio_speaker":{"volume":83}, …}
Asking the device: self.audio_speaker.set_volume {"volume":50}
```

If the assistant states a volume without those lines appearing, it made the
number up — the tools are not reaching it. Check for a second, stale device
MCP server with `codex mcp list`.

## 6. Keep it running

The device dials the Mac at boot and whenever a call starts, so a listener in a
terminal window is not enough.

```sh
./scripts/install-service.sh
```

Optional machine-specific settings, passed through at install time and never
committed:

```sh
VOICEMODE_CODEX_MODEL=gpt-5.6-luna \
VOICEMODE_CODEX_DISABLE_MCP=slow-server,another \
  ./scripts/install-service.sh
```

`VOICEMODE_CODEX_DISABLE_MCP` matters if you have MCP servers that are slow to
start: every one of them delays the first call after a restart.

**Check:**

```sh
launchctl list | grep voice-mode      # a PID and status 0
tail -f /tmp/esp32-voice-mode.log
```

## When it breaks

`.claude/skills/desk-voice/SKILL.md` in this repository is a table of symptom,
meaning and fix — written for whoever is debugging, agent or person. It covers
the whole wire contract, the fastest health check, and the mistakes already
made once each.
