# Face

The round panel is an **LVGL** display driven by `main/display/lcd_display.*`. Idle chrome is `WatchUi` (home plus settings). During a call, `LcdDisplay::RenderVoiceOrb` draws the **bloub** character from `main/display/bloub/` into a canvas — shape and colour come from watch settings, with connecting orbit rings and a working-state cycle while the agent is busy.

There is no emote engine and no `emote_display` in this tree. The earlier emotion mapping went away with the dialect that used it.

## Call chrome

Around the orb the UI shows mute / end controls, the current model label, streaming captions, tool captions from `realtime_status`, and the confirm overlay when one is active.

The character and that chrome are laid out per panel in `voice_geometry.h`: 166px on the round watch inside a 360×360 screen, 236px dead centre of the 410×502 AMOLED. The AMOLED used to draw the round watch's 360×360 layout in the middle of the panel and leave the rest black; its own numbers now live beside the round ones instead of being worked out from them at every call site.

The call screen keeps its black background and its grey controls on both panels. The theme reaches it through the settings the three dots open, not through the controls themselves: colouring the arrow and the dots on their own would leave the top of the screen a different colour from the mute and hang-up below it.

## Navigation

Prev: [Audio](audio.md) · Next: [Touch](touch.md)
