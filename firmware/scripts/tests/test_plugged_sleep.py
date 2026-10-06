#!/usr/bin/env python3
"""Compile the real cable detector and screen-sleep action; check cable changes."""
from pathlib import Path
import re
import subprocess
import tempfile
from host_toolchain import compiler_flags

root = Path(__file__).resolve().parents[2]

def function(path, name):
    source = (root / path).read_text()
    match = re.search(r'(?:void|bool) ' + re.escape(name) + r'\([^)]*\) \{.*?\n\}', source, re.S)
    assert match, name
    return match.group(0)

program = r'''
#include <cassert>
#include <cstdint>
#define ESP_LOGI(...)
class Axp2101 {
public:
    uint8_t status = 0;
    uint8_t ReadReg(uint8_t reg) { assert(reg == 0); return status; }
    bool IsExternalPowerConnected();
};
class Display {
public:
    bool sleeping = false;
    void SetPowerSaveMode(bool value) { sleeping = value; }
};
class Backlight {
public:
    int brightness = 100;
    void SetBrightness(int value) { brightness = value; }
};
class Board {
public:
    Axp2101 power;
    Display display;
    Backlight backlight;
    static Board& GetInstance() { static Board board; return board; }
    bool IsExternalPowerConnected() { return power.IsExternalPowerConnected(); }
    Display* GetDisplay() { return &display; }
    Backlight* GetBacklight() { return &backlight; }
};
class Application {
public:
    bool is_screen_asleep_ = false;
    int idle_seconds_ = 60;
    void NoteUserActivity() {
        idle_seconds_ = 0;
        is_screen_asleep_ = false;
        Board::GetInstance().display.sleeping = false;
        Board::GetInstance().backlight.brightness = 100;
    }
    void SleepScreen();
};
DETECTOR
SLEEP
int main() {
    auto& board = Board::GetInstance();
    for (int status = 0; status < 256; ++status) {
        board.power.status = status;
        assert(board.IsExternalPowerConnected() == ((status & 0x20) != 0));
    }
    Application app;
    board.power.status = 0;
    app.SleepScreen();
    assert(app.is_screen_asleep_ && board.display.sleeping && board.backlight.brightness == 0);
    app.SleepScreen();
    assert(app.is_screen_asleep_);
    // Plugging in wakes a sleeping watch; USB power remains valid with a full battery.
    board.power.status = 0x20;
    app.SleepScreen();
    assert(!app.is_screen_asleep_ && !board.display.sleeping && board.backlight.brightness == 100);
    for (int second = 0; second < 120; ++second) app.SleepScreen();
    assert(!app.is_screen_asleep_);
    // Unplugging allows normal sleep again.
    board.power.status = 0;
    app.SleepScreen();
    assert(app.is_screen_asleep_ && board.display.sleeping);
}
'''.replace('DETECTOR', function('main/boards/common/axp2101.cc', 'Axp2101::IsExternalPowerConnected')).replace('SLEEP', function('main/application.cc', 'Application::SleepScreen'))

with tempfile.TemporaryDirectory(prefix='plugged-sleep-') as directory:
    source = Path(directory) / 'check.cc'
    binary = Path(directory) / 'check'
    source.write_text(program)
    subprocess.run(['clang++', *compiler_flags(), '-std=c++17', str(source), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
print('PASS: plugged-in watches stay awake, full batteries stay awake, unplugged watches sleep.')
