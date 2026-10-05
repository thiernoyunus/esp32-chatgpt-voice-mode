#!/usr/bin/env python3
"""Run every host test in scripts/tests and report each one.

These tests are ordinary programs rather than a test-library suite: each one
compiles part of the real firmware or drives it, prints its own result, and
fails the process when something is wrong. They have to be run one at a time
for that to happen. A test-library discovery pass would pick up the single file
that uses a test library and report success while all the others never ran.

Needs a C/C++ compiler, cmake, Pillow, and kconfiglib. The exit status is bad
if any test fails, so CI cannot pass without running them.

    python3 scripts/tests/run_host_tests.py [--fixtures PATH]
"""

import argparse
import os
import signal
import re
import subprocess
import sys
from pathlib import Path

TESTS = Path(__file__).resolve().parent
ROOT = TESTS.parents[1]

# Look like tests but are not part of this fork. Listed rather than deleted, and
# printed on every run so the omission is visible instead of quiet.
NOT_APPLICABLE = {
    "test_build.py": (
        "upstream's broad board build suite. This fork builds two watches, so "
        "its camera/LCD option and variant checks have nothing to check "
        "(see AGENTS.md)."
    ),
}

# Cheap checks first, the slow screenshot render last, so a failure shows up
# early in the log.
PREFERRED_ORDER = [
    "test_playback_pipeline.py",
    "test_codex_profile.py",
    "test_build_default_assets.py",
    "test_setup_recovery_ota_gate.py",
    "test_setup_recovery_url_encoding.py",
    "test_microphone_mute.py",
    "test_reply_audio_watchdog.py",
    "test_voice_close.py",
    "test_voice_messages.py",
    "test_voice_preroll.py",
    "test_voice_readiness.py",
    "test_watch_touch.py",
    "test_watch_wifi.py",
    "test_watch_wifi_recovery.py",
    "test_watch_ui.py",
]


def ordered_tests():
    """Every test file, with the known ones first and any new file last."""

    def position(path):
        if path.name in PREFERRED_ORDER:
            return PREFERRED_ORDER.index(path.name)
        return len(PREFERRED_ORDER)

    return sorted(TESTS.glob("test_*.py"), key=lambda path: (position(path), path.name))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fixtures",
        metavar="PATH",
        help="pass real Mac messages (JSON lines) to test_voice_messages.py",
    )
    parser.add_argument("--timeout", type=float, default=600,
                        help="maximum seconds per test, including builds (default: 600)")
    arguments = parser.parse_args()
    if arguments.timeout <= 0:
        parser.error("--timeout must be positive")

    results = []
    for test in ordered_tests():
        if test.name in NOT_APPLICABLE:
            print(f"SKIP {test.name}: {NOT_APPLICABLE[test.name]}\n", flush=True)
            continue
        print(f"=== {test.name}", flush=True)
        command = [sys.executable, str(test)]
        if arguments.fixtures and test.name == "test_voice_messages.py":
            command += ["--fixtures", arguments.fixtures]
        # A separate process group lets a timeout stop compilers and renderers too.
        with subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True,
                              start_new_session=True) as process:
            try:
                stdout, stderr = process.communicate(timeout=arguments.timeout)
                passed = process.returncode == 0
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                stdout, stderr = process.communicate()
                stderr += f"\nTimed out after {arguments.timeout:g} seconds\n"
                passed = False
        if re.search(r"(?im)^\s*skip(?:ped)?(?:\s|:|$)", stdout + stderr):
            stderr += "\nRequired host tests must execute; a skip was reported\n"
            passed = False
        sys.stdout.write(stdout)
        sys.stderr.write(stderr)
        results.append((test.name, passed))
        print(f"{'PASS' if passed else 'FAIL'} {test.name}\n", flush=True)

    failed = [name for name, passed in results if not passed]
    print(f"{len(results) - len(failed)} of {len(results)} host tests passed")
    if failed:
        print("failed: " + ", ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
