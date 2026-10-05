# Privacy

What leaves the device, and where it goes. The device is a thin client: it
captures audio, draws a face, plays what it is sent, and reports touch. It stores
almost nothing.

## What goes where

| What | Where it goes |
|:--|:--|
| Spoken audio, both directions | OpenAI's realtime voice service, directly from the device |
| Call setup (the offer and the answer) | The one Mac you point it at, then Codex there |
| Captions, tool calls, status | The one Mac, then Codex there |
| Chat text | The Mac — the device keeps none |
| Device settings, wifi name and password | The device's own storage |
| Anything at all | No server run by this project's author |

## The details worth knowing

- **The audio does not pass through the Mac.** The Mac relays the call setup and
  the text; the voice travels straight between the device and the realtime
  service. The listener does not handle audio packets, but its call setup and
  audio negotiation can affect whether the device receives sound.
- **The shared secret is the whole guard.** Anyone on your network with the same
  string can present themselves as your device. Treat it like a password and do
  not reuse it elsewhere.
- **The Mac's control endpoint is Mac-only.** Volume, brightness and screen
  capture are asked for by the Mac, and that endpoint refuses requests from
  anywhere else on the network.
- **Provisioning material is sensitive.** A full NVS dump or a shared
  `sdkconfig.defaults.local` can carry the secret and stored settings; review
  before sharing any of it.
- **The audio reaches OpenAI as part of the call**, under the terms of the
  account signed in on the Mac.

## Navigation

Prev: [Purpose](purpose.md) · Next: [Architecture](architecture.md)
