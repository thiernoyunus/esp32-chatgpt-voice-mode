# Working setup checkpoint — 2026-10-03

This checkpoint saves the source currently on the owner's Mac. Both repositories
use the tag `working-baseline-2026-10-03` and are a matched pair:

- Mac companion: https://github.com/thiernoyunus/esp32-chatgpt-voice-mode
- Device software: https://github.com/thiernoyunus/esp32-chatgpt-voice-mode-firmware

The owner reports that the current device setup is working and wants it preserved.
This is a recovery checkpoint, not a claim that every feature has passed new
physical-device testing.

## What was verified

- The running Mac service uses the companion checkout containing these changes.
- The physical device answered a live, read-only status request.
- Available device logs identify Codex Voice and firmware version 2.7.4.
- The preserved local build also reports 2.7.4 and enables
  `CONFIG_VOICEMODE_CODEX_VOICE` and `CONFIG_USE_DEFAULT_MESSAGE_STYLE`.
- The exact installed device image has NOT been compared byte-for-byte with that
  local build. The build date is September 20; do not infer an installation date.

## Recovery materials

Before committing, a private local backup captured both repositories' source and
Git histories, the existing device build, and machine-specific settings. Its
archives were read back and compared with the original files. These private
settings and binaries are deliberately not published in these public repositories.

Preserved `build/xiaozhi.bin` SHA-256:
`a80926291c3ba8fc4984603d20d7fce0cb7c3a8e19f5349dc8070618501c4354`

A checkout alone does not contain personal connection settings or credentials.
Restore those from the private backup or follow the setup instructions. Do not
rebuild or install firmware merely to restore Git state. Before any future
installation, verify the Codex Voice build settings and establish that the saved
image is the intended recovery image. No device software was installed for this
checkpoint, and the running companion service was not restarted.

## Device source changes saved

Show folder labels beside recent chats and refresh the list when those labels
change. This saves the existing source without rebuilding the preserved image.

Validation limitation: the existing `scripts/tests/test_codex_profile.py` fails
before running its assertions because it searches for `choice DISPLAY_STYLE`,
which is absent from the previously committed configuration too. This pre-existing
test mismatch was recorded without altering the working device software. The
preserved generated build configuration was checked directly for both required
Codex Voice/orb settings. No fresh firmware build or physical audio test was run.
