#!/usr/bin/env bash
# Install (or reinstall) the listener as a macOS background service.
#
# The device dials this Mac at boot and again whenever a call starts, so a
# listener living in a terminal window leaves it with nothing to talk to.
#
# Everything machine-specific is worked out here rather than committed: the
# checkout path, and where bun lives. Nothing personal ends up in the repo.
set -euo pipefail

LABEL="local.esp32-voice-mode"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${ESP32_VOICE_PORT:-8790}"

BUN="$(command -v bun || true)"
if [ -z "$BUN" ]; then
  echo "bun is not on PATH. Install it from https://bun.sh and try again." >&2
  exit 1
fi

# Machine-specific Codex settings are passed through from this shell rather
# than committed, so nobody else inherits one person's model or plugin list.
PASSTHROUGH=""
for name in VOICEMODE_CODEX_MODEL VOICEMODE_CODEX_DISABLE_MCP VOICEMODE_CODEX_BIN; do
  eval "value=\${$name:-}"
  if [ -n "$value" ]; then
    PASSTHROUGH="$PASSTHROUGH
    <key>$name</key><string>$value</string>"
  fi
done

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BUN</string><string>run</string><string>src/listener.ts</string>
    <string>--port</string><string>$PORT</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$(dirname "$BUN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <!-- Voice sessions sometimes come up with a healthy event channel and no
         audio on it. This asks the Codex app-server to say what its realtime
         module is doing, which is the only place that can tell "no audio was
         produced" apart from "audio was produced and never arrived". -->
    <key>RUST_LOG</key><string>codex_core::realtime_conversation=trace,codex_realtime=trace</string>$PASSTHROUGH
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/tmp/esp32-voice-mode.log</string>
  <key>StandardErrorPath</key><string>/tmp/esp32-voice-mode.err.log</string>
</dict>
</plist>
PLISTEOF

plutil -lint "$PLIST" >/dev/null
# bootout is not synchronous: bootstrapping while the old job is still on its
# way out fails with a bare "Input/output error", so wait for it to go.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
  sleep 1
done
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "Installed $LABEL"
echo "  logs:  tail -f /tmp/esp32-voice-mode.log"
echo "  stop:  launchctl bootout gui/$(id -u)/$LABEL"
