#!/bin/bash
# Verify every executable Campaign 2 artifact before Node evaluates the bundle.
set -euo pipefail
PATH="/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

if [[ "$#" -ne 7 ]]; then
  echo "campaign-2 launcher received an invalid immutable argument set" >&2
  exit 64
fi

NODE_BIN="$1"
ENTRY="$2"
EXPECTED_BUNDLE_SHA256="$3"
EXPECTED_CHUNK_SHA256="$4"
EXPECTED_LICENSE_SHA256="$5"
EXPECTED_NODE_SHA256="$6"
COMMAND="$7"
CHUNK="${ENTRY%/*}/254.index.mjs"
LICENSES="${ENTRY%/*}/licenses.txt"
CURRENT_UID="$(/usr/bin/id -u)"

file_sha256() {
  /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'
}

require_runtime_file() {
  local path="$1"
  local label="$2"
  if [[ "$path" != /* || ! -f "$path" || -L "$path" ]]; then
    echo "$label must be an absolute non-symlinked regular file" >&2
    exit 1
  fi
  if [[ "$(/usr/bin/stat -f '%u' "$path")" != "$CURRENT_UID" ]]; then
    echo "$label must be owned by the launchd user" >&2
    exit 1
  fi
  local permissions
  permissions="$(/usr/bin/stat -f '%Lp' "$path")"
  if (( 8#$permissions & 8#022 )); then
    echo "$label must not be writable by group or others" >&2
    exit 1
  fi
}

if [[ "$COMMAND" != "start" ]]; then
  echo "campaign-2 launcher permits only the start command" >&2
  exit 64
fi
for digest in \
  "$EXPECTED_BUNDLE_SHA256" \
  "$EXPECTED_CHUNK_SHA256" \
  "$EXPECTED_LICENSE_SHA256" \
  "$EXPECTED_NODE_SHA256"; do
  if [[ ! "$digest" =~ ^[0-9a-f]{64}$ ]]; then
    echo "campaign-2 launcher received a malformed SHA-256 pin" >&2
    exit 1
  fi
done

require_runtime_file "$NODE_BIN" "campaign-2 Node runtime"
require_runtime_file "$ENTRY" "campaign-2 entry bundle"
require_runtime_file "$CHUNK" "campaign-2 bundle chunk"
require_runtime_file "$LICENSES" "campaign-2 bundle license manifest"
if [[ ! -x "$NODE_BIN" || ! -x "$ENTRY" ]]; then
  echo "campaign-2 Node and entry bundle must be owner-executable" >&2
  exit 1
fi

if [[ "$(file_sha256 "$NODE_BIN")" != "$EXPECTED_NODE_SHA256" \
   || "$(file_sha256 "$ENTRY")" != "$EXPECTED_BUNDLE_SHA256" \
   || "$(file_sha256 "$CHUNK")" != "$EXPECTED_CHUNK_SHA256" \
   || "$(file_sha256 "$LICENSES")" != "$EXPECTED_LICENSE_SHA256" ]]; then
  echo "campaign-2 pre-execution runtime hash mismatch" >&2
  exit 1
fi

exec "$NODE_BIN" "$ENTRY" "$COMMAND"
