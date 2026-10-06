#!/usr/bin/env python3
"""Build and run the WatchUi host harness against a pinned compatible LVGL release.

This renders every watch page off a fresh clone: the harness under
scripts/tests/watch_ui_host fetches LVGL 9.5.0 (a baseline for the manifest's ~9.5.0 range), compiles the real main/display/watch_ui.cc against it, drives it, and
leaves one PNG per page.

Both panels are rendered, because watch_ui.cc lays itself out differently
depending on which one it is on: the round watch is 360x360 and clips to a
circle, the AMOLED is 410x502 and gets full-width rows and bigger previews. A
pass on one says nothing about the other, and the AMOLED has pages the round
watch does not have at all. Each layout is checked against its own real size,
and the outside-the-circle check runs only where there is a circle to go
outside of.

Needs cmake, a C/C++ compiler, and Pillow. Missing pieces are an error, not a
skip: in CI a skipped UI test is indistinguishable from a passing one.
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

from host_toolchain import needed_sysroot

ROOT = Path(__file__).resolve().parents[2]
HOST = ROOT / "scripts/tests/watch_ui_host"
CHECK_ROUND = HOST / "check_round.py"
BUILD = Path(os.environ.get("VOICEMODE_WATCH_UI_BUILD", "/tmp/voicemode-watch-ui-host/build"))
SHOTS = Path(os.environ.get("VOICEMODE_WATCH_UI_SHOTS", "/tmp/voicemode-watch-ui-host/shots"))

# Every page the harness renders has to appear, so a page that silently stops
# being drawn fails the run instead of quietly shrinking the set.
ROUND_TAGS = {
    "home",
    "settings",
    "brightness",
    "volume",
    "clock",
    "wifi",
    "models",
    "about",
    "chatgpt",
    "shapes",
    "colours",
    "sleep",
    "reasoning",
    "chats",
    "wifisetup",
    "notice",
    "chatgpt_voices",
    "keyboard_open",
    "keyboard_ab",
    "keyboard_upper",
    "keyboard_sym",
    "keyboard_typed",
    "keyboard_cancel",
    "keyboard_pass",
    "slider_50",
    "nav_stable",
}

# Pages only the AMOLED has: its Settings list is longer than fits, so it
# scrolls, and it carries the four Themes the round watch has no room for.
AMOLED_EXTRA_TAGS = {
    "settings_bottom",
    "themes_cyan",
    "themes_lime",
    "themes_gold",
    "themes_rose",
}

# name -> the panel's real size, the pages beyond ROUND_TAGS, whether there is a
# circle for content to land outside of, and the harness switch that puts the UI
# into that layout.
LAYOUTS = {
    "round": {"size": (360, 360), "extra": frozenset(), "round_check": True, "env": {}},
    "amoled": {
        "size": (410, 502),
        "extra": AMOLED_EXTRA_TAGS,
        "round_check": False,
        "env": {"VOICEMODE_TEST_AMOLED": "1"},
    },
}


def die(message):
    print(f"FAIL: {message}", file=sys.stderr)
    return 1


def main():
    if shutil.which("cmake") is None:
        return die("cmake is not on PATH; install it to build the watch UI harness")
    try:
        from PIL import Image  # noqa: F401
    except ImportError:
        return die("Pillow is not installed; run 'python3 -m pip install pillow'")

    configure = ["cmake", "-S", str(HOST), "-B", str(BUILD)]
    local_lvgl = os.environ.get("VOICEMODE_LVGL_DIR")
    if local_lvgl:
        configure.append(f"-DVOICEMODE_LVGL_DIR={local_lvgl}")
    sdk = needed_sysroot()
    if sdk is not None:
        print(f"note: using the Xcode copy of the macOS SDK ({sdk})")
        configure.append(f"-DCMAKE_OSX_SYSROOT={sdk}")
    subprocess.run(configure, cwd=ROOT, check=True)
    subprocess.run(["cmake", "--build", str(BUILD), f"-j{os.cpu_count() or 2}"], cwd=ROOT, check=True)

    from PIL import Image

    for name, layout in LAYOUTS.items():
        shots_dir = SHOTS / name
        # Start from an empty directory of our own; never sweep pictures that
        # other tools keep in /tmp.
        if shots_dir.exists():
            for path in shots_dir.glob("watch-*.png"):
                path.unlink()
        shots_dir.mkdir(parents=True, exist_ok=True)

        environment = dict(os.environ, VOICEMODE_WATCH_UI_SHOTS=str(shots_dir), **layout["env"])
        subprocess.run([str(BUILD / "watch_ui_test")], cwd=ROOT, check=True, env=environment)

        shots = sorted(shots_dir.glob("watch-*.png"))
        # watch-07-settings.png -> settings, taking everything after the index.
        tags = {path.stem.split("-", 2)[2] for path in shots}
        expected = ROUND_TAGS | layout["extra"]
        if tags != expected:
            missing = sorted(expected - tags)
            extra = sorted(tags - expected)
            return die(f"{name} screenshot set is wrong; missing {missing}, unexpected {extra}")

        width, height = layout["size"]
        for path in shots:
            with Image.open(path) as image:
                if image.size != (width, height):
                    return die(f"{path} is {image.size}, expected the panel's {width}x{height}")
            if layout["round_check"]:
                subprocess.run([sys.executable, str(CHECK_ROUND), str(path)], cwd=ROOT, check=True)

        print(f"PASS: {name}, {len(shots)} fresh {width}x{height} WatchUi screenshots in {shots_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
