#pragma once

/* A screen with nothing behind it: no window, no hardware. Whatever LVGL draws
 * lands in a plain memory buffer this harness can inspect or save as an image,
 * which is what makes the watch UI testable on a machine instead of the board. */

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Creates the screen and starts recording into an internal buffer. Call after
 * lv_init(). */
void headless_display_init(uint32_t width, uint32_t height);

/* Frees the screen and the buffer. */
void headless_display_deinit(void);

/* The recorded pixels: 16 bits per pixel, red/green/blue packed as RGB565,
 * top-left first, `width * height * 2` bytes in total. */
uint8_t* headless_display_get_framebuffer(void);

uint32_t headless_display_get_width(void);
uint32_t headless_display_get_height(void);

#ifdef __cplusplus
}
#endif
