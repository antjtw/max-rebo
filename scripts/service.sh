#!/usr/bin/env bash
# Install or remove Cantina as a launchd user agent (SPEC §15.2, §14: restarted if it crashes).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
LABEL="com.cantina.console"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$ROOT/data/logs"

if [[ "$(uname)" != "Darwin" ]]; then echo "launchd services are macOS only."; exit 1; fi

case "${1:-}" in
  install)
    mkdir -p "$LOGS" "$(dirname "$PLIST")"
    NODE="$(command -v node)"
    NPM="$(command -v npm)"
    npm run build -w @cantina/dashboard >/dev/null
    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>ProgramArguments</key>
  <array>
    <string>$ROOT/node_modules/.bin/tsx</string>
    <string>apps/core/src/main.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE"):$(dirname "$NPM"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$LOGS/cantina.log</string>
  <key>StandardErrorPath</key><string>$LOGS/cantina.err.log</string>
</dict>
</plist>
PLIST
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "Installed. Cantina starts at login and restarts if it crashes."
    echo "Console: http://127.0.0.1:4242 · logs: $LOGS (decisions only, never speech)"
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed the Cantina service."
    ;;
  *)
    echo "Usage: scripts/service.sh install|uninstall"; exit 1 ;;
esac
