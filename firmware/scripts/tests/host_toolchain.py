#!/usr/bin/env python3
"""Toolchain help shared by the host test scripts.

On some Macs the CommandLineTools copy of the macOS SDK is newer than the linker
shipped in the same install, and every attempt to link fails with "malformed
file" / "unknown architecture" complaints about the SDK's own library stubs.
Xcode keeps its own copy of the same SDK, so when the default cannot link (and
only then) these helpers say to point the compiler at Xcode's copy. Nothing on
the machine is changed.
"""

import subprocess
import sys
import tempfile
from pathlib import Path


def _compiles_and_links(flags):
    with tempfile.TemporaryDirectory(prefix="voicemode-toolchain-check-") as directory:
        source = Path(directory) / "probe.cc"
        source.write_text("int main() { return 0; }\n")
        result = subprocess.run(
            ["c++", *flags, str(source), "-o", str(Path(directory) / "probe")],
            capture_output=True,
            text=True,
        )
    return result.returncode == 0


def xcode_sdk():
    """The macOS SDK inside Xcode, if this is a Mac and Xcode is installed."""
    if sys.platform != "darwin":
        return None
    try:
        developer = subprocess.run(["xcode-select", "-p"], capture_output=True, text=True)
    except OSError:
        return None
    if developer.returncode != 0:
        return None
    sdk = Path(developer.stdout.strip()) / "Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
    return sdk if sdk.is_dir() else None


def needed_sysroot():
    """The SDK to compile against, or None when the default already works."""
    if sys.platform != "darwin" or _compiles_and_links([]):
        return None
    sdk = xcode_sdk()
    if sdk is None or not _compiles_and_links(["-isysroot", str(sdk)]):
        return None
    return sdk


def compiler_flags():
    """Extra flags for the C/C++ compiler, usually an empty list."""
    sdk = needed_sysroot()
    return ["-isysroot", str(sdk)] if sdk else []
