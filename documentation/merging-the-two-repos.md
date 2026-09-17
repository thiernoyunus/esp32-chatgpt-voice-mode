# Merging the two repositories: what happened, and how to do it again

This is a handover for whoever attempts the merge a second time. It was done
once, reverted, and this records why — because the obvious conclusion is the
wrong one.

## The headline

**The merge worked. It changed no code.**

Every firmware source file was byte-identical before and after, verified file by
file. The revert was not because the merge broke anything.

What broke the evening was a **rebuild done during the merge work**, which
silently changed the device's operating mode. Every symptom after that was
chased as a code fault. It was not one.

If you take one thing from this document: **do not rebuild the firmware from a
deleted `sdkconfig` unless you check what the new one contains.**

## What the two halves are

| Repository | Contains |
|---|---|
| `esp32-chatgpt-voice-mode` | The Mac listener. TypeScript, run with Bun. |
| `esp32-chatgpt-voice-mode-firmware` | The ESP32 firmware. C++, built with ESP-IDF v6.0.2. |

They share one wire contract and must change together. That is the argument for
merging them. They have different licences and provenance — the firmware is a
xiaozhi derivative, the Mac side is original — which is the argument against.
Both are real; the user chose to merge.

## How the merge was done, and it was fine

```sh
# 1. make room
mkdir mac
git mv src scripts documentation package.json tsconfig.json bun.lock mac/
git commit -m "Make room: the Mac half moves into mac/"

# 2. bring the firmware in whole, with its history squashed to one commit
git subtree add --prefix=firmware <firmware-repo-url> main --squash
```

Result: `firmware/` and `mac/` side by side, both histories kept, one clone for
a newcomer.

**Verify it changed nothing.** This step is cheap and worth doing:

```sh
git ls-tree -r --name-only <pre-merge-ref> -- main | while read f; do
  a=$(git -C <old-repo> show "<pre-merge-ref>:$f" | md5)
  b=$(git show "<merge-ref>:firmware/$f" | md5)
  [ "$a" = "$b" ] || echo "DIFFERS: $f"
done
```

Silence means the merge moved files and nothing else.

The merged state is preserved on the branch `archive/merged-and-debugged`. The
merge commits are `1330389` and `7c49e61`.

## What actually went wrong

After merging, the firmware was rebuilt from scratch to check that a fresh clone
would work. `sdkconfig` was deleted for that test.

`sdkconfig` is the generated build configuration. Deleting it is normally safe:
it regenerates from the `sdkconfig.defaults*` files. But **two critical settings
were not in any file ESP-IDF loads.** They lived in
`sdkconfig.defaults.codex-voice`, a name ESP-IDF does not read automatically.
They had survived only inside the developer's own generated `sdkconfig`, which
is gitignored.

The two settings:

```
CONFIG_VOICEMODE_CODEX_VOICE=y
CONFIG_USE_DEVICE_AEC=y
```

`CONFIG_USE_DEVICE_AEC` decides the whole conversational model:

| Set | Not set |
|---|---|
| Microphone stays open while the assistant speaks | Microphone closes during a reply |
| Call runs until the person ends it | Call ends ~1.2 s after the person stops talking |
| Continuous conversation | One exchange, then idle |

So the rebuild produced a device in **press-to-talk mode**. The user reported
calls dropping when they paused, short phrases being ignored, and replies being
cut off. All of those are simply what press-to-talk mode does. They were
diagnosed as bugs, and **eight firmware changes were made chasing them**, each
introducing or revealing another problem. All eight were reverted.

A second instance of the same fault: `sdkconfig.defaults.local` holds the Mac's
address and the shared secret, and is also not a name ESP-IDF loads. A build
without it produces firmware with an empty URL. The device shows "connecting"
for a moment and gives up, with nothing in any log to explain why.

## Both traps are already fixed

Do not re-introduce them.

- The two mode settings now live in `sdkconfig.defaults.esp32s3`, which every
  build reads. `sdkconfig.defaults.codex-voice` is deleted.
- `CMakeLists.txt` now names `sdkconfig.defaults.local` in `SDKCONFIG_DEFAULTS`,
  so local settings load on every build.

Verified by deleting `sdkconfig`, running `idf.py set-target esp32s3`, and
confirming all four settings land.

## Checklist for the second attempt

1. Merge with `git subtree add --prefix=firmware`, as above.
2. Verify file by file that no source changed. Stop if anything differs.
3. **Before flashing anything**, check the build produced the right settings:

   ```sh
   grep -E '^CONFIG_(VOICEMODE_URL|VOICEMODE_TOKEN|USE_DEVICE_AEC|VOICEMODE_CODEX_VOICE)' sdkconfig
   ```

   All four must have values. An empty URL, or a missing AEC line, means stop.
4. Update the paths that move. These were missed the first time and each cost a
   restart:
   - `~/Library/LaunchAgents/local.esp32-voice-mode.plist` (working directory)
   - `~/Library/LaunchAgents/local.voicemode-monitor.plist` and
     `local.voicemode-seriallog.plist` (script paths)
   - `SETUP.md`, both `README.md` files, `.claude/skills/desk-voice/SKILL.md`
   - The GitHub repository description, which lives outside git and was stale
     for an hour before anyone noticed
5. Re-run `./mac/scripts/install-service.sh` after moving the Mac half.
6. Keep `firmware/README.md` saying that folder descends from xiaozhi and the
   Mac folder does not. Adjacent folders make that easy to lose.

## How to tell a configuration fault from a code fault

The distinction that was missed for hours:

- Behaviour changed immediately after a rebuild, with no code change → suspect
  the build configuration first.
- The device log line `AFE Pipeline: [input] -> |AEC(...)| -> [output]` shows
  whether echo cancellation is running.
- `grep -E '^CONFIG_' sdkconfig` is faster than reading any source file.

## What is still unsolved, and is not a merge problem

- **Barge-in.** The assistant cannot be interrupted. See
  `firmware/documentation/reference/barge-in.md` — five attempts, real
  measurements, and attempt 5 (software reference signal, full-duplex mode)
  measured correctly but was never confirmed on hardware. That work is on the
  `aec_improve` branch of the private `apollo-firmware` repository.
- **Sessions that carry no voice.** Some calls deliver only 3-byte keepalive
  packets and never a frame of speech. Captions still arrive, so the call looks
  healthy and is silent. This predates all of the above and also happened on the
  earlier Cloudflare path. The device log shows it as `bytes=3` in the
  `CodexVoice: [DEBUG-audio]` lines; a healthy call shows `bytes=72` or more.
