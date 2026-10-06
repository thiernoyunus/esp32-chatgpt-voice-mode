/* Checks that a spoken name finds the palette entry it names. The voice tool
 * is the only caller that has never seen these lists before, so a name that
 * does not round-trip is the whole bug this file exists for.
 *
 *   c++ -std=c++17 -I main/display -o /tmp/voice_character_check \
 *      scripts/tests/voice_character_check.cc
 *   /tmp/voice_character_check
 *
 * Header-only: the lists and the lookup, nothing drawn. */
#include <assert.h>
#include <stdio.h>

#include "voice_character.h"
#include "watch_palette.h"

using namespace voice_character;

static int shape_index(const char* name) {
    return IndexOf(kShapeNames, kShapeCount, name);
}

static int colour_index(const char* name) {
    return IndexOf(kColourNames, kColorCount, name);
}

int main(void) {
    /* 1. Every name the watch shows resolves to its own slot. */
    for (int i = 0; i < kShapeCount; ++i) assert(shape_index(kShapeNames[i]) == i);
    for (int i = 0; i < kColorCount; ++i) assert(colour_index(kColourNames[i]) == i);

    /* 2. Speech is not spelled the way the screen is: case and stray words go. */
    assert(shape_index("triangle") == 4);
    assert(shape_index("TRIANGLE") == 4);
    assert(colour_index("blue") == 8);
    assert(colour_index("  Blue") == -1); /* padded is a different word, not a typo */

    /* 3. A name we do not have is refused rather than mapped to something.
 *      This is the case the tool answers with the list of what it has. */
    assert(shape_index("blob") == -1);
    assert(colour_index("chartreuse") == -1);
    assert(shape_index("droplets") == -1); /* plural is not a shape */
    assert(shape_index("") == -1); /* omitted, not chosen */

    /* 4. The refusal has to be actionable, so the list is the whole palette. */
    const std::string names = Names(kColourNames, kColorCount);
    for (int i = 0; i < kColorCount; ++i) assert(names.find(kColourNames[i]) != std::string::npos);
    assert(Names(kShapeNames, kShapeCount).find("Droplet") != std::string::npos);

    /* 5. The screen's themes resolve the same way, because they arrive by
     *    voice through the same door. */
    for (int i = 0; i < watch_palette::kThemeCount; ++i)
        assert(watch_palette::IndexOf(watch_palette::kThemeNames, watch_palette::kThemeCount,
                                      watch_palette::kThemeNames[i]) == i);
    assert(watch_palette::IndexOf(watch_palette::kThemeNames, watch_palette::kThemeCount, "lime") == 1);
    assert(watch_palette::IndexOf(watch_palette::kThemeNames, watch_palette::kThemeCount, "purple") == -1);
    /* 6. A theme's name and its colours are one row: a name that resolved must
 *    land on the palette that name belongs to, not merely a valid index. */
    assert(watch_palette::Palette(0).accent == 0x00D8E9); /* Cyan */
    assert(watch_palette::Palette(3).accent == 0xFF4FA5); /* Rose */
    assert(std::string(watch_palette::kUiPalettes[1].name) == "Lime");

    printf("voice_character_check: ok\n");
    return 0;
}
