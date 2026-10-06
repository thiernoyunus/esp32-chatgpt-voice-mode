#pragma once

namespace voice_geometry {
constexpr int kButtonSize = 52;
constexpr int kButtonTop = 246;
constexpr int kMuteLeft = 62;
constexpr int kEndLeft = 246;
constexpr int kOrbSize = 166;
constexpr int kModelLeft = 100, kModelTop = 24, kModelWidth = 160, kModelHeight = 32;
constexpr int kModelRowLeft = 70, kModelRowTop = 100, kModelRowWidth = 220;
constexpr int kModelRowHeight = 44, kModelRowStep = 54, kModelsPerPage = 3;
constexpr bool ContainsModelPicker(int x, int y) {
    return x >= kModelLeft && x < kModelLeft + kModelWidth && y >= kModelTop &&
           y < kModelTop + kModelHeight;
}
constexpr int ModelRowAt(int x, int y) {
    if (x < kModelRowLeft || x >= kModelRowLeft + kModelRowWidth || y < kModelRowTop)
        return -1;
    const int row = (y - kModelRowTop) / kModelRowStep;
    return row < kModelsPerPage && (y - kModelRowTop) % kModelRowStep < kModelRowHeight ? row : -1;
}

constexpr bool ContainsButton(int left, int x, int y) {
    const int dx = x - left - kButtonSize / 2;
    const int dy = y - kButtonTop - kButtonSize / 2;
    return dx * dx + dy * dy <= kButtonSize * kButtonSize / 4;
}
static_assert(ContainsButton(kMuteLeft, 88, 272));
static_assert(ContainsButton(kEndLeft, 272, 272));
static_assert(!ContainsButton(kMuteLeft, 180, 300));
static_assert(!ContainsButton(kEndLeft, 180, 300));
static_assert((kMuteLeft - 180) * (kMuteLeft - 180) +
                  (kButtonTop + kButtonSize - 180) * (kButtonTop + kButtonSize - 180) <
              180 * 180);
static_assert((kEndLeft + kButtonSize - 180) * (kEndLeft + kButtonSize - 180) +
                  (kButtonTop + kButtonSize - 180) * (kButtonTop + kButtonSize - 180) <
              180 * 180);

// The 2.06 AMOLED is a 410x502 rectangle, not a 360x360 square. The call
// screen used to be drawn as the square in the middle of it, which left a
// hand's width of black above and below the character. These are that
// panel's own numbers; the constants above stay the round watch's.
namespace amoled_voice {
constexpr int kPanelWidth = 410, kPanelHeight = 502;
// Twice the round watch's character. The canvas holds the character plus the
// rings that orbit it, and it is repainted 30 times a second, so this is the
// knob to turn if the redraw ever costs too much - the layout below still
// holds at 200.
constexpr int kOrbSize = 236;
// Dead centre of the panel, so the character is not floating in the top half.
constexpr int kOrbTop = (kPanelHeight - kOrbSize) / 2;
constexpr int kNavSize = 48, kNavTop = 36, kNavSide = 24;
// Below the character, above the transcript strip along the very bottom.
constexpr int kButtonSize = 56, kButtonTop = 376, kButtonSide = 52;
}  // namespace amoled_voice

// A sideways flick takes you home, the way swiping up takes you home on a
// phone. Vertical is left alone: that is how the lists scroll. 50px is a
// finger's worth of travel, so a tap and its small wobble never count.
constexpr int kHomeSwipePixels = 50;
constexpr bool IsHomeSwipe(int dx, int dy) {
    const int across = dx < 0 ? -dx : dx, down = dy < 0 ? -dy : dy;
    return across >= kHomeSwipePixels && across > down;
}
static_assert(IsHomeSwipe(60, 4));
static_assert(IsHomeSwipe(-60, -4));
static_assert(!IsHomeSwipe(60, 90));  // more down than across: that is a scroll
static_assert(!IsHomeSwipe(20, 2));   // a tap with a shaky finger
}  // namespace voice_geometry
