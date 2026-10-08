#!/usr/bin/env python3
"""Exercise the actual voice-message parser with the firmware's JSON library.

With --fixtures, a file of real messages from the Mac listener (one JSON message
per line) is replayed through the same parser, so the two sides of the wire
contract are checked against each other instead of each against a copy of the
other.
"""
import argparse
from pathlib import Path
import subprocess
from host_dependencies import fetch_cjson
import sys
import tempfile

from host_toolchain import compiler_flags


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fixtures",
        metavar="PATH",
        help="JSON-lines file of real Mac messages to replay, or - to read them from standard input",
    )
    arguments = parser.parse_args()

    root = Path(__file__).resolve().parents[2]
    source = (root / "main/protocols/codex_voice_protocol.cc").read_text()
    handler = source[source.index("void CodexVoiceProtocol::HandleSignal("):
                     source.index("void CodexVoiceProtocol::StartSpeaking(")]
    program = r'''
#include "cJSON.h"
#include "voice_readiness.h"
#include <atomic>
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <functional>
#include <string>
#include <vector>
#define ESP_LOGI(...)
#define ESP_LOGD(...)
std::string ReadErrorMessage(cJSON*) { return "error"; }
constexpr int ESP_PEER_MSG_TYPE_SDP = 0, ESP_PEER_ERR_NONE = 0;
struct esp_peer_msg_t { int type; uint8_t* data; int size; };
int esp_peer_send_msg(void*, esp_peer_msg_t*) { return 0; }
struct Display {
    std::string model, activity, icon, pixels;
    void SetVoiceModel(const char* value) { model = value; }
    void SetVoiceActivity(const char* value, const char* symbol, const char* image = nullptr) {
        activity = value; icon = symbol; pixels = image ? image : "";
    }
};
struct Board {
    Display display;
    static Board& GetInstance() { static Board board; return board; }
    Display* GetDisplay() { return &display; }
};
struct Application {
    struct Audio { int resets = 0; void ResetDecoder() { ++resets; } } audio;
    Audio& GetAudioService() { return audio; }
    std::vector<std::function<void()>> queue;
    static Application& GetInstance() { static Application app; return app; }
    void Schedule(std::function<void()> function) { queue.push_back(std::move(function)); }
    void Drain() { auto pending = std::move(queue); queue.clear(); for (auto& call : pending) call(); }
};
/* The parser saves a chosen chat and reads the clock; neither is what this
 * test is about, so both are recorded and ignored. */
struct Settings {
    Settings(const char*, bool) {}
    std::string GetString(const char*, const char* fallback = "") { return fallback; }
    void SetString(const char*, const std::string&) {}
};
uint32_t NowMilliseconds() { return 0; }
bool AtOrAfter(uint32_t sample, uint32_t since) {
    return static_cast<int32_t>(sample - since) >= 0;
}
struct CodexVoiceProtocol {
    struct ModelChoice { std::string id, name; };
    /* The folder is part of the chat the picker shows; the source fills it in,
     * so the stand-in has to carry it too or the file will not compile. */
    struct ChatChoice { std::string id, name, folder; };
    std::vector<ModelChoice> models_{{"", "Default"}};
    std::vector<ChatChoice> chats_;
    std::string request_id_ = "current", chat_list_request_id_ = "picker", error;
    /* Written by the parser when a reply is expected; read by the watchdog. */
    std::atomic<uint32_t> last_audio_frame_ms_{0}, speech_expected_since_ms_{0};
    std::atomic<int> codex_app_{-1};  // the Mac's answer to a status request
    std::string transcript_partial_, transcript_role_;
    /* Where the parser hands a finished line of speech; kept so a test can see
     * the text the device would have captioned. */
    std::string emitted_role, emitted_text;
    uint32_t transcript_emitted_at_ = 0;
    void* peer_ = nullptr;
    bool opened = true;
    int speaking = 0;
    std::function<void(const cJSON*)> on_incoming_json_;
    bool IsAudioChannelOpened() { return opened; }
    void Fail(const std::string& value) { error = value; }
    void StartSpeaking() { ++speaking; }
    void StopSpeaking() { speaking = 0; }
    void EmitTranscript(const char* role, const char* text) {
        emitted_role = role; emitted_text = text;
    }
    void StreamTranscript(const char*, const char*) {}
    void MarkStage(uint32_t) {}
    void HandleSignal(const char*, size_t);
    void HandleRealtimeEvent(const uint8_t*, size_t);
    void Event(const std::string& value) { HandleRealtimeEvent(reinterpret_cast<const uint8_t*>(value.data()), value.size()); }
    void Receive(const std::string& value) { HandleSignal(value.data(), value.size()); }
};
HANDLER
int main(int argc, char** argv) {
    CodexVoiceProtocol voice;
    voice.Receive(R"({"type":"chat_list","requestId":"picker","chats":[{"id":"live","name":"Live chat","folder":"Project"}]})");
    Application::GetInstance().Drain();
    assert(voice.chats_.size() == 1 && voice.chats_[0].id == "live");
    voice.Receive(R"({"type":"chat_list","requestId":"stale","chats":[]})");
    Application::GetInstance().Drain();
    assert(voice.chats_.size() == 1);
    voice.Receive(R"({"type":"chat_list","requestId":"picker","chats":[]})");
    Application::GetInstance().Drain();
    assert(voice.chats_.empty());
    int tool_requests = 0;
    voice.on_incoming_json_ = [&](const cJSON*) { ++tool_requests; };
    voice.Receive(R"({"type":"mcp","payload":{"jsonrpc":"2.0","id":1,"method":"tools/call"}})");
    voice.Receive(R"({"type":"mcp","payload":[]})");
    assert(tool_requests == 1);
    voice.on_incoming_json_ = nullptr;
    voice.Receive(R"({"type":"mcp","payload":{}})");
    auto& app = Application::GetInstance();
    auto& display = Board::GetInstance().display;
    voice.Receive(R"({"type":"realtime_answer","requestId":"current","models":[{"id":"opus","name":"Opus 5"},{"id":7,"name":"invalid"}],"selectedModel":"opus"})");
    assert(voice.models_.size() == 1);
    app.Drain();
    assert(voice.models_.size() == 2 && display.model == "Opus 5");
    voice.Receive(R"({"type":"realtime_status","requestId":"current","caption":"Searching the web"})");
    app.Drain();
    assert(display.activity == "Searching the web" && voice.speaking == 0);
    voice.Receive(R"({"type":"realtime_status","requestId":"current","caption":"Search commits","icon":"github"})");
    app.Drain();
    assert(display.icon == "none");
    const std::string image(3072, 'A');
    voice.Receive((std::string(R"({"type":"realtime_status","requestId":"current","caption":"Plugin action","iconPixels":")") + image + R"("})").c_str());
    app.Drain();
    assert(display.pixels == image);
    voice.Receive(R"({"type":"realtime_status","requestId":"current","caption":"Plugin action","iconPixels":"too short"})");
    app.Drain();
    assert(display.pixels.empty());
    voice.Receive(R"({"type":"realtime_status","requestId":"current","caption":"Searching the web","icon":"bad"})");
    app.Drain();
    assert(display.icon == "none");
    voice.Receive(R"({"type":"realtime_status","requestId":"old","caption":"stale"})");
    app.Drain();
    assert(display.activity == "Searching the web");
    voice.Receive(R"({"type":"realtime_status","requestId":"current","caption":"late"})");
    voice.request_id_ = "replacement";
    app.Drain();
    assert(display.activity == "Searching the web");
    voice.Receive(R"({"type":"realtime_status","requestId":"replacement","caption":"closed"})");
    voice.opened = false;
    app.Drain();
    assert(display.activity == "Searching the web");
    voice.Receive("not json");
    voice.Receive(R"({"type":[],"requestId":"replacement"})");
    assert(voice.error.empty());
    voice.opened = true;
    voice.speaking = 1;
    voice.Event(R"({"type":"turn.created","turn":{"role":"assistant"}})");
    voice.Event(R"({"type":"turn.created","turn":{"role":5}})");
    voice.Event(R"({"type":"turn.created"})");
    app.Drain();
    assert(app.audio.resets == 0 && voice.speaking == 1);
    voice.Event(R"({"type":"turn.created","turn":{"role":"user"}})");
    assert(app.audio.resets == 0);
    app.Drain();
    assert(app.audio.resets == 1 && voice.speaking == 0 && voice.opened);
    voice.Event(R"({"type":"turn.created","turn":{"role":"user"}})");
    voice.request_id_ = "new-call";
    app.Drain();
    assert(app.audio.resets == 1);
    voice.Event(R"({"type":"turn.created","turn":{"role":"user"}})");
    voice.opened = false;
    app.Drain();
    assert(app.audio.resets == 1);

    /* Optional second pass: replay real messages the Mac listener actually
     * produces, so the wire contract is checked by the device's own parser
     * rather than by a second copy of it. The file is one JSON message per
     * line; each is handed to the parser exactly as it arrives over the wire. */
    if (argc > 1) {
        std::ifstream fixtures(argv[1]);
        if (!fixtures) {
            std::fprintf(stderr, "FAIL: cannot read fixtures: %s\n", argv[1]);
            return 2;
        }
        auto require = [](bool condition, const char* what) {
            if (condition) return;
            std::fprintf(stderr, "FAIL: %s\n", what);
            std::exit(1);
        };
        CodexVoiceProtocol contract;
        // The fixtures were generated for one session id; the parser ignores
        // anything addressed to a different one.
        contract.request_id_ = "contract-test";
        bool saw_answer = false, saw_status = false, saw_transcript = false, saw_error = false;
        std::string line;
        while (std::getline(fixtures, line)) {
            if (!line.empty() && line.back() == '\r') line.pop_back();
            if (line.empty()) continue;
            cJSON* parsed = cJSON_Parse(line.c_str());
            if (parsed == nullptr) {
                std::fprintf(stderr, "FAIL: fixture line is not JSON: %s\n", line.c_str());
                return 1;
            }
            const cJSON* type = cJSON_GetObjectItemCaseSensitive(parsed, "type");
            const std::string kind = cJSON_IsString(type) ? type->valuestring : "";
            cJSON_Delete(parsed);

            contract.Receive(line);
            app.Drain();

            if (kind == "realtime_answer") {
                saw_answer = true;
                require(contract.models_.size() == 2 && display.model == "Test voice",
                        "realtime_answer: the model list did not land on Test voice");
                require(contract.chats_.size() == 1 &&
                            contract.chats_[0].id == "contract-chat" &&
                            contract.chats_[0].folder == "Personal",
                        "realtime_answer: the chat did not arrive with its folder");
            } else if (kind == "realtime_status") {
                saw_status = true;
                require(display.activity == "Checking connection" && display.icon == "search",
                        "realtime_status: the caption or icon did not land");
            } else if (kind == "realtime_transcript_done") {
                saw_transcript = true;
                // The dash and the Arabic survive only if the text is passed
                // through untouched rather than re-encoded on the way.
                require(contract.emitted_text == "Hello \u2014 \u0645\u0631\u062d\u0628\u064b\u0627",
                        "realtime_transcript_done: the transcript text changed in transit");
            } else if (kind == "realtime_error") {
                saw_error = true;
                require(contract.error == "Please choose another voice.",
                        "realtime_error: the message did not land");
            } else {
                std::fprintf(stderr, "FAIL: unexpected fixture type: %s\n", kind.c_str());
                return 1;
            }
        }
        require(saw_answer && saw_status && saw_transcript && saw_error,
                "the fixture file did not contain all four message kinds");
        std::printf("PASS: %d real Mac messages parsed by the device parser\n",
                    saw_answer + saw_status + saw_transcript + saw_error);
    }
}
'''.replace("HANDLER", handler)
    # Empty unless this machine's default toolchain cannot link its own SDK.
    flags = compiler_flags()
    with tempfile.TemporaryDirectory(prefix="voicemode-message-test-") as directory:
        path = Path(directory)
        cjson = fetch_cjson(path)
        (path / "test.cc").write_text(program)
        subprocess.run(["cc", *flags, "-c", str(cjson / "cJSON.c"), "-o", str(path / "json.o")],
                       check=True)
        subprocess.run(["c++", *flags, "-std=c++17", "-I", str(cjson),
                        "-I", str(root / "main/protocols"),
                        str(path / "test.cc"), str(path / "json.o"), "-o", str(path / "test")], check=True)
        command = [str(path / "test")]
        if arguments.fixtures:
            if arguments.fixtures == "-":
                fixture_path = path / "fixtures.jsonl"
                fixture_path.write_bytes(sys.stdin.buffer.read())
            else:
                fixture_path = Path(arguments.fixtures).resolve()
                if not fixture_path.is_file():
                    sys.exit(f"fixtures file not found: {fixture_path}")
            command.append(str(fixture_path))
        subprocess.run(command, check=True, timeout=15)
    print("PASS: live model/activity messages validate input and reject stale call updates")


if __name__ == "__main__":
    main()
