#include "display_driver.h"

#include <lvgl.h>
#include <stdlib.h>
#include <string.h>

/* Bytes per recorded pixel: 16-bit RGB565, the panel's real format. */
#define HEADLESS_BYTES_PER_PIXEL 2u

/* LVGL draws in chunks rather than the whole screen at once, so a slice this
 * many rows tall is enough to keep it busy. */
#define HEADLESS_CHUNK_ROWS 40u

static lv_display_t* s_display;
static uint8_t* s_framebuffer;
static uint32_t s_width;
static uint32_t s_height;
static lv_color_t* s_draw_buf;

/* LVGL hands the harness one freshly drawn slice at a time; this copies it into
 * the recorded screen at the slice's real position. */
static void headless_flush(lv_display_t* disp, const lv_area_t* area, uint8_t* px_map) {
    lv_draw_buf_t* draw_buf = lv_display_get_buf_active(disp);
    const uint32_t stride = draw_buf->header.stride;
    const int32_t slice_width = area->x2 - area->x1 + 1;

    for (int32_t y = area->y1; y <= area->y2; y++) {
        const uint8_t* src = px_map + (size_t)(y - area->y1) * stride;
        uint8_t* dst = s_framebuffer +
                       ((size_t)y * s_width + (size_t)area->x1) * HEADLESS_BYTES_PER_PIXEL;
        memcpy(dst, src, (size_t)slice_width * HEADLESS_BYTES_PER_PIXEL);
    }
    lv_display_flush_ready(disp);
}

void headless_display_init(uint32_t width, uint32_t height) {
    s_width = width;
    s_height = height;
    s_framebuffer = calloc((size_t)width * height, HEADLESS_BYTES_PER_PIXEL);
    if (s_framebuffer == NULL) {
        return;
    }

    s_display = lv_display_create((int32_t)width, (int32_t)height);
    lv_display_set_color_format(s_display, LV_COLOR_FORMAT_RGB565);

    const uint32_t chunk_pixels = width * HEADLESS_CHUNK_ROWS;
    s_draw_buf = malloc((size_t)chunk_pixels * sizeof(lv_color_t));
    if (s_draw_buf == NULL) {
        return;
    }
    lv_display_set_buffers(s_display, s_draw_buf, NULL, chunk_pixels * sizeof(lv_color_t),
                           LV_DISPLAY_RENDER_MODE_PARTIAL);
    lv_display_set_flush_cb(s_display, headless_flush);
}

void headless_display_deinit(void) {
    free(s_draw_buf);
    s_draw_buf = NULL;
    free(s_framebuffer);
    s_framebuffer = NULL;
    lv_deinit();
}

uint8_t* headless_display_get_framebuffer(void) {
    return s_framebuffer;
}

uint32_t headless_display_get_width(void) {
    return s_width;
}

uint32_t headless_display_get_height(void) {
    return s_height;
}
