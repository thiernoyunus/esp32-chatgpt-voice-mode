# Touch

Each watch has a touch screen and a physical button. Its board-specific touch
task under `main/boards/waveshare/` feeds samples to the shared display code,
which checks the controls on the current page. The 1.85C has a round 360×360
screen. The 2.06 AMOLED is 410×502, and every page of its interface - the
call screen included - is laid out for that whole panel.

## Touch behavior

| Surface | Effect |
|---------|--------|
| Home | Tap a tile to open Voice, Settings, or Clock |
| Settings | Tap a button or row to navigate or change the selected value |
| Keyboard | Tap keys to edit; Cancel returns without saving; Next/Join submits the field |
| Voice | Tap the orb to open a call, or tap the on-screen mute/end controls during a call |
| Confirmation | Tap Sí or No; taps outside the two buttons do nothing |
| Anywhere else | Swipe sideways to go home, the same trip the call screen's arrow makes |

A sideways swipe is 50px of travel with more of it across than down
(`voice_geometry::IsHomeSwipe`, covered by static asserts in that header).
Vertical is left to the lists, which scroll that way. On the call screen the
swipe ends the call first, because the hang-up button only exists there. The
keyboard is left out: a drag across the key caps is a slip, not a request to
throw away half-typed text.

## Design notes

- Any sign of the user — touch, wake word, a turn starting — calls `Application::NoteUserActivity()`, which wakes the screen and restarts the inactivity countdown. After 60 s idle the backlight goes dark and the display enters power-save mode (that is the part that costs CPU).
- A `confirm_request` replaces the face with a full-screen prompt: the summary plus Sí/No touch buttons (`main/display/confirm_geometry.h` holds the layout, shared with the hit-test so they cannot drift). While it is up, the touch task routes releases only to those two zones; taps outside them do nothing. Voice stays available through the boot button and the wake word.
- If the touch controller remains unresponsive after the retry, the task asks the main application to close any active voice call before it stops. This keeps a failed input device from leaving a call running without its screen controls.
- The screen dismisses on: a button press, local expiry (from `expiresAt`, clamped; falls back to 30 s if the clock is unsynced), a server `confirm_close`, any `ui_state` whose state is not `confirm`, or the channel closing.

## Navigation

Prev: [Face](face.md) · Next: [Sounds](sounds.md)
