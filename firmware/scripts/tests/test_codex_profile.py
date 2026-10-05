#!/usr/bin/env python3
"""Run with ESP-IDF's Python: only the Codex Voice path is offered.

The fork removed the Classic presets instead of leaving them as settings that
do nothing, so a stale sdkconfig cannot quietly bring back a display style this
tree does not build. This reads the real Kconfig and checks both halves of
that: the Codex path is on and cannot be switched off, and the removed preset
names are really gone from the file.
"""
from pathlib import Path
import tempfile
import kconfiglib

root = Path(__file__).resolve().parents[2]
source = (root / "main/Kconfig.projbuild").read_text()
voice = source[source.index("config VOICEMODE_CODEX_VOICE"):source.index("config VOICEMODE_NTP_SERVER")]
style = source[source.index("config USE_DEFAULT_MESSAGE_STYLE"):source.index("choice WAKE_WORD_TYPE")]

# Presets the fork deleted. If one of these comes back it is a build path this
# tree does not support, not a preference.
REMOVED_PRESETS = ("USE_EMOTE_MESSAGE_STYLE", "USE_WECHAT_MESSAGE_STYLE", "choice DISPLAY_STYLE")
for preset in REMOVED_PRESETS:
    assert preset not in source, f"{preset} is a removed preset and must not return to Kconfig"

def load(target_is_the_board):
    """Read the voice and message-style settings for a given chip target.

    A fresh Kconfig is built per call: choice values are worked out once when a
    file is read, so asking the same one twice after changing an answer would
    report the first answer again.
    """
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "Kconfig"
        target = "y" if target_is_the_board else "n"
        path.write_text(
            "config VOICEMODE_PROTOCOL\n    bool\n    default y\n"
            f"config IDF_TARGET_ESP32S3\n    bool\n    default {target}\n"
            + voice
            + style
        )
        return kconfiglib.Kconfig(str(path), warn=False)


# On the board this fork builds, the voice path and the default message style
# are both on...
board = load(True)
assert board.syms["VOICEMODE_CODEX_VOICE"].str_value == "y"
assert board.syms["USE_DEFAULT_MESSAGE_STYLE"].str_value == "y"

# ...and the voice path follows the chip rather than being a setting of its own,
# so the wrong target cannot be talked into building it.
wrong_chip = load(False)
assert wrong_chip.syms["VOICEMODE_CODEX_VOICE"].str_value == "n"

print("PASS: the tree offers only the Codex Voice path, with no Classic presets")
