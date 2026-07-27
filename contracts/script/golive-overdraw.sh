#!/usr/bin/env bash
#
# Deploy OVERDRAW to Robinhood Chain and immediately verify the deployment.
#
# The two steps are welded together on purpose. Deploying is easy and verifying is
# the part that gets skipped, so this script refuses to report success unless the
# smoke check passes against the contract that was actually just deployed.
#
#   ./script/golive-overdraw.sh --account nodar-deployer
#
# Everything after the script name is passed straight to `forge script` as signer
# flags, so a keystore, a Ledger (`--ledger`), or a Trezor all work unchanged.
# No key is ever read, stored, or echoed by this script.
#
# Overridable for a fork rehearsal:
#   RPC=http://127.0.0.1:8546 ./script/golive-overdraw.sh --private-key 0x...
#
set -euo pipefail

RPC="${RPC:-https://rpc.mainnet.chain.robinhood.com}"
# Immutable once broadcast. Receives the rake every round, and its bps doubles as
# the carry pool's drain rate.
export OVERDRAW_RAKE_RECIPIENT="${OVERDRAW_RAKE_RECIPIENT:-0x5a52D4B820Ae7F02880d270562950918ACb14aA2}"
OUT_FILE="${OUT_FILE:-/tmp/overdraw-deployed.txt}"

if [ "$#" -eq 0 ]; then
  echo "error: pass signer flags, e.g. --account nodar-deployer" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

echo "==> chain $(cast chain-id --rpc-url "$RPC")  rake recipient $OVERDRAW_RAKE_RECIPIENT"
echo "==> 1/3 deploying"

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

forge script script/DeployOverdraw.s.sol:DeployOverdraw \
  --rpc-url "$RPC" --broadcast "$@" 2>&1 | tee "$log"

# Read the address back out of the script's own readback line, which it printed
# from the deployed contract rather than from its constructor arguments.
address="$(grep -Eo 'ZapOverdraw[[:space:]]+0x[0-9a-fA-F]{40}' "$log" | tail -1 | grep -Eo '0x[0-9a-fA-F]{40}')"
if [ -z "${address:-}" ]; then
  echo "FAILED: could not find a deployed address in the broadcast output" >&2
  exit 1
fi

echo
echo "==> 2/3 deployed at $address — verifying"

# The gate. A non-zero exit here means DO NOT go live.
if ! OVERDRAW_ADDRESS="$address" forge script script/SmokeOverdraw.s.sol:SmokeOverdraw --rpc-url "$RPC"; then
  echo >&2
  echo "SMOKE FAILED for $address — do NOT set NEXT_PUBLIC_OVERDRAW_ADDRESS" >&2
  exit 1
fi

printf '%s\n' "$address" > "$OUT_FILE"

echo
echo "==> 3/3 done"
echo
echo "    OVERDRAW is live at: $address"
echo "    (also written to $OUT_FILE)"
echo
echo "    Remaining: set NEXT_PUBLIC_OVERDRAW_ADDRESS=$address in Vercel and redeploy."
echo "    Until that is set, /overdraw stays fail-closed and nobody can reach the game."
