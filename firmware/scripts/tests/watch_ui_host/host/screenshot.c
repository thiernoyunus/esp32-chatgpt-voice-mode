#include "screenshot.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* A PNG is a few labelled blocks of bytes. Rather than pull in an image
 * library, this writes the three blocks a plain picture needs (header, pixels,
 * end) and stores the pixels uncompressed. That is a slightly bigger file than
 * a normal PNG and exactly as readable by any viewer. */

static unsigned long png_crc32(const uint8_t* data, size_t length) {
    static unsigned long table[256];
    static int ready = 0;
    if (!ready) {
        for (unsigned long i = 0; i < 256; i++) {
            unsigned long c = i;
            for (int k = 0; k < 8; k++) {
                c = (c & 1) ? (0xEDB88320UL ^ (c >> 1)) : (c >> 1);
            }
            table[i] = c;
        }
        ready = 1;
    }
    unsigned long crc = 0xFFFFFFFFUL;
    for (size_t i = 0; i < length; i++) {
        crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >> 8);
    }
    return crc ^ 0xFFFFFFFFUL;
}

static unsigned long png_adler32(const uint8_t* data, size_t length) {
    unsigned long a = 1, b = 0;
    for (size_t i = 0; i < length; i++) {
        a = (a + data[i]) % 65521UL;
        b = (b + a) % 65521UL;
    }
    return (b << 16) | a;
}

static void put_be32(uint8_t* out, unsigned long value) {
    out[0] = (uint8_t)(value >> 24);
    out[1] = (uint8_t)(value >> 16);
    out[2] = (uint8_t)(value >> 8);
    out[3] = (uint8_t)value;
}

static void write_chunk(FILE* file, const char* type, const uint8_t* data, size_t length) {
    uint8_t header[8];
    put_be32(header, (unsigned long)length);
    memcpy(header + 4, type, 4);
    fwrite(header, 1, sizeof(header), file);
    if (length > 0) {
        fwrite(data, 1, length, file);
    }

    /* The checksum covers the block's label plus its contents. */
    uint8_t* buffer = malloc(length + 4);
    if (buffer == NULL) {
        return;
    }
    memcpy(buffer, type, 4);
    if (length > 0) {
        memcpy(buffer + 4, data, length);
    }
    const unsigned long crc = png_crc32(buffer, length + 4);
    free(buffer);
    uint8_t crc_bytes[4];
    put_be32(crc_bytes, crc);
    fwrite(crc_bytes, 1, sizeof(crc_bytes), file);
}

/* One pixel of RGB565, expanded to the three separate colour bytes a PNG
 * stores. A 5-bit channel is stretched to 8 bits so white stays white. */
static void expand_rgb565(uint16_t pixel, uint8_t out[3]) {
    const uint8_t r5 = (uint8_t)((pixel >> 11) & 0x1F);
    const uint8_t g6 = (uint8_t)((pixel >> 5) & 0x3F);
    const uint8_t b5 = (uint8_t)(pixel & 0x1F);
    out[0] = (uint8_t)((r5 << 3) | (r5 >> 2));
    out[1] = (uint8_t)((g6 << 2) | (g6 >> 4));
    out[2] = (uint8_t)((b5 << 3) | (b5 >> 2));
}

int screenshot_save_png(const char* path, const uint8_t* framebuffer, uint32_t width,
                        uint32_t height) {
    if (path == NULL || framebuffer == NULL || width == 0 || height == 0) {
        return 0;
    }

    /* Every row starts with a marker byte saying "store these pixels as they
     * are"; the rest of the row is red, green, blue per pixel. */
    const size_t row_bytes = (size_t)width * 3 + 1;
    const size_t raw_size = row_bytes * height;
    uint8_t* raw = malloc(raw_size);
    if (raw == NULL) {
        return 0;
    }
    for (uint32_t y = 0; y < height; y++) {
        uint8_t* row = raw + row_bytes * y;
        row[0] = 0;
        for (uint32_t x = 0; x < width; x++) {
            const size_t at = ((size_t)y * width + x) * 2;
            const uint16_t pixel = (uint16_t)(framebuffer[at] | (framebuffer[at + 1] << 8));
            expand_rgb565(pixel, row + 1 + (size_t)x * 3);
        }
    }

    FILE* file = fopen(path, "wb");
    if (file == NULL) {
        free(raw);
        return 0;
    }

    static const uint8_t signature[8] = {137, 80, 78, 71, 13, 10, 26, 10};
    fwrite(signature, 1, sizeof(signature), file);

    uint8_t ihdr[13];
    put_be32(ihdr, width);
    put_be32(ihdr + 4, height);
    ihdr[8] = 8;   /* 8 bits per colour channel */
    ihdr[9] = 2;   /* truecolour: red/green/blue, no transparency */
    ihdr[10] = 0;  /* default compression */
    ihdr[11] = 0;  /* default row filter */
    ihdr[12] = 0;  /* not interlaced */
    write_chunk(file, "IHDR", ihdr, sizeof(ihdr));

    /* The pixel block is a ZIP stream. Building it by hand with "store" blocks
     * means no ZIP library is needed; the two-byte header and trailing checksum
     * are the whole of the packaging. */
    const size_t stored_max = 65535;
    const size_t blocks = (raw_size + stored_max - 1) / stored_max;
    const size_t zlib_size = 2 + blocks * 5 + raw_size + 4;
    uint8_t* zlib = malloc(zlib_size);
    if (zlib == NULL) {
        fclose(file);
        free(raw);
        return 0;
    }
    size_t z = 0;
    zlib[z++] = 0x78; /* ZIP stream header */
    zlib[z++] = 0x01;
    size_t offset = 0;
    while (offset < raw_size) {
        const size_t length = (raw_size - offset) < stored_max ? (raw_size - offset) : stored_max;
        const int last = (offset + length) >= raw_size;
        zlib[z++] = (uint8_t)(last ? 1 : 0);
        zlib[z++] = (uint8_t)(length & 0xFF);
        zlib[z++] = (uint8_t)((length >> 8) & 0xFF);
        zlib[z++] = (uint8_t)(~length & 0xFF);
        zlib[z++] = (uint8_t)((~length >> 8) & 0xFF);
        memcpy(zlib + z, raw + offset, length);
        z += length;
        offset += length;
    }
    put_be32(zlib + z, png_adler32(raw, raw_size));
    z += 4;
    write_chunk(file, "IDAT", zlib, z);
    write_chunk(file, "IEND", NULL, 0);

    free(zlib);
    free(raw);
    const int ok = fclose(file) == 0;
    return ok;
}
