import pathlib
import subprocess
import sys
import tempfile
import unittest


class FirstRtpFilterTest(unittest.TestCase):
    def test_only_media_packet_matches(self):
        root = pathlib.Path(__file__).resolve().parents[2]
        source = r'''
#include <assert.h>
#include <stdint.h>
#include "codex_voice_udp.h"
int main(void) {
    uint8_t rtp[12] = {0x80, 111};
    uint8_t rtcp[12] = {0x80, 200};
    uint8_t dtls[12] = {22};
    uint8_t stun[12] = {0};
    assert(codex_voice_is_rtp(rtp, 12));
    assert(!codex_voice_is_rtp(rtp, 11));
    assert(!codex_voice_is_rtp(rtcp, 12));
    assert(!codex_voice_is_rtp(dtls, 12));
    assert(!codex_voice_is_rtp(stun, 12));
}
'''
        with tempfile.TemporaryDirectory() as tmp:
            executable = pathlib.Path(tmp) / "check"
            command = ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror"]
            # Current macOS 27 beta SDK cannot link this host check yet.
            sdk26 = pathlib.Path("/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk")
            if sys.platform == "darwin" and sdk26.exists():
                command += ["-isysroot", str(sdk26)]
            command += ["-I", str(root / "main/protocols"), "-x", "c", "-", "-o", str(executable)]
            subprocess.run(
                command,
                input=source, text=True, check=True,
            )
            subprocess.run([str(executable)], check=True)


if __name__ == "__main__":
    unittest.main()
