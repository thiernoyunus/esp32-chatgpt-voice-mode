# ESP voice and Codex access

The ESP listener previously started an independent Codex process outside the
Mac app. That process could read ordinary files but did not receive the desktop
app's project and task tools. The phone's native voice chat did receive them.

The installer now registers a small companion that Codex desktop starts itself.
The listener connects to it, and it starts the voice process with the desktop's
app connection, configured tools, account and permissions. The companion passes
the desktop’s signed tool runtime to its children; the wrong runtime caused
native project tools to be rejected in the full voice configuration. Codex desktop must be
open. The companion exposes no model tools and disables itself in voice children
so it cannot start recursively. Its connection folder and sockets are private to
the current Mac user; startup messages are bounded and validated.

```mermaid
flowchart LR
  Watch[ESP watch] --> Companion[Companion started by Codex desktop]
  Companion --> Tools[Your Codex projects and tools]
  Phone[Codex phone] --> Tools
```

## Checked

| Capability | Result |
| --- | --- |
| Desktop app tools | All 53 installed native app tools were discovered through the new connection. |
| Project discovery and task creation | The initial reduced-tool check listed projects and created a local task there. After the user reproduced failure with the full setup, the signed-runtime fix was checked with all configured tools enabled: a saved voice-owned chat called the real `list_projects` and `create_thread`. The created task used `/Users/thiernodiallo/Documents/Instagram page` and completed with `hi` (caller `01a10f9f-8bd4-71d0-a513-ac87d81a4028`, task `01a10f9f-cc80-71a1-b2a0-a196d43834d6`). |
| Configured tools and plugins | Configuration is inherited. Optional per-machine exclusions still apply; discovery alone does not prove every external account is signed in. |
| Reasoning | Watch choice, then ESP environment preference, then Codex configuration, then low. Model selection is independent. Unsupported combinations fail clearly. |
| Plugged-in watch | The AMOLED 2.06 checks cable power, including a full battery. Its idle screen/sleep action keeps it awake while plugged in and wakes an already sleeping screen after cable insertion. Unplugging restores normal idle sleep. Requires updated firmware. |
| Recent chat picker | Fetches fresh non-archived chats when opened, without starting audio. Empty responses clear old rows, and replies from older requests are ignored. Requires updated firmware. |
| Unavailable saved chats | Archived or missing chats open a fresh saved chat, with a notice. Other setup errors remain visible. |
| New and resumed reasoning | The installed Codex returned `high` for both a newly opened chat and a resumed saved voice chat, with its global preference set to `low`. |
| Saved watch preference | Firmware sender check compiles the actual offer function and confirms each level is sent for new and resumed calls; Default sends no override. The watch change is included in this PR. |
| Permissions | Inherited from Codex. The desktop display uses the settings actually returned by Codex instead of claiming every chat has Full Access. |
| Required approvals and questions | Preserved as pending requests, with validated answers routed back from the Codex chat. The device says to answer in Codex. Previously the service declined approvals or supplied empty answers automatically. |
| Account choice | Removed the ESP-only instruction to search every inbox automatically; normal configured instructions and tool requirements apply. |
| Host transport and failures | Runnable checks cover messages, invalid startup data, companion restart, and rejecting publicly accessible sockets. |

## Remaining differences

This change does not establish complete phone/desktop parity:

- Temporary chats are not loaded in the desktop app, and native app tool calls
  from them can fail with missing caller context. Saved voice chats are verified.
  The service must report failures honestly, not infer that a project is absent.
- The watch does not yet display individual approval/question controls. Answer
  those in the saved voice chat on phone/desktop. A future watch control should
  show the action and send a reply tied to its exact request, without changing
  account-wide permissions.
- The desktop follower connection supports history and pending question replies;
  arbitrary desktop editing, steering, and settings changes during an active
  device call are not implemented by this bridge.
- Available tools are shared, but a watch cannot render desktop panels, browser
  tabs, uploaded files, or every rich output. Tool availability is not proof that
  each visual workflow can be completed on the watch.
- Physical microphone, speaker, and touch behavior with this change still need a
  fresh device call. Host checks do not prove audible playback or a firmware flash.

## Validation

Server: `bun run check` (217 passing). AMOLED 2.06 firmware build, including the latest picker changes, completed in the active unified checkout and produced `build/xiaozhi.bin`; the generated profile enables Codex Voice and the default display style. The device has not been flashed. Firmware sender:
`python3 firmware/scripts/tests/test_voice_reasoning.py` after firmware dependencies are
available. `test_voice_messages.py` also checks picker refresh, stale replies and empty-list clearing. Both checks reuse the existing cJSON and host toolchain helpers.

Plugged-in sleep check: `python3 firmware/scripts/tests/test_plugged_sleep.py` compiles the actual cable detector and screen-sleep function and checks cable insertion, full-battery power, repeated idle attempts and unplugging.
