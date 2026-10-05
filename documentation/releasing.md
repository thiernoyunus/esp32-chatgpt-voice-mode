# Releasing Codex Voice

One commit and one tag contain the computer companion and matching watch
software. The current release target is the Waveshare ESP32-S3-Touch-AMOLED-2.06.
The older 1.85C source stays in the repository but needs a new physical test.

## Before tagging

1. Run `bun run check` from the repository root.
2. Run the host checks from `firmware/`. For the shared voice messages, first
   write fixtures with `bun run scripts/protocol-fixtures.ts` at the root, then
   pass them to `firmware/scripts/tests/test_voice_messages.py`.
3. Build only `waveshare/esp32-s3-touch-amoled-2.06`. Read the log for `[ERROR]`,
   confirm the latest `firmware/build/xiaozhi.bin` exists, and check the generated
   `firmware/sdkconfig` names that board and enables `VOICEMODE_CODEX_VOICE`,
   `USE_DEVICE_AEC`, and `USE_DEFAULT_MESSAGE_STYLE`. Confirm the address and
   shared secret are non-empty without printing them.
4. On the physical watch, make several separate calls and confirm it hears and
   speaks, including a new call after one ends. A build or caption is not a
   speaker check.
5. Check staged files for secrets, local settings, chat text, and build output.
   Keep both [LICENSE](../LICENSE) and [firmware/LICENSE](../firmware/LICENSE).
6. Record the commit, checks, and any limits in the release notes. Create one
   tag only after those checks pass. Do not move an existing tag.

The previous two-repository checkpoint `working-baseline-2026-10-03` is history;
it is not a release of this combined layout. See
[merging-the-two-repos.md](merging-the-two-repos.md) for the earlier build-mode
failure and why the generated settings must be checked after a clean build.
