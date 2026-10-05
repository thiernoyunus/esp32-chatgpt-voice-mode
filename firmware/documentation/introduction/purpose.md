# Purpose

This folder holds the watch software. The computer companion lives at the [repository root](../../../README.md). The current release targets the Waveshare ESP32-S3-Touch-AMOLED-2.06 and has been tested with a Mac on the same wifi. Windows setup remains untested. No server run by this project's author is involved.

## What it is

- A fork of [78/xiaozhi-esp32](https://github.com/78/xiaozhi-esp32) that keeps its hardware abstraction (boards, audio engines, displays) and replaces the brain: the only protocol that matters here is the Codex Voice one.
- Built for two Waveshare watches: **ESP32-S3-Touch-LCD-1.85C (V2)** (round 360×360 LCD) and **ESP32-S3-Touch-AMOLED-2.06** (410×502 AMOLED). Both use the same voice behavior with their own hardware setup.
- A thin client on purpose. The device captures audio, renders a face, plays what the server sends, and reports gestures. Intelligence stays server-side.
- Private in one specific way: the spoken audio goes straight from the device to OpenAI's realtime service and never through the Mac. See [Privacy](privacy.md).

## What it is not

- Not a general xiaozhi distribution: other boards, transports (MQTT/UDP), and cloud integrations are inherited but unmaintained here.
- Not self-contained: without the Mac listener to connect to, the device only wakes, listens, and times out.

## Design rule

The firmware and the Mac listener are two halves of one wire contract, and they change together.

## Navigation

Next: [Privacy](privacy.md)
