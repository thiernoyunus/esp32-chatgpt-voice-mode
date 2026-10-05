/**
 * @file lv_conf.h
 * Configuration for the WatchUi host harness.
 *
 * This is deliberately small: it turns on the 16-bit colour and the handful of
 * widgets WatchUi actually builds with, and leaves every other setting at
 * LVGL's own default. The device uses LVGL 9.5 too (see main/idf_component.yml),
 * so the harness renders with the same version the board ships.
 */
#ifndef LV_CONF_H
#define LV_CONF_H

/* The round watch panel is 360x360 at 16 bits per pixel; keep the harness the
 * same so a screenshot is comparable with the real screen. */
#define LV_COLOR_DEPTH 16

/* On a desktop LVGL leaves the software renderer off by default (it assumes a
 * board will supply one), so it has to be asked for here. */
#define LV_USE_DRAW_SW 1

/* Use the machine's own memory allocator. LVGL's built-in one carves its space
 * out of a small fixed pool (64 KB by default), and a page of dot-matrix text
 * queues a drawing job per dot, which is more than that. A host has a real heap
 * to spare, so there is no reason to ration it here. */
#define LV_USE_STDLIB_MALLOC LV_STDLIB_CLIB
#define LV_USE_STDLIB_STRING LV_STDLIB_CLIB
#define LV_USE_STDLIB_SPRINTF LV_STDLIB_CLIB

/* Widgets WatchUi builds with. */
#define LV_USE_CANVAS 1
#define LV_USE_IMAGE 1
#define LV_USE_LABEL 1
#define LV_USE_SLIDER 1
#define LV_USE_TEXTAREA 1

/* The harness inspects display internals (for example the screen count) to spot
 * screens leaked by repeated navigation, which needs the private headers. */
#define LV_USE_PRIVATE_API 1

/* No vector drawing here; leaving ThorVG on would build a large extra library. */
#define LV_USE_THORVG_INTERNAL 0

/* The default face the pages are rendered with, plus placeholder glyphs so a
 * missing character is visible instead of silently blank. */
#define LV_FONT_MONTSERRAT_14 1
#define LV_USE_FONT_PLACEHOLDER 1

#endif /* LV_CONF_H */
