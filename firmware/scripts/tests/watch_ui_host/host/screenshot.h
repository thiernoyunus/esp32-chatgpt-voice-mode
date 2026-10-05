#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Writes the recorded screen to a PNG so it can be looked at afterwards.
 *
 * `framebuffer` is what headless_display_get_framebuffer() returns: 16 bits per
 * pixel in RGB565 order, `width * height * 2` bytes. Returns non-zero on
 * success. The writer is self-contained (no image library needed) so the
 * harness builds on a bare machine as well as in CI. */
int screenshot_save_png(const char* path, const uint8_t* framebuffer, uint32_t width, uint32_t height);

#ifdef __cplusplus
}
#endif
