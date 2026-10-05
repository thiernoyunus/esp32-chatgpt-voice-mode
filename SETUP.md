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
| Device | Waveshare **ESP32-S3-Touch-AMOLED-2.06** (410×502 AMOLED), and a USB-C cable that carries data |
| Computer | A **Mac**, on the same wifi as the device will be |
| On that Mac | The **ChatGPT app**, signed in — the Codex binary ships inside it |
| | [Bun](https://bun.sh) |
| | [ESP-IDF **v6.0.2**](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/get-started/) — only for building the firmware |

The older 1.85C watch has source here but needs a fresh physical check before
this setup guide can recommend it. Windows setup also remains untested.

### Setup and doctor commands

`bun run setup --board <watch-name>` writes the two files that must hold the same secret: this
checkout's `.dev.vars` and the firmware's `sdkconfig.defaults.local`. It shows
the plan and asks before writing, never overwrites a file that already exists, so
a secret you are already using is safe, and it uses the one secret for both
sides. It works out this Mac's address on your wifi, and finds the firmware
checkout when that checkout sits beside this one; `--dry-run` stops after the
preview. Choose `esp32-s3-touch-amoled-2.06`. `bun run setup --help`
lists the rest.

`bun run doctor` checks an existing install and changes nothing — it exits
non-zero when something needs attention, and `bun run doctor --json` prints the
report in a form a program can read. Every step below also works by hand, which
is what to fall back on if a command and your eyes disagree.

### Two things that may block you

The companion enables the experimental `features.realtime_conversation`
setting. Compatibility depends on the installed Codex version. The listener
prefers the copy inside the ChatGPT app; check that copy with:

```sh
/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex --version
```

If that path does not exist, your ChatGPT app is older or laid out differently.
Point the service at your own copy with `VOICEMODE_CODEX_BIN`.

This project does not establish which account plans have voice access. Doctor's
program/version check does not verify eligibility. Troubleshoot the actual
sign-in, model availability, or usage-limit error rather than assuming a plan
upgrade is needed.

## 1. The Mac half

```sh
git clone https://github.com/thiernoyunus/esp32-chatgpt-voice-mode.git
cd esp32-chatgpt-voice-mode
bun install
bun run setup --board esp32-s3-touch-amoled-2.06
./scripts/install-service.sh
bun run doctor
```

Run the setup line for your watch. Review setup's detected Mac address before
approving the new files. If needed,
use `--host <your-Mac-address>` and `--firmware-dir <firmware-folder>`.
Existing files are preserved; conflicting secrets need a deliberate correction.
Setup does not build or install firmware. Continue with step 2 after the Mac is
ready. Doctor reports a missing listener before service startup; retry after
startup if it reports `starting`.

### Manual alternative

Skip this alternative if setup created your files. To prepare them yourself,
make a shared secret. The device and the Mac must present the same one:

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

For the manual alternative, start it in the foreground (leave this terminal
open). Do not start a second listener if the background service is already up:

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

There is a second, quieter check, which is what `bun run doctor` reads:

```sh
curl -s http://127.0.0.1:8790/health
```

A ready listener answers `200` with `"status":"ready"`; `503` with
`"status":"starting"` means Codex has not come up yet. It also reports whether
the device is connected and how many calls are active. The report is reachable
from this Mac only, and it never contains chat text or your secret.

The background service keeps running the code it started with. After updating
source, restart it deliberately (or reinstall with `./scripts/install-service.sh`)
to load listener changes. The setup and doctor commands read the current checkout
immediately. Preserve custom install settings when reinstalling.

### Give this Mac a fixed address

Do this now, not later. The device dials one address, **baked in when you flash
it**. If your router hands the Mac a different address next week, the device
goes silent. A DHCP reservation in your router settings takes two minutes and
removes the problem permanently; that is the best fix.

A device can also be repointed without rebuilding, by writing the new address,
secret and device id into its stored settings — the firmware's `voicemode`
namespace, described in the firmware's
[provisioning page](firmware/documentation/operations/provisioning.md).
Full provisioning rewrites the device's storage partition and takes the wifi
credentials with it, so rebuilding is usually less trouble. What neither fix
does is let the device find a Mac that quietly changed address: the device
always dials what it was told.

## 2. The device half

```sh
cd firmware
```

Setup creates `sdkconfig.defaults.local` in this folder. Review it
locally; if using the manual alternative, create it with the following values.
It holds your secret, so **never commit it**:

```
CONFIG_VOICEMODE_URL="ws://192.168.1.20:8790"
CONFIG_VOICEMODE_TOKEN="the-same-secret-from-step-1"
CONFIG_VOICEMODE_DEVICE_ID="watch"
```

Use your own address, and the exact secret from step 1. The selected board's
build settings supply `watch` for the AMOLED if you did
not deliberately override the device id.

Build:

```sh
. ~/esp/esp-idf/export.sh
python3 scripts/build.py waveshare/esp32-s3-touch-amoled-2.06
```

Run only the one command for the watch you have. **Check:** the last lines say
`Project build complete`, `build/xiaozhi.bin` exists, and `sdkconfig` names the
board you chose. Note the trap in
[firmware/documentation/operations/build.md](firmware/documentation/operations/build.md):
an older image may still be in `build/` after a failed run, so read the output
and check the selected board before flashing.

Plug the device in and flash:

```sh
ls /dev/cu.usbmodem*
idf.py -p /dev/cu.usbmodemXXXX flash
```

**Check:** five `Hash of data verified.` lines, then `Hard resetting`.

## 3. Wifi on the device

On first boot, with no saved network, the watch opens its own Wi-Fi hotspot.
Join it from a phone, open `192.168.4.1`, and give it your Wi-Fi name and
password. This is normally a one-time step. The watch saves the network and
reconnects on later boots.

From the watch's Home screen, open **Settings → Wi-Fi** to scan nearby networks.
Tap one, enter its password on the watch, and join. Saved networks can be
selected again without retyping. **Phone setup** remains available on that
page when typing a long password on the watch is inconvenient. The Mac and
watch must be able to reach each other on the same local network; the watch's
temporary setup hotspot is only for entering the Wi-Fi details.

**Check:** the Mac's log prints `Device "watch" connected on the local network.`

If it does not, the two most likely causes, in order: the address in
`CONFIG_VOICEMODE_URL` is not this Mac's, or the secret does not match. A
mismatched secret shows up as `Refused a device connection with the wrong
token` in the Mac's log.

## 4. Make a call

Tap the screen and ask something out loud.

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
[documentation/why-a-call-goes-silent.md](documentation/why-a-call-goes-silent.md)
— most of the obvious theories are already ruled out there.

Worth knowing while you debug: the voice does not travel through this Mac. The
device talks straight to OpenAI's realtime voice service for audio; this Mac
carries call setup and text. The Mac's audio negotiation can still cause a silent
call. Compare its negotiation logs with the device's audio/playback evidence;
only listening at the device confirms speaker output.

## 5. The device's own controls

Volume, brightness and screen capture live in the firmware and need something
to ask for them. Register them with Codex once:

```sh
codex mcp add desk --url http://127.0.0.1:8790/mcp
```

Then restart the listener, so Codex picks them up. The tool server lists both
connected watches. Each control accepts an optional `device_id`; the current
2.06 AMOLED watch uses `watch`. Without one, it controls the active watch.

From this Mac, `curl http://127.0.0.1:8790/devices` shows the connected watches
and active selection. To select the AMOLED as the default:

```sh
curl -X PUT -H 'Content-Type: application/json' \
  --data '{"deviceId":"watch"}' http://127.0.0.1:8790/devices
```

**Check:** on a call, say "what's your volume?" then "set it to 50". The log
should show:

```
Asking device "watch": self.get_device_status {}
Device "watch" answered #1.
Asking device "watch": self.audio_speaker.set_volume {"volume":50}
```

If the assistant states a volume without those lines appearing, it made the
number up — the tools are not reaching it. Check for a second, stale device
MCP server with `codex mcp list`.

## 6. Keep it running

The device dials the Mac at boot and whenever a call starts, so a listener in a
terminal window is not enough.

```sh
cd ..
./scripts/install-service.sh
```

Optional machine-specific settings, passed through at install time and never
committed:

```sh
VOICEMODE_CODEX_MODEL=gpt-6-luna \
VOICEMODE_CODEX_DISABLE_MCP=slow-server,another \
  ./scripts/install-service.sh
```

Use a model your Codex actually offers. A retired name is remapped where a
replacement is known — asking for `gpt-5.6-luna` resolves to `gpt-6-luna` — and
a name with no replacement fails the call with `Unknown voice model:` in the log,
listing what is available.

`VOICEMODE_CODEX_DISABLE_MCP` matters if you have MCP servers that are slow to
start: every one of them delays the first call after a restart.

**Check:**

```sh
launchctl list | grep voice-mode      # a PID and status 0
tail -f /tmp/esp32-voice-mode.log
```

### Voice chat storage and macOS permissions

New voice chats use `~/Library/Application Support/ESP32 Voice Mode/chats`.
The background service checks that Codex itself can read configuration there
before reporting ready. Check the log for `Voice chat folder verified by Codex`.
Then make a real call; startup checks do not prove speaker audio works.

Older installs may explicitly use `~/Documents/Codex`. macOS can allow the
terminal or listener to access Documents while denying its background Codex
process. The device then briefly connects and returns to idle with
`failed to load configuration: Operation not permitted`.

For an affected install, choose storage for new calls and reinstall:

```sh
VOICEMODE_CODEX_ROOT="$HOME/Library/Application Support/ESP32 Voice Mode/chats" \
  ./scripts/install-service.sh
```

Pass any existing model, binary, or disabled-tool settings again when reinstalling.
This changes the location for new chats only; it does not move or delete old
chats. Opening an old chat in a protected folder still needs macOS permission.
To keep a custom folder, grant the background service access using macOS Privacy
& Security. Do not disable macOS protection. Custom absolute paths remain supported
through `VOICEMODE_CODEX_ROOT` (or the older `VOICEMODE_CODEX_CWD`).

### Archiving after a voice call

The companion asks its Codex process to release idle chats without the default
waiting period. Ending a call stops voice and unsubscribes from the chat; it no
longer starts a second text response from everything spoken during the call.
Saved speech remains in the voice timeline.

The log prints `Voice chat released` when Codex accepts the release. The desktop
can then archive once Codex finishes closing the chat. This is not a promise to
interrupt genuine work still running in that chat. Release errors are logged.

## When it breaks

`.claude/skills/desk-voice/SKILL.md` in this repository is a table of symptom,
meaning and fix — written for whoever is debugging, agent or person. It covers
the whole wire contract, the fastest health check, and the mistakes already
made once each.
