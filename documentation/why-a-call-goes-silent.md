# Why a call goes silent

Notes from chasing the one failure that keeps coming back: a call that connects,
transcribes both sides perfectly, and produces no sound from the speaker.

Read this before changing anything in the signalling path, because most of the
obvious theories are already ruled out below.

## Where the voice actually travels

This is the fact everything else depends on, and it is not obvious.

With the Codex app-server asked to log its own realtime traffic
(`RUST_LOG=codex_core::realtime_conversation=trace`, which the launch agent
sets), a whole call produces exactly these events:

```
InputTranscriptDelta   OutputTranscriptDelta
InputTranscriptDone    OutputTranscriptDone
SessionUpdated         HandoffRequested
```

There is no audio event, because **the spoken audio never passes through this
Mac.** The app-server hands the device's offer to the realtime service and then
relays text only; the audio goes from the device to that service directly.

Three consequences:

1. Neither this listener nor the Codex app-server can drop or repair the voice.
   Neither sees a single audio packet.
2. A session with captions and no voice is **not** a signalling fault. The
   transport is demonstrably fine, because the captions are using it.
3. The device is the only party that can report the fault, which is what its
   readiness links and its stall message do.

## What has been ruled out

**It is not ICE, and nothing is split across two transports.** The answer
bundles audio and events onto one transport with one shared set of ICE
credentials. The `Answer transports:` line in the log confirms this per call —
look for `shared-transport=true`.

**It is not the opening greeting.** Suppressing the greeting entirely was tried,
on the theory that the first response was the one being lost. Sessions still
came up with captions and no voice, so the opening response is not the trigger.
The greeting is back on.

**It is not the codec or the direction.** The `Answer audio:` line records what
the answer negotiated. A healthy call shows `sendrecv` and `opus/48000/2`. This
line exists precisely so a silent call can be compared against a good one
instead of guessed at.

**It is not the local network path.** The same fault appeared on the old
Cloudflare route, so it predates the direct connection entirely.

## What is actually observed

Some sessions deliver a steady stream of inbound audio frames. Others deliver
one or two silence-sized frames and then nothing at all for the rest of the
reply, while transcripts keep arriving over the same transport.

The device's stall check catches this in about two and a half seconds when a
call has never been heard, tears the call down, and a later attempt usually gets
a session that works.

## How to read a run

| What you want to know | Where to look |
|:--|:--|
| The device reached this Mac | Listener: `Device "desk" connected` |
| Negotiation completed | Listener: `Voice offer … bytes of SDP` then `Voice answer …` |
| Audio was negotiated at all | Listener: `Answer audio:` — wants `sendrecv` and `opus` |
| One transport, not two | Listener: `Answer transports:` — wants `shared-transport=true` |
| The microphone was heard | Listener: `microphone heard` |
| Downlink audio reached the device | Device log: `Voice path reached playback`, `Playing N opening frames` |
| **Sound actually came out** | **A person standing at the device, and nothing else** |
| It failed, and why | Device log: `No reply audio for … ms; reached … missing …` |

That last row is the whole point of this file. Captions and packet counters are
not sound. A run only passes for audio if the assistant's words were heard from
the speaker.
