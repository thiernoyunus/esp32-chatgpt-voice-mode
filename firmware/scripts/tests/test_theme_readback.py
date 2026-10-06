#!/usr/bin/env python3
"""Check that reading the current theme never saves or redraws it."""
from pathlib import Path
import re
import subprocess
import tempfile

from host_toolchain import compiler_flags

root = Path(__file__).resolve().parents[2]
source = (root / "main/application.cc").read_text()
method = re.search(r"bool Application::SetUiTheme\(int theme\) \{.*?\n\}", source, re.S)
assert method, "SetUiTheme was not found"
program = r'''
#include <algorithm>
#include <cassert>
#include "watch_palette.h"
int saved = 0, writes = 0, opened = 0;
struct Settings {
    Settings(const char*, bool) { ++opened; }
    void SetInt(const char*, int value) { saved = value; ++writes; }
};
struct Application {
    int refreshes = 0;
    bool SetUiTheme(int);
    void RefreshWatchInfo() { ++refreshes; }
};
METHOD
int main() {
    Application app;
    for (int theme = 0; theme < watch_palette::kThemeCount; ++theme) {
        saved = theme;
        assert(app.SetUiTheme(-1));
        assert(saved == theme && writes == 0 && opened == 0 && app.refreshes == 0);
    }
    assert(app.SetUiTheme(1));
    assert(saved == 1 && writes == 1 && app.refreshes == 1);
    assert(app.SetUiTheme(0));
    assert(saved == 0 && writes == 2 && app.refreshes == 2);
}
'''.replace("METHOD", method.group(0))
with tempfile.TemporaryDirectory() as directory:
    check = Path(directory) / "check.cc"
    check.write_text(program)
    binary = Path(directory) / "check"
    subprocess.run(["c++", *compiler_flags(), "-std=c++17", "-I",
                    str(root / "main/display"), str(check), "-o", str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
print("PASS: theme readback preserves every saved theme; explicit changes still apply")
