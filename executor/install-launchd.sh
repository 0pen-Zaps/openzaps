#!/bin/bash
# Install (or remove) the OpenZaps executor as a macOS LaunchAgent.
#   ./install-launchd.sh          install + start
#   ./install-launchd.sh remove   stop + uninstall
set -euo pipefail

LABEL="com.openzaps.executor"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$REPO/executor/$LABEL.plist.template"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if [[ "${1:-}" == "remove" ]]; then
  launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL"
  exit 0
fi

NODE_BIN="$(command -v node)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node not found in PATH" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__REPO__|$REPO|g" -e "s|__HOME__|$HOME|g" \
  "$TEMPLATE" > "$PLIST"

launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL"

echo "installed $LABEL"
echo "  logs:    $HOME/Library/Logs/openzaps-executor.log"
echo "  intents: $HOME/.openzaps/executor/intents/"
echo "  status:  launchctl print $DOMAIN/$LABEL | head -20"
