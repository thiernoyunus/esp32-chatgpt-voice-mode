#include "felipe_player.h"

#include <esp_heap_caps.h>
#include <esp_log.h>
#include <esp_timer.h>
#include <esp_jpeg_dec.h>

#include <algorithm>
#include <cstring>

#define TAG "Felipe"

namespace {

using felipe::Move;

constexpr size_t kPictureBytes = static_cast<size_t>(felipe::kLargestArea) * 2;
constexpr uint32_t kReportEveryMs = 10000;

struct Family { Move intro; Move loop; };

// The movement for each mood: an optional once-through start, then the loop.
Family FamilyFor(FelipePlayer::Mood mood) {
    switch (mood) {
        case FelipePlayer::Mood::Connecting: return {Move::CreatingIntro, Move::Creating};
        case FelipePlayer::Mood::Thinking: return {Move::ThinkingIntro, Move::Thinking};
        case FelipePlayer::Mood::Working: return {Move::WorkingIntro, Move::Working};
        case FelipePlayer::Mood::Error: return {Move::ErrorIntro, Move::Error};
        case FelipePlayer::Mood::Idle: return {Move::Idle, Move::Idle};
        case FelipePlayer::Mood::Asleep: break;
    }
    return {Move::PausedIntro, Move::Paused};
}

const felipe::Movement& Info(Move move) { return felipe::kMovements[static_cast<int>(move)]; }

}  // namespace

FelipePlayer::~FelipePlayer() {
    jpeg_free_align(scratch_);
    heap_caps_free(squeezed_);
}

bool FelipePlayer::Load() {
    if (loaded()) return true;
    if (tried_) return false;  // one try per boot; a missing pack means the blob
    tried_ = true;
    pack_ = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, "characters");
    char magic[sizeof(felipe::kPackMagic) - 1] = {};
    if (pack_ == nullptr || esp_partition_read(pack_, 0, magic, sizeof(magic)) != ESP_OK ||
        memcmp(magic, felipe::kPackMagic, sizeof(magic)) != 0) {
        ESP_LOGW(TAG, "No Felipe pack in the characters partition; keeping the blob");
        return false;
    }
    for (int i = 0; i < static_cast<int>(Move::Count); ++i) {
        const auto& movement = felipe::kMovements[i];
        loop_ms_[i] = 0;
        for (int s = 0; s < movement.step_count; ++s) loop_ms_[i] += movement.steps[s].ms;
    }
    squeezed_ = static_cast<uint8_t*>(heap_caps_malloc(felipe::kBiggestPicture, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    // The JPEG decoder needs a 16-byte aligned output; at this size it lands in PSRAM.
    scratch_ = static_cast<uint16_t*>(jpeg_calloc_align(kPictureBytes, 16));
    if (scratch_ == nullptr || squeezed_ == nullptr) {
        ESP_LOGE(TAG, "No room for the picture slots; keeping the blob");
        jpeg_free_align(scratch_);
        heap_caps_free(squeezed_);
        scratch_ = nullptr;
        squeezed_ = nullptr;
        return false;
    }
    ESP_LOGI(TAG, "Loaded; picture slots %u + %u bytes in PSRAM. Free: internal %u, PSRAM %u",
             (unsigned)kPictureBytes, (unsigned)felipe::kBiggestPicture,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    return true;
}

bool FelipePlayer::Unpack(Move move, int picture) {
    const auto& pic = Info(move).pictures[picture];
    const int64_t began = esp_timer_get_time();
    if (pic.length > felipe::kBiggestPicture ||
        esp_partition_read(pack_, Info(move).offset + pic.start, squeezed_, pic.length) != ESP_OK) {
        ESP_LOGE(TAG, "Could not read picture %d of movement %d", picture, static_cast<int>(move));
        return false;
    }
    // Each picture is a JPEG of this movement's own size, unpacked straight
    // into the RGB565 slot the canvas copy reads from.
    const auto& m = Info(move);
    jpeg_dec_config_t config = DEFAULT_JPEG_DEC_CONFIG();
    config.output_type = JPEG_PIXEL_FORMAT_RGB565_LE;
    jpeg_dec_handle_t decoder = nullptr;
    jpeg_dec_io_t io = {};
    io.inbuf = squeezed_;
    io.inbuf_len = static_cast<int>(pic.length);
    io.outbuf = reinterpret_cast<uint8_t*>(scratch_);
    jpeg_dec_header_info_t info = {};
    bool ok = jpeg_dec_open(&config, &decoder) == JPEG_ERR_OK &&
              jpeg_dec_parse_header(decoder, &io, &info) == JPEG_ERR_OK &&
              info.width == m.w && info.height == m.h &&
              jpeg_dec_process(decoder, &io) == JPEG_ERR_OK;
    if (decoder != nullptr) jpeg_dec_close(decoder);
    const uint32_t took = static_cast<uint32_t>(esp_timer_get_time() - began);
    if (!ok) {
        ESP_LOGE(TAG, "Picture %d of movement %d did not unpack", picture, static_cast<int>(move));
        return false;
    }
    ++unpacked_;
    unpack_us_total_ += took;
    if (took > unpack_us_max_) unpack_us_max_ = took;
    return true;
}

bool FelipePlayer::Draw(lv_color16_t* canvas, int size, Mood mood) {
    if (!loaded() || size < felipe::kWidth || size < felipe::kHeight) return false;
    const Family family = FamilyFor(mood);
    if (!started_ || mood != mood_) {
        // Thinking again within the same answer does not restart the bulb.
        const bool same_loop = started_ && FamilyFor(mood_).loop == family.loop;
        mood_ = mood;
        started_ = true;
        if (!same_loop) {
            move_ = family.intro;
            move_started_ = lv_tick_get();
        }
    }
    uint32_t t = lv_tick_elaps(move_started_);
    if (!Info(move_).loops && t >= loop_ms_[static_cast<int>(move_)]) {
        move_started_ += loop_ms_[static_cast<int>(move_)];
        move_ = family.loop;
        t = lv_tick_elaps(move_started_);
    }
    const auto& movement = Info(move_);
    const uint32_t length = loop_ms_[static_cast<int>(move_)];
    if (length > 0) t = movement.loops ? t % length : std::min(t, length - 1);
    int step = 0;
    for (uint32_t at = 0; step < movement.step_count - 1 && at + movement.steps[step].ms <= t; ++step) {
        at += movement.steps[step].ms;
    }
    const int picture = movement.steps[step].picture;

    if (lv_tick_elaps(reported_at_) >= kReportEveryMs && unpacked_ > 0) {
        ESP_LOGI(TAG, "%u pictures unpacked, avg %u us, max %u us. Free: internal %u, PSRAM %u",
                 (unsigned)unpacked_, (unsigned)(unpack_us_total_ / unpacked_), (unsigned)unpack_us_max_,
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
        reported_at_ = lv_tick_get();
        unpacked_ = unpack_us_total_ = unpack_us_max_ = 0;
    }
    if (move_ == shown_move_ && picture == shown_picture_) return false;
    if (!Unpack(move_, picture)) return false;
    const bool first = shown_move_ == Move::Count;
    const bool moved = !first && (Info(shown_move_).x != Info(move_).x || Info(shown_move_).y != Info(move_).y ||
                                  Info(shown_move_).w != Info(move_).w || Info(shown_move_).h != Info(move_).h);
    shown_move_ = move_;
    shown_picture_ = picture;

    // Each movement is stored cropped to its own area. Clear the field when
    // the movement changes (the old one may have covered more of it); after
    // that only this movement's rectangle changes.
    auto* out = reinterpret_cast<uint16_t*>(canvas);
    if (first || moved) memset(out, 0, static_cast<size_t>(size) * size * 2);
    const auto& m = Info(move_);
    const int x0 = (size - felipe::kWidth) / 2 + m.x;
    const int y0 = (size - felipe::kHeight) / 2 + m.y;
    for (int y = 0; y < m.h; ++y) {
        memcpy(out + (y0 + y) * size + x0, scratch_ + y * m.w, static_cast<size_t>(m.w) * 2);
    }
    return true;
}
