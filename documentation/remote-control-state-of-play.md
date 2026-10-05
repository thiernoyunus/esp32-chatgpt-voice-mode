# Remote control for the voice bridge: state of play

## 20 September follow-up: sidebar investigation

**Immediate appearance, stable ordering, and saved-message display are confirmed in user checks.** After disk space
was freed, a temporary "Sidebar diagnostic" chat became visible without searching
or restarting the app, as confirmed by the user. That confirms eventual visibility,
not which notification caused it or how quickly it appeared. The bridge now sends
the candidate single-chat notification when a saved call is created, named, or
resumed. The updated service is running; type checking and all 37 tests pass,
including a socket test that checks the message and excludes untargeted refreshes.
The first device call after restarting the service was
`01a0c0ee-cac1-77b2-bd1f-1568419d9ae1`: the chat was ready in 632 ms and the answer
was sent in 3,876 ms. Targeted refreshes were sent before the answer. Device logs
recorded "Sidebar test Sidebar test", incoming audio, conversion to speaker
samples, and nonzero speaker output. The user confirmed immediate sidebar
appearance, but opening showed a blank chat and moved it down as an older chat.
The catalog row was absent in the
first read after the call started; this does not establish the live sidebar state.
Evidence excerpts are saved under `/tmp/desk-sidebar-investigation/` as
`device-call-01a0c0ee-bridge.log` and `device-call-01a0c0ee-serial.log`.

The live history request completed in 23 ms and returned eight realtime entries,
including the user's speech. It also exposed a concrete date bug: the bridge sent
seconds (`1789943270`) where desktop snapshots require milliseconds. The installed
app's `sh` converts engine dates to milliseconds; `OFt` accepts snapshot numbers
unchanged. Opening therefore replaced the correct recent-list date with a date
in January 1970. `desktopConversationDates` now converts all three dates and has
a regression check. The user confirmed a new call stayed near the top when opened,
but the message area remained blank (also shown in their screenshot).

The next change projects saved voice transcripts into ordinary desktop chat turns.
Previously the snapshot had `turns: []` and only populated `itemTimeline`. The
installed desktop reads that voice timeline behind a feature gate; its fallback
reads a separate `thread_timeline_ledger`, which has zero records for the external
"Date check" call. The new projection preserves speaker order and text and starts
no agent work. It clears the parallel voice timeline in the snapshot to avoid
displaying each message twice. This is a speech-only view, not a complete adapter
for tool results or desktop editing of a live device call. A saved-call probe was
used for visible confirmation without making the user start another call. The
user confirmed that messages now appear after reopening "Desk call · Date check".
The production bridge uses the same projection for calls it owns. This does not
prove reopening old calls after a bridge or app restart, or desktop resume/archive.

The four calls near 18:34 were not four successful tests. Device logs show three
automatic retries: "No reply audio" after 4,019, 4,017, and 4,018 ms, with the audio
track missing even though captions arrived. The bridge's current reuse decision
treats captions as evidence that a call came up, so those retries created fresh
chats. No firmware or retry fix has been made during this investigation. The
watchdog, close/playback, and readiness checks pass using the Xcode 26.5 SDK;
the default SDK selection initially failed at linking. Intermittent missing audio
and retry-created chats remain unresolved. The canonical firmware build completed
successfully under ESP-IDF 6.0.2 with the Codex Voice and default-message-style
configuration. No new firmware was flashed; the existing serial reader was left
alone. Build output is in `/tmp/desk-sidebar-investigation/firmware-build.log`.
The older claims below
that an external engine *cannot* surface chats, or that moving engines necessarily
fixes the box, are stronger than the evidence supports.

Findings from the installed `/Applications/ChatGPT.app/Contents/Resources/app.asar`:

| Route | Finding |
| --- | --- |
| Refresh the catalog externally | `localThreadCatalog.invalidateSource`, `requestSync`, and `notifyThread` exist on the app's internal window service. No corresponding public socket request was found. Generic query invalidation does not call them. |
| Target a single chat over the existing socket | The version-1 `thread-unarchived` broadcast with `{hostId: 'local', conversationId}` calls `handleThreadUnarchived`, which reads the chat and adds it to the live recent list even in catalog mode. This does not require archiving/restoring the underlying chat. The user confirmed immediate appearance on a fresh device call. Opening then exposed a separate snapshot date bug and a blank view; complete acceptance is still pending. |
| Create the chat through the desktop's engine | Still the clearest normal path. The public `remote-control start/stop/pair` commands manage a host daemon; they do not enroll the bridge as a controller or provide a direct connection to the existing desktop engine. |
| Switch catalog mode off | The service is supplied when the Electron SQLite store exists. The renderer chooses catalog mode from service presence. No user setting or feature flag for this choice was found. Disabling the database would affect more than the sidebar. |
| Insert catalog rows and bump its revision | Insufficient on its own: the coordinator keeps status in memory and publishes change notifications through its listeners. Updating SQLite does not execute that publication path. No database-file watcher for this path was found. No catalog writes were attempted. |

### Remote-control authentication

The current bearer was successfully refreshed using the existing `--refresh-only`
script. Its issue age became one second, but password verification remained
597,169 seconds old (about seven days), with authentication methods
`google`, `otp`, `mfa`, and `sms`. A refresh therefore did not establish a new
remote-control approval. No full enrollment retry was performed: no fresh
`codex.remote_control.enroll` approval token was available.

There is a concrete request difference to fix before the next enrollment test:
the desktop's `bootstrap-DF0QwAxC.js` functions `cT` and `lT` send
`Authorization`, **`ChatGPT-Account-Id`**, `originator`, and the desktop
`User-Agent`. The pairing script currently omits the account header and uses
the runtime's default user agent. Whether this explains the earlier 401 remains
unverified; it is not evidence that the account cannot enroll.

### Evidence and limits

- `main-DUHZj4_w.js`: `X$e` exposes the catalog methods; `M5` supplies the source
  from the desktop engine, using `thread/list` with `useStateDbOnly: true`.
  `Rtt` handles observations; `Gtt` publishes status. Ordinary catalog
  notifications debounce for 250 ms, bounded at 1,000 ms before scheduling;
  that is not an end-to-end visibility guarantee.
- `app-initial-a498f911edeb.js`: `IGc` chooses catalog/live mode; `NZa` uses
  `wZa` to read the manager's recent conversations in catalog mode.
- `src-C3YaUE83.js`: `hse` forwards versioned broadcasts;
  `thread-unarchived` has version 1. `UF` creates the SQLite store in Electron.
- One empty test chat, `01a0befd-4d4e-7cd3-8b40-9b1b74de644e`, was created without
  an agent turn and then archived after testing. Existing chats were not
  archived or deleted. The active desk chat used by the first probe was
  checked to be unarchived before sending the notification.
- Computer Use explicitly refused access to `com.openai.codex`; no screenshot
  was taken. The user later confirmed the diagnostic chat was visible.
- The Mac intermittently returned `no space left on device`, with roughly
  112–183 MiB free in spot checks. Further write-heavy tests are unreliable
  until space is available. On resuming, about 19 GiB was free and checks passed.
  This does not establish the cause of earlier delays.
- `bun run check`: 37 passed, including type checking. `git diff --check` passed.
  Slow opening and the residual rail/box remain unresolved. The renderer's
  `Worked for` text denotes completed agent activity; it does not by itself
  prove a project-folder classification problem.

The smallest reliable product change would be a desktop socket handler that
accepts a saved thread ID and invokes its existing `notifyThread` path. That
requires a desktop change, not just another bridge refresh broadcast. Before
considering a local application patch or a controller rewrite, retest the
single-chat broadcast with visible confirmation and correct the account header
for a fresh, explicitly approved enrollment attempt.

19 September 2026, written after a long session. Companion to
`voice-chats-should-look-normal.md`.

## Why we want it

Chats must be created by the desktop app's **own** engine to appear in Recents
immediately, render as a conversation rather than a boxed task, and be
archivable. The bridge's separate `codex app-server` cannot do that.

The route pursued: the bridge enrols as a remote-control **client** (controller),
pairs with the short code from *Settings → Connections → Control this Mac → Add*,
then creates and drives chats over the remote-control WebSocket.

## Proven, with evidence

- **The code is a claim ticket, not a credential.**
  `POST /wham/remote/control/client/pair` with a valid code and the account's own
  bearer, but an unrecognised `client_id`, returns
  `HTTP 404 {"detail":"Remote-control client not found"}`. A client must exist
  before a code means anything.
- **The host half is open source; the controller half is not.**
  `openai/codex` ships `codex-rs/cli/src/remote_control_cmd.rs` and
  `app-server-transport/src/transport/remote_control/*`, and the installed CLI
  exposes `codex remote-control start|stop|pair`. Every client-side call
  (`client/enroll/*`, device keys) is absent — it lives in the ChatGPT apps.
- **The canonical signed payload** for enrolment is
  `JSON.stringify({ domain, payload })` with the payload's keys in alphabetical
  order and `domain = "codex-device-key-sign-payload/v1"`
  (voice-relay `encodeDeviceKeySignedPayload`). Our helper now matches byte for
  byte; before that the signature could never verify, and the server reported it
  as a reauthentication failure.
- **Stale-token handling**: these endpoints answer a stale token with 401, and
  the reference client refreshes once and retries. Implemented (`api()`).

## The blocker

`POST /codex/remote/control/client/enroll/finish` →

```
HTTP 401 {"detail":{"message":"Recent MFA login and remote-control authorization required",
                     "code":"remote_control_reauth_required"}}
```

...sent with an approval token that is fresh (`iat` 1 s, `pwd_auth_time` ~3 s),
scoped exactly `codex.remote_control.enroll`, carrying `pwd` + `mfa`, matching
the account, with a valid device-key proof.

## Two candidate causes

1. **The bearer never carries a password factor.** This account is federated to
   Google: the account token's `amr` is `[urn:openai:amr:google, otp, mfa, sms]`
   and `pwd_auth_time` is days old. A refresh does **not** reset it (measured).
   The approval path *does* produce `pwd`, with a fresh time.
2. **A request difference not yet replicated.** Next to check: the desktop app's
   exact headers for this call — `sE(...)` / `auth.gt(...)` and the obfuscated
   header constants used by `wEe.fetchAuthenticatedJson`.

## Next steps, in order

1. Resolve the app's headers for `enroll/finish` and add any we are missing.
   Read-only work; costs one approval to test.
2. Replay the enrolment with a token minted by the **device-code flow approved
   on the phone** (`codex login --device-auth`, already seen to work). This
   discriminates cause 1 without touching firmware.
3. If both fail: stop pursuing controller status. The protocol is gated by an
   unpublished app-side flow, and the remaining visible problems should be
   attacked directly instead.

## Measured dead ends — do not repeat

- Refreshing the account token does not give it a fresh `pwd_auth_time`.
- Sending the approval token as the bearer: 401.
- The Phone/QR option is not a different door; it is the same code as a URL
  (`https://chatgpt.com/codex/pair?pairing_code=…`).
- `codex login` in any form logs in through Google for this account, silently.
- The boxed rendering is **not** the git block: the newest bridge chat and native
  desktop voice chats alike report `git: false`, and they carry the same turn
  shape (5 messages + 1 reasoning).

## Operational hazards, learned the hard way

- **Ports 1455 and 1457 are Codex's own sign-in callbacks.** A listener squatting
  on 1455 will swallow a real Codex login — it happened, and it cost a reboot.
  Prefer 1457, hold it briefly (minutes, not half an hour), and never leave it
  listening while signing into Codex.
- **`codex login` deletes `~/.codex/auth.json` while it waits**, signing the user
  out mid-flow. Back it up first:
  `cp -p ~/.codex/auth.json ~/.codex/auth.json.bak-$(date +%s)`.
  `scripts/login-forced.ts` avoids this by writing only after a successful
  exchange.

## State at the end of the session

- Service `local.esp32-voice-mode` running; calls and chats work.
- In `src/codex.ts`: re-dialled offers reuse one chat, the sidebar refresh
  targets `recent-conversations`, the snapshot sends a complete
  `latestCollaborationMode`, and follower requests are answered.
- Scripts added: `scripts/pair-remote-control.ts`,
  `scripts/remote-control-device-key.swift`, `scripts/login-forced.ts`.
- No enrolment is half-finished and the account has no stray clients.
