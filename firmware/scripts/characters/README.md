# Watch characters

The call screen shows Felipe, a character from the Codex app, instead of the
blob. His finished pictures are in `firmware/main/assets/characters/felipe.pack`
(Felipe is OpenAI's artwork, from the Codex app). These steps remake them, for
example for another character. Without a pack the watch shows the blob.

1. Copy the character engine out of your Codex app into `runtime-src/` and link
   `runtime -> runtime-src/runtime` (it lives in
   `ChatGPT.app/Contents/Resources/app.asar`, under
   `webview/assets/orbit-character-*/`).
2. `python3 serve.py`, open `http://127.0.0.1:8768/?size=330`, and record each
   movement at 15 pictures a second into `frames/<movement>-NNN.png`
   (the page saves frames you `PUT` to `/frames/`).
3. `python3 export_watch.py` (needs Pillow). It crops each movement, encodes JPEG
   quality 70 and writes `watch/felipe.pack` and `watch/felipe_frames.h`.
4. Copy `felipe.pack` to `firmware/main/assets/characters/` and `felipe_frames.h`
   to `firmware/main/display/`, then build and flash. The pack goes to the
   `characters` partition in the top 16 MB of the 32 MB chip.

The loop points in `export_watch.py` were picked by comparing frames for a
clean repeat; re-check them if you re-record.
