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
SECRET_CONFIG_FILE="${OPENZAPS_EXECUTOR_SECRET_CONFIG_FILE:-}"

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

mkdir -p "$HOME/.openzaps/executor" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

# Escape XML first, then escape sed replacement metacharacters. This prevents an unusual but valid
# local path from injecting additional LaunchAgent keys.
plist_value() {
  printf '%s' "$1" \
    | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' \
    | sed 's/[\\&|]/\\&/g'
}

NODE_PLIST="$(plist_value "$NODE_BIN")"
REPO_PLIST="$(plist_value "$REPO")"
HOME_PLIST="$(plist_value "$HOME")"
SECRET_CONFIG_KEY_PLIST=""
SECRET_CONFIG_VALUE_PLIST=""

if [[ -n "$SECRET_CONFIG_FILE" ]]; then
  # Validate before replacing or loading an agent. The validator never prints file contents,
  # endpoints, or Authorization values. It also rejects legacy provider JSON env vars when this
  # file-based source is selected.
  OPENZAPS_EXECUTOR_SECRET_CONFIG_FILE="$SECRET_CONFIG_FILE" \
    "$NODE_BIN" "$REPO/executor/secret-config.mjs"
  SECRET_CONFIG_KEY_PLIST="        <key>OPENZAPS_EXECUTOR_SECRET_CONFIG_FILE</key>"
  SECRET_CONFIG_VALUE_PLIST="        <string>$(plist_value "$SECRET_CONFIG_FILE")</string>"
elif [[ -n "${OPENZAPS_EXECUTOR_KEYFILE:-}" || -n "${OPENZAPS_EXECUTOR_PRIVATE_KEY:-}" ]]; then
  echo "refusing signer-related install without OPENZAPS_EXECUTOR_SECRET_CONFIG_FILE" >&2
  exit 1
fi

umask 077
sed -e "s|__NODE__|$NODE_PLIST|g" \
  -e "s|__REPO__|$REPO_PLIST|g" \
  -e "s|__HOME__|$HOME_PLIST|g" \
  -e "s|__SECRET_CONFIG_KEY__|$SECRET_CONFIG_KEY_PLIST|g" \
  -e "s|__SECRET_CONFIG_VALUE__|$SECRET_CONFIG_VALUE_PLIST|g" \
  "$TEMPLATE" > "$PLIST"

launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL"

echo "installed $LABEL"
echo "  logs:    $HOME/Library/Logs/openzaps-executor.log"
echo "  intents: $HOME/.openzaps/executor/intents/"
echo "  mode:    watch-only (no executor signer key installed)"
echo "  status:  launchctl print $DOMAIN/$LABEL | head -20"
