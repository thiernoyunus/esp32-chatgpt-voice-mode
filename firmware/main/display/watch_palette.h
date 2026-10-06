#pragma once

/* The four themes the watch screen can wear.
 *
 * This table used to be a private list at the top of watch_ui.cc, which is
 * where it belongs right up until something other than the drawing code needs
 * to know the names - a voice tool answering "make it lime" being that
 * something. Same reason the character's colours have a header.
 *
 * Not to be confused with the LVGL light/dark Theme object. That one decides
 * how stock widgets are painted; this one is the accent, background and card
 * colours of every screen the watch draws itself, which is what the Themes
 * picker and everything on screen actually shows. */

#include <algorithm>
#include <cstddef>
#include <cstdint>

#include "name_lookup.h"

namespace watch_palette {

struct UiPalette {
    const char* name;
    uint32_t accent, background, card, selected, border;
};

inline constexpr UiPalette kUiPalettes[] = {
    {"Cyan",  0x00D8E9, 0x070C11, 0x0C151C, 0x102832, 0x1D3943},
    {"Lime",  0xB8F500, 0x080D07, 0x111A0D, 0x202C0D, 0x344616},
    {"Gold",  0xFFD629, 0x100B07, 0x1B160E, 0x312510, 0x493716},
    {"Rose",  0xFF4FA5, 0x11080E, 0x1B1019, 0x321526, 0x4C2440},
};

inline constexpr int kThemeCount = static_cast<int>(sizeof(kUiPalettes) / sizeof(kUiPalettes[0]));

inline constexpr const char* kThemeNames[] = {"Cyan", "Lime", "Gold", "Rose"};
static_assert(sizeof(kThemeNames) / sizeof(kThemeNames[0]) == static_cast<size_t>(kThemeCount),
              "a theme has no name, or a name has no theme");

inline const UiPalette& Palette(int theme) {
    return kUiPalettes[std::clamp(theme, 0, kThemeCount - 1)];
}

using name_lookup::IndexOf;
using name_lookup::NameOf;
using name_lookup::Names;

}  // namespace watch_palette
