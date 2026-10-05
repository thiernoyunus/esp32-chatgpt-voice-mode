#!/usr/bin/env python3
"""Execute production readiness, acceptance gate and rollback inspection."""
from pathlib import Path
import subprocess
import tempfile
from host_toolchain import compiler_flags

root = Path(__file__).resolve().parents[2]
app = (root / "main/application.cc").read_text()
audio = (root / "main/audio/audio_service.h").read_text()
ota = (root / "main/ota.cc").read_text()
predicate = audio[audio.index("bool IsAudioReady()"):audio.index("    // Run before announcing")]
gate = app[app.index("    ota_->InspectCurrentVersion();"):app.index('    Settings settings("voicemode", false);', app.index("void Application::CheckFirmwareUpdate()"))]
methods = ota[ota.index("void Ota::InspectCurrentVersion()"):ota.index("bool Ota::Upgrade(")]
program = r"""
#include <atomic>
#include <cassert>
#include <cstring>
#include <string>
#define ESP_LOGI(...)
#define ESP_LOGW(...)
#define ESP_LOGE(...)
constexpr int ESP_OK=0;
enum esp_ota_img_states_t { ESP_OTA_IMG_VALID, ESP_OTA_IMG_PENDING_VERIFY,
                           ESP_OTA_IMG_INVALID, ESP_OTA_IMG_ABORTED };
struct esp_partition_t { const char* label; };
esp_partition_t running{"ota_0"}, other{"ota_1"};
esp_ota_img_states_t running_state, other_state;
int marks=0;
const esp_partition_t* esp_ota_get_running_partition(){return &running;}
const esp_partition_t* esp_ota_get_next_update_partition(void*){return &other;}
int esp_ota_get_state_partition(const esp_partition_t* p, esp_ota_img_states_t* state) {
    *state = p == &running ? running_state : other_state; return ESP_OK;
}
int esp_ota_mark_app_valid_cancel_rollback(){++marks; return ESP_OK;}
struct Ota {
    std::string running_slot_;
    bool rolled_back_=false;
    void InspectCurrentVersion();
    void MarkCurrentVersionValid();
    bool RolledBack() const {return rolled_back_;}
};
METHODS
struct AudioService {
    void *codec_=nullptr, *opus_encoder_=nullptr, *opus_decoder_=nullptr;
    void *audio_input_task_handle_=nullptr, *audio_output_task_handle_=nullptr;
    void *opus_codec_task_handle_=nullptr;
    std::atomic<bool> service_stopped_{true};
    PREDICATE
};
struct Application {
    AudioService audio_service_;
    bool boot_audio_engine_ready_=false;
    void* protocol_=nullptr;
    Ota storage;
    Ota* ota_=&storage;
    std::string pending_watch_notification_;
    void Check() { GATE }
};
int main() {
    for (unsigned bits=0; bits<512; ++bits) {
        for (auto previous : {ESP_OTA_IMG_VALID, ESP_OTA_IMG_INVALID, ESP_OTA_IMG_ABORTED}) {
            for (auto current : {ESP_OTA_IMG_VALID, ESP_OTA_IMG_PENDING_VERIFY}) {
                Application a;
                auto ptr=[&](unsigned bit)->void* {return bits & (1u<<bit) ? &a : nullptr;};
                auto& s=a.audio_service_;
                s.codec_=ptr(0); s.opus_encoder_=ptr(1); s.opus_decoder_=ptr(2);
                s.audio_input_task_handle_=ptr(3); s.audio_output_task_handle_=ptr(4);
                s.opus_codec_task_handle_=ptr(5); s.service_stopped_=!(bits & 64);
                a.boot_audio_engine_ready_=bits & 128; a.protocol_=ptr(8);
                running_state=current; other_state=previous; marks=0;
                a.Check();
                assert(s.IsAudioReady() == ((bits & 127)==127));
                assert(marks == (bits==511 && current==ESP_OTA_IMG_PENDING_VERIFY));
                bool rollback=previous==ESP_OTA_IMG_INVALID || previous==ESP_OTA_IMG_ABORTED;
                assert(a.storage.RolledBack()==rollback);
                assert((!a.pending_watch_notification_.empty())==rollback);
            }
        }
    }
}
""".replace("METHODS", methods).replace("PREDICATE", predicate).replace("GATE", gate)
with tempfile.TemporaryDirectory(prefix="setup-ota-") as directory:
    path = Path(directory)
    (path / "test.cc").write_text(program)
    subprocess.run(["c++", *compiler_flags(), "-std=c++17", "-Wall", "-Werror",
                    str(path / "test.cc"), "-o", str(path / "test")], check=True)
    subprocess.run([str(path / "test")], check=True)
print("PASS: 3072 executed boot cases; readiness gates acceptance, rollback inspection always runs")
