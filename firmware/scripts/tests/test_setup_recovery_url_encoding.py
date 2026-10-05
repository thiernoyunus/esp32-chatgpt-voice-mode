#!/usr/bin/env python3
"""Execute production URL helpers. Build and assertion failures are fatal."""
from pathlib import Path
import subprocess
import tempfile
from urllib.parse import urlsplit, parse_qs, unquote
from host_toolchain import compiler_flags

root = Path(__file__).resolve().parents[2]
source = (root / "main/protocols/codex_voice_protocol.cc").read_text()
helpers = source[source.index("std::string PercentEncode("):source.index("constexpr int OpusFrameDurationMs(")]
program = r"""
#include <cassert>
#include <iostream>
#include <string>
HELPERS
int main() {
    assert(PercentEncode("abcXYZ012-_.~") == "abcXYZ012-_.~");
    assert(PercentEncode("") == "");
    assert(PercentEncode("+/=& ?#%") == "%2B%2F%3D%26%20%3F%23%25");
    assert(PercentEncode("\xC3\xA9") == "%C3%A9");
    assert(BuildConnectionUrl("ws://host:8790///", "desk", "abc-_") ==
           "ws://host:8790/agents/voicemode/desk?token=abc-_");
    std::cout << BuildConnectionUrl("ws://host:8790/", "desk/2 ?#", "a+b/c==& %") << "\n";
}
""".replace("HELPERS", helpers)
with tempfile.TemporaryDirectory(prefix="setup-url-") as directory:
    path = Path(directory)
    (path / "test.cc").write_text(program)
    subprocess.run(["c++", *compiler_flags(), "-std=c++17", "-Wall", "-Werror",
                    str(path / "test.cc"), "-o", str(path / "test")], check=True)
    result = subprocess.run([str(path / "test")], check=True, text=True, capture_output=True)
    url = urlsplit(result.stdout.strip())
    assert unquote(url.path.removeprefix("/agents/voicemode/")) == "desk/2 ?#"
    assert parse_qs(url.query) == {"token": ["a+b/c==& %"]}
print("PASS: executed URL encoding and decoded credential round trip")
