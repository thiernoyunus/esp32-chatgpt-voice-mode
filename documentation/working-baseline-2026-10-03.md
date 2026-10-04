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

## Companion changes saved

Voice chat display and ordering, chat folders, recent-chat selection, failed-call
reuse, connection offer handling, current Codex executable/model support, and the
associated tests. Standalone remote-control login/pairing experiments and private
investigation notes remain local; they are not imported by the running service.

Validation: TypeScript checks and all 40 tests passed on October 3.
