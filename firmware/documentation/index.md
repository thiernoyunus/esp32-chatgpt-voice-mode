# Firmware handbook

The current release targets the
[ESP32-S3-Touch-AMOLED-2.06](https://www.waveshare.com/product/esp32-s3-touch-amoled-2.06.htm)
(410×502 AMOLED). Source for the older 1.85C watch remains for a later physical
recheck. This firmware is forked from
[78/xiaozhi-esp32](https://github.com/78/xiaozhi-esp32). It talks to a listener
on one Mac on the same wifi over a control WebSocket plus per-call WebRTC (Codex
Voice). That listener lives at the [repository root](../../README.md).

This handbook is meant to be read in order. Later chapters assume the concepts
introduced earlier. The companion handbook lives at the repository root and covers
everything above the wire. For how to build, format, and contribute, see
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Contents

### Part I — Introduction

1. [Purpose](introduction/purpose.md) — What this fork is and is not
2. [Privacy](introduction/privacy.md) — What leaves the device, and where it goes
3. [Architecture](introduction/architecture.md) — How the codebase is laid out

### Part II — Runtime

4. [Protocol](runtime/protocol.md) — Codex Voice (control WebSocket + WebRTC)
5. [Audio](runtime/audio.md) — Mic to server, server to speaker
6. [Face](runtime/face.md) — Watch UI and call-face orb
7. [Touch](runtime/touch.md) — Gestures and screen sleep
8. [Sounds](runtime/sounds.md) — UI effects and their pitch variants

### Part III — Operations

9. [Toolchain](operations/toolchain.md) — ESP-IDF environment
10. [Build](operations/build.md) — Building the 2.06 watch
11. [Flash](operations/flash.md) — Flashing and serial, with the traps
12. [Provisioning](operations/provisioning.md) — Pointing a device at a server

### Part IV — Reference

13. [Upstream](reference/upstream.md) — Relationship with xiaozhi-esp32
14. [Barge-in](reference/barge-in.md) — Talking over the assistant: what has been tried, and why it failed

### Part V — Contributing

15. [Releasing](releasing.md) — Releasing both parts together
