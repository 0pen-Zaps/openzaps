#!/bin/bash
# Install Campaign 2 maintenance as a separate, least-authority LaunchAgent.
#
#   ./executor/install-campaign2-launchd.sh watch-only
#   ./executor/install-campaign2-launchd.sh enable  # broadcast authorization boundary
#   ./executor/install-campaign2-launchd.sh remove
set -euo pipefail
umask 077
PATH="/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

LABEL="com.openzaps.campaign2-keeper"
MODE="${1:-watch-only}"
REPO="$(cd "$(/usr/bin/dirname "$0")/.." && /bin/pwd -P)"
TEMPLATE_SOURCE="$REPO/executor/$LABEL.plist.template"
LAUNCHER_SOURCE="$REPO/executor/campaign2-launcher.sh"
BUNDLE_VERIFY="$REPO/scripts/verify-campaign2-bundle.mjs"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(/usr/bin/id -u)"
OPENZAPS_STATE_ROOT="$HOME/.openzaps"
STATE_HOME="$OPENZAPS_STATE_ROOT/campaign2-keeper"
RELEASES_HOME="$STATE_HOME/releases"
RUNTIMES_HOME="$STATE_HOME/runtimes"
BUNDLE_SOURCE="$REPO/executor/dist/campaign2-keeper"
CURRENT_UID="$(/usr/bin/id -u)"
PLIST_TMP=""
RELEASE_TMP=""
RUNTIME_TMP=""

cleanup() {
  if [[ -n "$PLIST_TMP" && -f "$PLIST_TMP" ]]; then /bin/rm -f "$PLIST_TMP"; fi
  if [[ -n "$RELEASE_TMP" && -d "$RELEASE_TMP" ]]; then /bin/rm -rf "$RELEASE_TMP"; fi
  if [[ -n "$RUNTIME_TMP" && -d "$RUNTIME_TMP" ]]; then /bin/rm -rf "$RUNTIME_TMP"; fi
}
trap cleanup EXIT

file_sha256() {
  /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'
}

job_loaded() {
  /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1
}

stop_loaded_job() {
  if job_loaded; then
    if ! /bin/launchctl bootout "$DOMAIN/$LABEL"; then
      if job_loaded; then
        echo "could not stop the loaded $LABEL job" >&2
        exit 1
      fi
    fi
  fi
  if job_loaded; then
    echo "$LABEL is still loaded; refusing to replace or remove its plist" >&2
    exit 1
  fi
}

require_owned_directory() {
  local path="$1"
  local label="$2"
  if [[ ! -d "$path" || -L "$path" ]]; then
    echo "$label must be a non-symlinked directory" >&2
    exit 1
  fi
  if [[ "$(/usr/bin/stat -f '%u' "$path")" != "$CURRENT_UID" ]]; then
    echo "$label must be owned by the installer user" >&2
    exit 1
  fi
  local permissions
  permissions="$(/usr/bin/stat -f '%Lp' "$path")"
  if (( 8#$permissions & 8#077 )); then
    echo "$label must be owner-only" >&2
    exit 1
  fi
}

require_source_executable() {
  local path="$1"
  local label="$2"
  if [[ "$path" != /* || ! -f "$path" || -L "$path" || ! -x "$path" ]]; then
    echo "$label must be an absolute non-symlinked executable" >&2
    exit 1
  fi
  local owner permissions
  owner="$(/usr/bin/stat -f '%u' "$path")"
  permissions="$(/usr/bin/stat -f '%Lp' "$path")"
  if [[ "$owner" != "$CURRENT_UID" && "$owner" != "0" ]]; then
    echo "$label must be owned by the installer user or root" >&2
    exit 1
  fi
  if (( 8#$permissions & 8#022 )); then
    echo "$label must not be writable by group or others" >&2
    exit 1
  fi
}

require_protected_source_file() {
  local path="$1"
  local label="$2"
  if [[ "$path" != /* || ! -f "$path" || -L "$path" ]]; then
    echo "$label must be an absolute non-symlinked regular file" >&2
    exit 1
  fi
  local owner permissions
  owner="$(/usr/bin/stat -f '%u' "$path")"
  permissions="$(/usr/bin/stat -f '%Lp' "$path")"
  if [[ "$owner" != "$CURRENT_UID" && "$owner" != "0" ]]; then
    echo "$label must be owned by the installer user or root" >&2
    exit 1
  fi
  if (( 8#$permissions & 8#022 )); then
    echo "$label must not be writable by group or others" >&2
    exit 1
  fi
}

require_private_file() {
  local path="$1"
  local label="$2"
  if [[ "$path" != /* || ! -f "$path" || -L "$path" ]]; then
    echo "$label must point to an absolute non-symlinked regular file" >&2
    exit 1
  fi
  if [[ "$(/usr/bin/stat -f '%u' "$path")" != "$CURRENT_UID" ]]; then
    echo "$label must be owned by the installer user" >&2
    exit 1
  fi
  local permissions
  permissions="$(/usr/bin/stat -f '%Lp' "$path")"
  if (( 8#$permissions & 8#077 )); then
    echo "$label must not be accessible by group or others" >&2
    exit 1
  fi
}

install_hashed_runtime() {
  local source="$1"
  local expected_sha256="$2"
  local family="$3"
  local filename="$4"
  local target_dir="$RUNTIMES_HOME/$family-$expected_sha256"
  local target="$target_dir/$filename"
  if [[ -e "$target_dir" && ( ! -d "$target_dir" || -L "$target_dir" ) ]]; then
    echo "Campaign 2 runtime target is not a real directory: $target_dir" >&2
    exit 1
  fi
  if [[ ! -d "$target_dir" ]]; then
    RUNTIME_TMP="$(/usr/bin/mktemp -d "$RUNTIMES_HOME/.runtime.XXXXXX")"
    /bin/cp "$source" "$RUNTIME_TMP/$filename"
    /bin/chmod 500 "$RUNTIME_TMP" "$RUNTIME_TMP/$filename"
    if [[ "$(file_sha256 "$RUNTIME_TMP/$filename")" != "$expected_sha256" ]]; then
      echo "copied Campaign 2 $family runtime does not match its approved hash" >&2
      exit 1
    fi
    /bin/mv "$RUNTIME_TMP" "$target_dir"
    RUNTIME_TMP=""
  fi
  require_owned_directory "$target_dir" "Campaign 2 $family runtime directory"
  if [[ ! -f "$target" || -L "$target" || ! -x "$target" ]]; then
    echo "Campaign 2 $family runtime copy is missing or unsafe" >&2
    exit 1
  fi
  if [[ "$(/usr/bin/stat -f '%u' "$target")" != "$CURRENT_UID" \
     || "$(file_sha256 "$target")" != "$expected_sha256" ]]; then
    echo "Campaign 2 $family runtime copy failed ownership or hash verification" >&2
    exit 1
  fi
  local permissions
  permissions="$(/usr/bin/stat -f '%Lp' "$target")"
  if (( 8#$permissions & 8#077 )); then
    echo "Campaign 2 $family runtime copy must be owner-only" >&2
    exit 1
  fi
  printf '%s' "$target"
}

if [[ "$MODE" == "remove" ]]; then
  stop_loaded_job
  /bin/rm -f "$PLIST"
  echo "removed $LABEL; immutable releases, runtime copies, receipt state, and any signed pending bytes were retained"
  exit 0
fi
if [[ "$MODE" != "watch-only" && "$MODE" != "enable" ]]; then
  echo "use: $0 watch-only | enable | remove" >&2
  exit 2
fi

GIT_BIN="/usr/bin/git"
if [[ ! -x "$GIT_BIN" ]]; then
  echo "the system Git binary is unavailable" >&2
  exit 1
fi

EXPECTED_COMMIT="${OPENZAPS_CAMPAIGN2_EXPECTED_COMMIT:-}"
if [[ ! "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "installation requires an operator-approved OPENZAPS_CAMPAIGN2_EXPECTED_COMMIT" >&2
  exit 1
fi

NODE_SOURCE="${OPENZAPS_CAMPAIGN2_NODE_BIN:-}"
if [[ -z "$NODE_SOURCE" ]]; then
  for candidate in \
    "$HOME/.hermes/node/bin/node" \
    "/opt/homebrew/opt/node/bin/node" \
    "/usr/local/bin/node" \
    "/usr/bin/node"; do
    if [[ -f "$candidate" && ! -L "$candidate" && -x "$candidate" ]]; then
      NODE_SOURCE="$candidate"
      break
    fi
  done
fi
require_source_executable "$NODE_SOURCE" "OPENZAPS_CAMPAIGN2_NODE_BIN"
SOURCE_NODE_SHA256="$(file_sha256 "$NODE_SOURCE")"
EXPECTED_NODE_SHA256="${OPENZAPS_CAMPAIGN2_EXPECTED_NODE_SHA256:-}"
if [[ -n "$EXPECTED_NODE_SHA256" && ! "$EXPECTED_NODE_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "OPENZAPS_CAMPAIGN2_EXPECTED_NODE_SHA256 must be a lowercase SHA-256" >&2
  exit 1
fi
if [[ "$MODE" == "enable" && -z "$EXPECTED_NODE_SHA256" ]]; then
  echo "enable requires an operator-approved OPENZAPS_CAMPAIGN2_EXPECTED_NODE_SHA256" >&2
  exit 1
fi
if [[ -n "$EXPECTED_NODE_SHA256" && "$SOURCE_NODE_SHA256" != "$EXPECTED_NODE_SHA256" ]]; then
  echo "Node hash does not match OPENZAPS_CAMPAIGN2_EXPECTED_NODE_SHA256" >&2
  exit 1
fi

for artifact in index.mjs 254.index.mjs licenses.txt; do
  require_protected_source_file "$BUNDLE_SOURCE/$artifact" "committed Campaign 2 bundle artifact $artifact"
  "$GIT_BIN" -C "$REPO" ls-files --error-unmatch "executor/dist/campaign2-keeper/$artifact" \
    >/dev/null
done
require_protected_source_file "$LAUNCHER_SOURCE" "Campaign 2 pre-execution launcher"
require_protected_source_file "$TEMPLATE_SOURCE" "Campaign 2 launchd template"
require_protected_source_file "$BUNDLE_VERIFY" "Campaign 2 bundle verifier"
for source_file in \
  executor/campaign2-launcher.sh \
  executor/com.openzaps.campaign2-keeper.plist.template \
  scripts/verify-campaign2-bundle.mjs; do
  "$GIT_BIN" -C "$REPO" ls-files --error-unmatch "$source_file" >/dev/null
done
WORKTREE_STATUS="$("$GIT_BIN" -C "$REPO" status --porcelain --untracked-files=all)"
if [[ -n "$WORKTREE_STATUS" ]]; then
  echo "Campaign 2 installation requires a clean, committed worktree" >&2
  exit 1
fi
CURRENT_COMMIT="$("$GIT_BIN" -C "$REPO" rev-parse HEAD)"
if [[ "$CURRENT_COMMIT" != "$EXPECTED_COMMIT" ]]; then
  echo "current HEAD does not match OPENZAPS_CAMPAIGN2_EXPECTED_COMMIT" >&2
  exit 1
fi
APPROVED_COMMIT="$EXPECTED_COMMIT"

if [[ -e "$OPENZAPS_STATE_ROOT" && ( ! -d "$OPENZAPS_STATE_ROOT" || -L "$OPENZAPS_STATE_ROOT" ) ]]; then
  echo "$OPENZAPS_STATE_ROOT must be a real directory" >&2
  exit 1
fi
/bin/mkdir -p \
  "$OPENZAPS_STATE_ROOT" \
  "$STATE_HOME" \
  "$RELEASES_HOME" \
  "$RUNTIMES_HOME" \
  "$HOME/Library/LaunchAgents" \
  "$HOME/Library/Logs"
if [[ "$(/usr/bin/stat -f '%u' "$OPENZAPS_STATE_ROOT")" != "$CURRENT_UID" ]]; then
  echo "$OPENZAPS_STATE_ROOT must be owned by the installer user" >&2
  exit 1
fi
OPENZAPS_ROOT_PERMISSIONS="$(/usr/bin/stat -f '%Lp' "$OPENZAPS_STATE_ROOT")"
if (( 8#$OPENZAPS_ROOT_PERMISSIONS & 8#022 )); then
  echo "$OPENZAPS_STATE_ROOT must not be writable by group or others" >&2
  exit 1
fi
/bin/chmod 700 "$STATE_HOME" "$RELEASES_HOME" "$RUNTIMES_HOME"
require_owned_directory "$STATE_HOME" "Campaign 2 state directory"
require_owned_directory "$RELEASES_HOME" "Campaign 2 releases directory"
require_owned_directory "$RUNTIMES_HOME" "Campaign 2 runtimes directory"

NODE_BIN="$(install_hashed_runtime "$NODE_SOURCE" "$SOURCE_NODE_SHA256" "node" "node")"
"$NODE_BIN" "$BUNDLE_VERIFY"

BUNDLE_SHA256="$(file_sha256 "$BUNDLE_SOURCE/index.mjs")"
CHUNK_SHA256="$(file_sha256 "$BUNDLE_SOURCE/254.index.mjs")"
LICENSE_SHA256="$(file_sha256 "$BUNDLE_SOURCE/licenses.txt")"
LAUNCHER_SHA256="$(file_sha256 "$LAUNCHER_SOURCE")"
TEMPLATE_SHA256="$(file_sha256 "$TEMPLATE_SOURCE")"
NODE_SHA256="$(file_sha256 "$NODE_BIN")"
RELEASE_DIR="$RELEASES_HOME/$APPROVED_COMMIT"
if [[ -e "$RELEASE_DIR" && ( ! -d "$RELEASE_DIR" || -L "$RELEASE_DIR" ) ]]; then
  echo "Campaign 2 release target is not a real directory: $RELEASE_DIR" >&2
  exit 1
fi
if [[ ! -d "$RELEASE_DIR" ]]; then
  RELEASE_TMP="$(/usr/bin/mktemp -d "$RELEASES_HOME/.install.XXXXXX")"
  /bin/cp "$BUNDLE_SOURCE/index.mjs" "$RELEASE_TMP/index.mjs"
  /bin/cp "$BUNDLE_SOURCE/254.index.mjs" "$RELEASE_TMP/254.index.mjs"
  /bin/cp "$BUNDLE_SOURCE/licenses.txt" "$RELEASE_TMP/licenses.txt"
  /bin/cp "$LAUNCHER_SOURCE" "$RELEASE_TMP/campaign2-launcher.sh"
  /bin/cp "$TEMPLATE_SOURCE" "$RELEASE_TMP/$LABEL.plist.template"
  /bin/chmod 500 "$RELEASE_TMP" "$RELEASE_TMP/index.mjs" "$RELEASE_TMP/campaign2-launcher.sh"
  /bin/chmod 400 \
    "$RELEASE_TMP/254.index.mjs" \
    "$RELEASE_TMP/licenses.txt" \
    "$RELEASE_TMP/$LABEL.plist.template"
  /bin/mv "$RELEASE_TMP" "$RELEASE_DIR"
  RELEASE_TMP=""
fi
require_owned_directory "$RELEASE_DIR" "Campaign 2 release directory"
for artifact in \
  index.mjs \
  254.index.mjs \
  licenses.txt \
  campaign2-launcher.sh \
  "$LABEL.plist.template"; do
  if [[ ! -f "$RELEASE_DIR/$artifact" || -L "$RELEASE_DIR/$artifact" \
     || "$(/usr/bin/stat -f '%u' "$RELEASE_DIR/$artifact")" != "$CURRENT_UID" ]]; then
    echo "existing Campaign 2 release contains an unsafe $artifact" >&2
    exit 1
  fi
  RELEASE_FILE_PERMISSIONS="$(/usr/bin/stat -f '%Lp' "$RELEASE_DIR/$artifact")"
  if (( 8#$RELEASE_FILE_PERMISSIONS & 8#077 )); then
    echo "existing Campaign 2 release artifact $artifact is not owner-only" >&2
    exit 1
  fi
done
if [[ "$(file_sha256 "$RELEASE_DIR/index.mjs")" != "$BUNDLE_SHA256" \
   || "$(file_sha256 "$RELEASE_DIR/254.index.mjs")" != "$CHUNK_SHA256" \
   || "$(file_sha256 "$RELEASE_DIR/licenses.txt")" != "$LICENSE_SHA256" \
   || "$(file_sha256 "$RELEASE_DIR/campaign2-launcher.sh")" != "$LAUNCHER_SHA256" \
   || "$(file_sha256 "$RELEASE_DIR/$LABEL.plist.template")" != "$TEMPLATE_SHA256" ]]; then
  echo "existing Campaign 2 release copy does not match the approved commit" >&2
  exit 1
fi
TEMPLATE="$RELEASE_DIR/$LABEL.plist.template"

plist_value() {
  printf '%s' "$1" \
    | /usr/bin/sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' \
    | /usr/bin/sed 's/[\\&|]/\\&/g'
}

ENABLED="false"
KEYSTORE_FILE_PLIST=""
PASSWORD_FILE_PLIST=""
CAST_BIN_PLIST=""
CAST_SHA256=""
AUTOMATE_BURNS="false"
ARCHIVE_RPC_FILE_PLIST=""
ARCHIVE_RPC_FILE="${OPENZAPS_CAMPAIGN2_ARCHIVE_RPC_FILE:-}"
if [[ -n "$ARCHIVE_RPC_FILE" ]]; then
  require_private_file "$ARCHIVE_RPC_FILE" "OPENZAPS_CAMPAIGN2_ARCHIVE_RPC_FILE"
  ARCHIVE_RPC_FILE_PLIST="$(plist_value "$ARCHIVE_RPC_FILE")"
fi
if [[ "$MODE" == "enable" ]]; then
  KEYSTORE_FILE="${OPENZAPS_CAMPAIGN2_KEYSTORE_FILE:-$HOME/.openzaps/keeper/49a14080-18e6-487e-9f1b-b109a7acf074}"
  PASSWORD_FILE="${OPENZAPS_CAMPAIGN2_PASSWORD_FILE:-$HOME/.openzaps/keeper/keeper.pass}"
  CAST_SOURCE="${OPENZAPS_CAMPAIGN2_CAST_BIN:-}"
  if [[ -z "$CAST_SOURCE" ]]; then
    for candidate in "$HOME/.foundry/bin/cast" "/opt/homebrew/bin/cast" "/usr/local/bin/cast"; do
      if [[ -f "$candidate" && ! -L "$candidate" && -x "$candidate" ]]; then
        CAST_SOURCE="$candidate"
        break
      fi
    done
  fi
  require_private_file "$KEYSTORE_FILE" "campaign-2 encrypted keystore"
  require_private_file "$PASSWORD_FILE" "campaign-2 password file"
  require_source_executable "$CAST_SOURCE" "OPENZAPS_CAMPAIGN2_CAST_BIN"
  EXPECTED_CAST_SHA256="${OPENZAPS_CAMPAIGN2_EXPECTED_CAST_SHA256:-}"
  if [[ ! "$EXPECTED_CAST_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
    echo "enable requires an operator-approved OPENZAPS_CAMPAIGN2_EXPECTED_CAST_SHA256" >&2
    exit 1
  fi
  ACTUAL_CAST_SHA256="$(file_sha256 "$CAST_SOURCE")"
  if [[ "$ACTUAL_CAST_SHA256" != "$EXPECTED_CAST_SHA256" ]]; then
    echo "Cast hash does not match OPENZAPS_CAMPAIGN2_EXPECTED_CAST_SHA256" >&2
    exit 1
  fi
  CAST_BIN="$(install_hashed_runtime "$CAST_SOURCE" "$EXPECTED_CAST_SHA256" "cast" "cast")"
  AUTOMATE_BURNS="${OPENZAPS_CAMPAIGN2_AUTOMATE_BURNS:-false}"
  if [[ "$AUTOMATE_BURNS" != "true" && "$AUTOMATE_BURNS" != "false" ]]; then
    echo "OPENZAPS_CAMPAIGN2_AUTOMATE_BURNS must be true or false" >&2
    exit 1
  fi
  if [[ "$AUTOMATE_BURNS" == "true" && -z "$ARCHIVE_RPC_FILE" ]]; then
    echo "automated burns require OPENZAPS_CAMPAIGN2_ARCHIVE_RPC_FILE pointing to an owner-only file" >&2
    exit 1
  fi
  # Only the owner-only hash-addressed Cast copy receives the password path.
  KEEPER_ADDRESS="$("$CAST_BIN" wallet address --keystore "$KEYSTORE_FILE" --password-file "$PASSWORD_FILE")"
  KEEPER_ADDRESS_LOWER="$(printf '%s' "$KEEPER_ADDRESS" | /usr/bin/tr '[:upper:]' '[:lower:]')"
  if [[ "$KEEPER_ADDRESS_LOWER" != "0xa2b7dce7cbf773462e4338a9e0403c53437e9bec" ]]; then
    echo "encrypted keystore does not recover the pinned Campaign 2 keeper" >&2
    exit 1
  fi
  ENABLED="true"
  KEYSTORE_FILE_PLIST="$(plist_value "$KEYSTORE_FILE")"
  PASSWORD_FILE_PLIST="$(plist_value "$PASSWORD_FILE")"
  CAST_BIN_PLIST="$(plist_value "$CAST_BIN")"
  CAST_SHA256="$EXPECTED_CAST_SHA256"
fi

LAUNCHER_PLIST="$(plist_value "$RELEASE_DIR/campaign2-launcher.sh")"
NODE_PLIST="$(plist_value "$NODE_BIN")"
PROGRAM_PLIST="$(plist_value "$RELEASE_DIR/index.mjs")"
RELEASE_DIR_PLIST="$(plist_value "$RELEASE_DIR")"
HOME_PLIST="$(plist_value "$HOME")"
PLIST_TMP="$(/usr/bin/mktemp "$HOME/Library/LaunchAgents/.$LABEL.XXXXXX")"
/usr/bin/sed -e "s|__LAUNCHER__|$LAUNCHER_PLIST|g" \
  -e "s|__NODE__|$NODE_PLIST|g" \
  -e "s|__PROGRAM__|$PROGRAM_PLIST|g" \
  -e "s|__RELEASE_DIR__|$RELEASE_DIR_PLIST|g" \
  -e "s|__HOME__|$HOME_PLIST|g" \
  -e "s|__ENABLED__|$ENABLED|g" \
  -e "s|__KEYSTORE_FILE__|$KEYSTORE_FILE_PLIST|g" \
  -e "s|__PASSWORD_FILE__|$PASSWORD_FILE_PLIST|g" \
  -e "s|__CAST_BIN__|$CAST_BIN_PLIST|g" \
  -e "s|__APPROVED_COMMIT__|$APPROVED_COMMIT|g" \
  -e "s|__BUNDLE_SHA256__|$BUNDLE_SHA256|g" \
  -e "s|__CHUNK_SHA256__|$CHUNK_SHA256|g" \
  -e "s|__LICENSE_SHA256__|$LICENSE_SHA256|g" \
  -e "s|__NODE_SHA256__|$NODE_SHA256|g" \
  -e "s|__CAST_SHA256__|$CAST_SHA256|g" \
  -e "s|__AUTOMATE_BURNS__|$AUTOMATE_BURNS|g" \
  -e "s|__ARCHIVE_RPC_FILE__|$ARCHIVE_RPC_FILE_PLIST|g" \
  "$TEMPLATE" > "$PLIST_TMP"

/usr/bin/plutil -lint "$PLIST_TMP" >/dev/null
stop_loaded_job
/bin/mv "$PLIST_TMP" "$PLIST"
PLIST_TMP=""
if ! /bin/launchctl bootstrap "$DOMAIN" "$PLIST"; then
  if job_loaded; then stop_loaded_job; fi
  /bin/rm -f "$PLIST"
  echo "launchctl could not bootstrap $LABEL; no launchd policy remains installed" >&2
  exit 1
fi
if ! job_loaded; then
  /bin/rm -f "$PLIST"
  echo "$LABEL was not registered after bootstrap; its plist was removed" >&2
  exit 1
fi

echo "installed $LABEL in $MODE mode at commit $APPROVED_COMMIT"
echo "  artifact: $RELEASE_DIR/index.mjs"
echo "  Node SHA: $NODE_SHA256"
echo "  logs:     $HOME/Library/Logs/openzaps-campaign2-keeper.log"
echo "  state:    $STATE_HOME/state.json"
if [[ "$MODE" == "enable" ]]; then
  echo "  live signing is enabled; this command was the broadcast authorization boundary"
  echo "  HOOKR burns: $AUTOMATE_BURNS"
fi
