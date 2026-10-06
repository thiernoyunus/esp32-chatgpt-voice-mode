#!/usr/bin/env python3
"""Compile the actual offer sender and check saved settings in its message."""
from pathlib import Path
import subprocess
import tempfile
import os
from host_toolchain import compiler_flags

root = Path(__file__).resolve().parents[2]
source = (root / 'main/protocols/codex_voice_protocol.cc').read_text()
sender = source[source.index('bool CodexVoiceProtocol::SendSignalOffer('):source.index('bool CodexVoiceProtocol::SelectModel(')]
program = r'''
#include "cJSON.h"
#include <cassert>
#include <cstdint>
#include <map>
#include <string>
std::map<std::string, std::string> saved;
struct Settings {
 std::string area;
 Settings(const char* name, bool) : area(name) {}
 std::string GetString(const char* key, const char* fallback) {
  auto found = saved.find(area + "/" + key);
  return found == saved.end() ? fallback : found->second;
 }
 bool GetBool(const char*, bool fallback) { return fallback; }
};
int NowMilliseconds() { return 0; }
struct CodexVoiceProtocol {
 void* websocket_ = this;
 std::string request_id_ = "check", message;
 bool SendSignalOffer(const uint8_t*, size_t);
 bool SendText(const char* text) { message = text; return true; }
 void Fail(const char*) { assert(false); }
};
''' + sender + r'''
int main() {
 CodexVoiceProtocol voice;
 for (const auto& level : {"Default", "Low", "Medium", "High", "XHigh", "Max", "Ultra"}) {
  for (const auto& chat : {"", "saved-chat"}) {
   saved["codex/reasoning"] = level;
   saved["codex_voice/chat"] = chat;
   saved["codex_voice/model"] = "selected-model";
   assert(voice.SendSignalOffer(reinterpret_cast<const uint8_t*>("v=0"), 3));
   auto json = cJSON_Parse(voice.message.c_str());
   auto effort = cJSON_GetObjectItemCaseSensitive(json, "reasoningEffort");
   if (std::string(level) == "Default") assert(effort == nullptr);
   else {
    std::string expected = level;
    for (auto& c : expected) if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
    assert(cJSON_IsString(effort) && expected == effort->valuestring);
   }
   assert(std::string(cJSON_GetObjectItemCaseSensitive(json, "model")->valuestring) == "selected-model");
   auto thread = cJSON_GetObjectItemCaseSensitive(json, "threadId");
   assert((thread != nullptr) == !std::string(chat).empty());
   cJSON_Delete(json);
  }
 }
}
'''
with tempfile.TemporaryDirectory(prefix='voice-reasoning-') as directory:
    directory = Path(directory)
    cjson = Path(os.environ.get('CJSON_SOURCE', root / 'managed_components/espressif__cjson/cJSON'))
    cpp = directory / 'check.cc'
    cpp.write_text(program)
    binary = directory / 'check'
    subprocess.run(['c++', '-std=c++17', *compiler_flags(), '-I', str(cjson), str(cpp), str(cjson / 'cJSON.c'), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
print('Saved reasoning is sent for new and resumed calls; Default inherits Codex.')
