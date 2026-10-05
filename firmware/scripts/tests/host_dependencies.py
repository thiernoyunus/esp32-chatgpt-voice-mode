"""Small, checked downloads for tests that run without ESP-IDF."""

import hashlib
import urllib.request
from pathlib import Path

CJSON_VERSION = "1.7.19"
CJSON_HASHES = {
    "cJSON.c": "298581a04a36c0165da4b0aade235c23088cb2faa58651d720ea2f3706ed0b0d",
    "cJSON.h": "25b0145150d500498e4d209cec69c18c42cf818bffcc54690be3b895a2a16dee",
}


def fetch_cjson(directory: Path) -> Path:
    """Download only the two source files, rejecting changed contents."""
    destination = directory / "cjson"
    destination.mkdir()
    for name, expected in CJSON_HASHES.items():
        url = f"https://raw.githubusercontent.com/DaveGamble/cJSON/v{CJSON_VERSION}/{name}"
        with urllib.request.urlopen(url, timeout=30) as response:
            content = response.read()
        if hashlib.sha256(content).hexdigest() != expected:
            raise RuntimeError(f"Downloaded {name} does not match cJSON {CJSON_VERSION}")
        (destination / name).write_bytes(content)
    return destination
