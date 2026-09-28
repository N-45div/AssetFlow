#!/usr/bin/env bash
# Start a local validator with AssetFlow and Token ACL loaded.
#
#   wsl bash solana/tests/validator.sh          # run in the foreground
#   wsl bash solana/tests/validator.sh --stop   # stop a running one
#
# Token ACL is the Solana Foundation's deployed program, not a build of ours:
# it is copied once from devnet (SOLANA_DEVNET_RPC_URL, else the public
# endpoint) and loaded at its real address, so the tests exercise the same
# binary the asset will use.
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

if [ "${1:-}" = "--stop" ]; then
  pkill -x solana-test-val && echo "stopped" || echo "not running"
  exit 0
fi

[ -f "$SO" ] || { echo "missing $SO — run: wsl bash solana/build.sh"; exit 1; }
if [ ! -f "$TOKEN_ACL_SO" ]; then
  solana program dump -u "${SOLANA_DEVNET_RPC_URL:-https://api.devnet.solana.com}" "$TOKEN_ACL_ID" "$TOKEN_ACL_SO"
fi

ID="$(solana-keygen pubkey "$TARGET/deploy/assetflow-keypair.json")"
echo "assetflow at $ID"
exec solana-test-validator --reset --quiet --ledger "$LEDGER" \
  --bpf-program "$ID" "$SO" \
  --bpf-program "$TOKEN_ACL_ID" "$TOKEN_ACL_SO"
