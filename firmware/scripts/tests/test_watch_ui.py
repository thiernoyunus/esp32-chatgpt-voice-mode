#!/usr/bin/env python3
"""Build and run the WatchUi host harness against a pinned compatible LVGL release.

This renders every watch page off a fresh clone: the harness under
scripts/tests/watch_ui_host fetches LVGL 9.5.0 (a baseline for the manifest's ~9.5.0 range), compiles the real main/display/watch_ui.cc against it, drives it, and
leaves one PNG per page. The checks here are that the pages all rendered, that
each image is the panel's real 360x360, and that nothing was painted outside the
round screen.

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
EXPECTED_TAGS = {
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

    # Start from an empty directory of our own; never sweep pictures that other
    # tools keep in /tmp.
    if SHOTS.exists():
        for path in SHOTS.glob("watch-*.png"):
            path.unlink()
    SHOTS.mkdir(parents=True, exist_ok=True)

    environment = dict(os.environ, VOICEMODE_WATCH_UI_SHOTS=str(SHOTS))
    subprocess.run([str(BUILD / "watch_ui_test")], cwd=ROOT, check=True, env=environment)

    shots = sorted(SHOTS.glob("watch-*.png"))
    # watch-07-settings.png -> settings, taking everything after the index.
    tags = {path.stem.split("-", 2)[2] for path in shots}
    if tags != EXPECTED_TAGS:
        missing = sorted(EXPECTED_TAGS - tags)
        extra = sorted(tags - EXPECTED_TAGS)
        return die(f"screenshot set is wrong; missing {missing}, unexpected {extra}")

    for path in shots:
        from PIL import Image

        with Image.open(path) as image:
            if image.size != (360, 360):
                return die(f"{path} is {image.size}, expected the panel's 360x360")
        subprocess.run([sys.executable, str(CHECK_ROUND), str(path)], cwd=ROOT, check=True)

    print(f"PASS: {len(shots)} fresh 360x360 WatchUi screenshots in {SHOTS}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
