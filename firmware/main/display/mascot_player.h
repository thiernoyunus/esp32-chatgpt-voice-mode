#pragma once

#include <esp_partition.h>
#include <lvgl.h>

#include <cstdint>

#include "mascot_frames.h"

/* The mascot - a Codex character such as Felipe - played as flipbooks on the
 * call screen.
 *
 * The pictures are made on the Mac from Codex's own animations
 * (scripts/characters/export_watch.py), each one a JPEG, and packed into
 * the "characters" partition in the upper 16 MB of flash. That area cannot be
 * memory-mapped (24-bit flash mapping stops at 16 MB), so each picture is read
 * into a small PSRAM slot and unpacked into another. If the pack is missing,
 * Load() fails and the call screen keeps drawing the blob. */
class MascotPlayer {
public:
    // What the call is doing; the player picks the movement for it.
    enum class Mood { Asleep, Connecting, Idle, Thinking, Working, Error };

    ~MascotPlayer();
    bool Load();
    bool loaded() const { return scratch_ != nullptr; }
    // Draws into a size x size RGB565 canvas. True when the canvas changed.
    bool Draw(lv_color16_t* canvas, int size, Mood mood);
    // Which of mascot::kMascots to show; starts over from the next Draw.
    void SetMascot(int index);

private:
    bool Unpack(mascot::Move move, int picture);
    const mascot::Movement& Info(mascot::Move move) const;

    const esp_partition_t* pack_ = nullptr;
    uint8_t* squeezed_ = nullptr;
    bool tried_ = false;
    int mascot_ = 0;
    uint32_t loop_ms_[static_cast<int>(mascot::Move::Count)] = {};
    uint16_t* scratch_ = nullptr;
    Mood mood_ = Mood::Asleep;
    bool started_ = false;
    mascot::Move move_ = mascot::Move::Paused;
    uint32_t move_started_ = 0;
    mascot::Move shown_move_ = mascot::Move::Count;
    int shown_picture_ = -1;
    // For the memory/speed check in the log: how long unpacking takes.
    uint32_t unpacked_ = 0, unpack_us_total_ = 0, unpack_us_max_ = 0, reported_at_ = 0;
};
