#!/usr/bin/env bash
# Start a local validator with AssetFlow and Token ACL loaded.
#
#   wsl bash solana/tests/validator.sh          # run in the foreground
#   wsl bash solana/tests/validator.sh --stop   # stop a running one
#   wsl bash solana/tests/validator.sh --faucet-port 9911
#                                               # extra flags go to solana-test-validator
#
# Token ACL and the Solana Attestation Service are the Solana Foundation's
# deployed programs, not builds of ours: each is copied once from devnet
# (SOLANA_DEVNET_RPC_URL, else the public endpoint) and loaded at its real
# address, so the tests exercise the same binaries the asset will use.
#
# The ledger stays on the Linux filesystem; under /mnt/c the validator writes
# through the 9p bridge and misses its slot timing.
set -euo pipefail

export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="${CARGO_TARGET_DIR:-$HOME/assetflow-target}"
SO="$TARGET/sbpf-solana-solana/release/assetflow.so"
LEDGER="${LEDGER:-$HOME/assetflow-ledger}"
TOKEN_ACL_ID="TACLkU6CiCdkQN2MjoyDkVg2yAH9zkxiHDsiztQ52TP"
TOKEN_ACL_SO="$TARGET/token_acl.so"
SAS_ID="22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG"
SAS_SO="$TARGET/sas.so"

if [ "${1:-}" = "--stop" ]; then
  pkill -x solana-test-val && echo "stopped" || echo "not running"
  exit 0
fi

[ -f "$SO" ] || { echo "missing $SO — run: wsl bash solana/build.sh"; exit 1; }
for pair in "$TOKEN_ACL_ID:$TOKEN_ACL_SO" "$SAS_ID:$SAS_SO"; do
  id="${pair%%:*}" so="${pair#*:}"
  [ -f "$so" ] || solana program dump -u "${SOLANA_DEVNET_RPC_URL:-https://api.devnet.solana.com}" "$id" "$so"
done

ID="$(solana-keygen pubkey "$TARGET/deploy/assetflow-keypair.json")"
echo "assetflow at $ID"
exec solana-test-validator --reset --quiet --ledger "$LEDGER" \
  --bpf-program "$ID" "$SO" \
  --bpf-program "$TOKEN_ACL_ID" "$TOKEN_ACL_SO" \
  --bpf-program "$SAS_ID" "$SAS_SO" "$@"
