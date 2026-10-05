# Making a desk-device voice chat behave like a normal Codex voice chat

Handoff note, 18 September 2026. Written for whoever picks this up next.

## What we are trying to fix

When you start a voice chat from the **Codex phone app**, four things happen:

1. a new chat appears in the Codex desktop sidebar the moment you start talking
2. the text fills in live as you speak
3. it renders as an ordinary conversation — green user bubbles, plain assistant text
4. you can archive it afterwards

When you start one from the **ESP32 desk device**, through this bridge, the same
desktop app instead:

1. does not surface the chat in Recents
2. (the text does stream — this part was never broken, see below)
3. renders the whole conversation inside one box with a grey vertical rule, with
   a branch/environment panel and `Worked for 5m 38s` headers
4. refuses to archive it: *"This is open in another app. Close it there to
   continue here."* / *"Failed to archive conversation."*

Goal: make (1), (3) and (4) match the phone.

## Established facts

All verified against `openai/codex` source and the owner's own `~/.codex` data.
Do not re-derive these.

### The box is the git repository

Codex stamps a `git` block onto a thread when its `cwd` is inside a repository
(`codex-rs/git-utils/src/info.rs`). A repo-backed thread renders as a **coding
task**; a non-repo one renders as a **conversation**. Across all 79 voice threads
on this machine the split was exact:

| origin | cwd is a repo | rendering |
| --- | --- | --- |
| esp32 device (38) | yes | boxed |
| apollo bridge (31) | yes | boxed |
| Codex Desktop voice (7) | no | plain |
| codex_work_desktop voice (3) | no | plain |

A native voice chat opens in a per-chat scratch folder such as
`~/Documents/Codex/2026-09-17/new-realtime-voice-chat`. That convention is not in
the open source — the desktop app invents it.

### The archive failure is a writer lock

- Codex takes an exclusive lock on `$CODEX_HOME/thread-writer-locks/<id>.lock`
  for whichever app-server process has the thread loaded
  (`codex-rs/rollout/src/writer_lock.rs`, `thread-store/src/local/live_writer.rs`).
- `thread/start` **auto-subscribes** the calling connection
  (`app-server/src/request_processors/thread_processor.rs`).
- The lock releases only when nothing is subscribed *and* the thread has been
  idle for `thread_unload_delay` — **default 60s** (`core/src/config/mod.rs`).
- `thread/archive` refuses with `-32600 thread {id} already has an active writer`
  while the lock is held.

This bridge never sent `thread/unsubscribe`, so the idle timer never started and
it held **every chat it had ever opened** until the process exited.

### Turns are saved during the call, not at the end

`finish_segment` seals a transcript segment when the speaker finishes it
(`codex-rs/core/src/realtime_history.rs`). Verified on real data: a 100-second
call wrote 14 segments at 6s, 16s, 25s … 99s. If the desktop *appears* to lag,
that is the client re-reading, not the data.

### Instant sidebar appearance needs the desktop IPC bridge

`thread/started` is broadcast only to connections of the app-server process that
created the thread. This bridge still has its own `codex app-server`, so it does
not receive that native event. The bridge now connects to Codex Desktop's local
IPC socket, invalidates the desktop `tasks` query immediately after creating or
naming a chat, and supplies a read-only conversation snapshot when the desktop
opens it. That is the smallest working bridge across the two app-server
processes; if Codex changes this private IPC contract, the safe fallback is the
next normal index refresh.

## Changes already made (uncommitted, in `src/codex.ts`)

1. **`flushTranscriptTailOnSessionEnd: true` → `false`.** This flag is what posted
   *"The user just ended their realtime session. Here is the remaining
   handoff/transcript tail…"* into the chat after every call, with the assistant
   dutifully replying. It has nothing to do with saving the conversation.
2. **Added `thread/unsubscribe` at call end** (`#releaseThread`, called from both
   realtime-stop paths). **Verified working**: after a hang-up the lock dropped
   ~60s later, watched with `lsof`.
3. **`threadSource: 'voicemode'` → `'realtime_voice'`.** Evidence, not proof —
   see open questions.
4. **`thread/list` bug**: the bridge sent `pageSize`, which is not a field on
   `ThreadListParams` (it is `limit`) and was silently dropped, so every refresh
   pulled a full server page for a ten-row picker. The picker now reads across
   Codex rather than filtering to one working folder.
5. **Added the desktop IPC handoff.** The bridge registers each voice thread as
   its read-only owner, refreshes the desktop `tasks` list, and converts
   `thread/timeline/list` realtime items into the snapshot fields the desktop
   renderer already uses. This is what makes the current transcript appear
   instead of leaving a blank loading page.
6. **Filled the catalog preview metadata.** Realtime-only rows otherwise have
   an empty `preview`, and the desktop catalog hides those rows even when they
   already have a title. The bridge writes only that sidebar metadata (a
   placeholder at creation, then the first spoken sentence); it does not add a
   fake transcript turn.

### Changed outside the repo

`~/Library/LaunchAgents/local.esp32-voice-mode.plist` now sets:

```
VOICEMODE_CODEX_CWD=$HOME/Documents/Codex/desk-voice
```

`VOICEMODE_CODEX_CWD` already existed (`src/listener.ts`) and had never been set,
so chats inherited `process.cwd()` — this repo — which is what made every one of
them a coding task. It must go in the plist, **not** `.dev.vars`: that file is
parsed into a local map and never reaches `process.env`.

`WorkingDirectory` in the plist has to stay on the repo so `.dev.vars` is found.

## Follow-up implementation

The device picker now carries the same folder context Codex stores with each
thread. A custom sidebar section wins; otherwise it shows the matching Codex
project name, then the working-folder name. The bridge reads the local Codex
state index as a fallback because realtime-only chats can have a title but no
ordinary preview event, which makes the normal `thread/list` scan omit them.
The firmware displays that folder label beside each chat name.

The bridge now sends the desktop refresh signal as soon as the thread is created
and again when its human title arrives. The chat is saved by the bridge's
app-server, and the desktop receives the realtime timeline through the local IPC
snapshot path rather than waiting for a manual refresh.

## Open questions

1. **Does the label control sidebar visibility beyond the preview fix?** The
   missing row was reproduced with an empty `preview` and disappeared after the
   bridge filled that catalog metadata; `thread_source` was not needed to make
   the current chat appear. Keep this question open only for future Codex
   versions that change the catalog filter.
2. **Is unsubscribing enough, or should the bridge also stop spawning its own
   app-server?** The lock fix works, and the private IPC handoff covers the
   desktop view. A future move to the desktop's own engine could remove that
   private bridge, but it is a larger change with no current user-visible need.
3. **Which scratch folder.** `~/Documents/Codex/desk-voice` is a single fixed
   folder; the desktop app uses a fresh `<date>/<slug>` directory per chat. Unknown
   whether per-chat folders matter for anything.

## Dead ends — do not spend time here

- **`flushTranscriptTailOnSessionEnd` is not about saving.** It routes leftover
  speech to the text agent as one extra turn. Turning it off loses that turn and
  nothing else.
- **`ThreadHistoryMode` is not the difference.** Bridge and native voice threads
  are both `paginated`; the container writer is gated on that, so forcing `legacy`
  would delete the spoken record rather than reshape it.
- **`ephemeral` is not the difference.** Normal device calls already pass
  `ephemeral: false`.
- **`::codex-realtime-inline{}`** pulls an assistant message *into* the voice
  block, not out of it. Wrong direction.
- **The bars are not a rendering choice the bridge makes.** Codex's own TUI, given
  identical data, draws no container at all.

## How to check things without guessing

```bash
# What kind of thread did the last device call create?
#   git present  -> coding task (boxed).  absent -> plain conversation.
ls -t ~/.codex/sessions/**/rollout-*.jsonl | head -1 | xargs head -1 \
  | python3 -c "import sys,json; p=json.load(sys.stdin)['payload']; \
print('cwd', p.get('cwd')); print('git', bool(p.get('git'))); print('source', p.get('thread_source'))"
```

```bash
# Who is holding a conversation right now?
lsof -nP | grep thread-writer-locks
```

```sql
-- When was each spoken turn written? (~/.codex/thread_history_1.sqlite)
SELECT rollout_ordinal, item_type, created_at_ms
FROM thread_realtime_items WHERE thread_id = '<id>' ORDER BY rollout_ordinal;
```

The bridge log at `/tmp/esp32-voice-mode.log` prints one `Call ended:` line per
hang-up, including whether the microphone was heard. No `Call ended` line means
the call is still open and the lock is being held correctly.

## Unrelated work in the same tree

`src/listener.ts` and `src/__tests__/offer.spec.ts` are an in-progress SDP repair
for silent calls (`repairDeviceOffer`). Nothing above depends on it; do not bundle
the two together in one commit.
## Why a desk chat was missing from Recents (root cause, measured)

The desktop does not list chats from the database on the local host. Its Recents
query asks the engine for `thread/list` with `useStateDbOnly: false`, so the
engine re-reads each chat's rollout log and rebuilds the row from it. A rollout
only yields a row once it holds a **real turn** - the `turn_context` / `task_started`
bookkeeping written when an agent turn runs. A desk call writes realtime items
(`realtime_session_started`, `transcript_segment`, `realtime_session_closed`) and
no turn, so the engine had nothing to build a row from and dropped the chat. The
desktop's own voice chats appear because their speech is promoted into real turns
(`<realtime_delegation>`), which is where the `bem_item_promoted` lines come from.

Evidence, all against the app's own `codex app-server`:

| what was asked | desk chats returned | a chat with one real turn returned |
| --- | --- | --- |
| `thread/list` (what Recents uses) | no | yes |
| `thread/list` + `useStateDbOnly: true` | yes | yes |

The originator (`clientInfo.name`) is *not* the filter: a scratch chat created as
`esp32_voice_mode` with `threadSource: realtime_voice` and one `turn/start` showed
up in the plain list. Injecting response items with `thread/inject_items` was also
not enough - that writes messages, not a turn.

So the bridge hands the call's speech to the agent as ordinary turns
(`#handOffSpokenTurn`): the first thing said goes over as soon as it is finished,
so the chat appears in Recents mid-call the way the phone app's voice chats do,
and whatever was said after that goes over at hang-up. At most two agent turns per
call, each with a written reply nobody hears; a per-request handoff would be the
phone app's exact shape if two replies per call is the wrong trade.

Worth knowing: a call where the voice assistant does real work already produces
its own turns mid-call (the tool calls the realtime model makes land in the thread
as agent turns), so those chats appear in Recents without any hand-off. The
hand-off is what covers a call that was only talk. `codexResponsesAsItems: true`
on `thread/realtime/start` is what puts that work into the thread.

## Unrelated work in the same tree
