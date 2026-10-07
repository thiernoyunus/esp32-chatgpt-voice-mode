# Watch mascots

The call screen shows a mascot - a character from the Codex app (Felipe,
Alfred, Iggy, Todd) - instead of the blob, picked under Settings → ChatGPT →
Mascot. Their finished pictures are in
`firmware/main/assets/characters/mascots.pack` (the characters are OpenAI's
artwork, from the Codex app). These steps remake the pack, for example to add
a mascot.

1. Copy the character engine out of your Codex app into `runtime-src/` and link
   `runtime -> runtime-src/runtime` (it lives in
   `ChatGPT.app/Contents/Resources/app.asar`, under
   `webview/assets/orbit-character-*/`).
2. `python3 serve.py`, open `http://127.0.0.1:8768/?size=330&character=<Name>`
   (the Codex preset title, plus any `RECORD_OPTIONS` from `export_watch.py`,
   e.g. `&eyes=dots` for Alfred), and record each movement at 15 pictures a second
   into `frames/<name>/<movement>-NNN.png` (the page saves frames you `PUT` to
   `/frames/<name>/`). Keep the browser window visible while recording.
3. Add the name to `MASCOTS` in `export_watch.py` and run it (needs Pillow). It
   warns when a loop would visibly jump; find that mascot's own repeat points
   and put them in `OWN_LOOPS`.
4. Copy `watch/mascots.pack` to `firmware/main/assets/characters/` and
   `watch/mascot_frames.h` to `firmware/main/display/`, then build and flash.
   The pack goes to the `characters` partition in the top 16 MB of the chip.

## Bringing back the blob

Without `mascots.pack` (delete it, or erase the start of the `characters`
partition) the watch draws the blob again, and Settings → ChatGPT shows the
blob's Shape and Colour pickers instead of Mascot. No code change is needed.
