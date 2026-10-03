#!/usr/bin/env bash
# Build the AssetFlow Solana program.
#
#   wsl bash solana/build.sh          # compile to SBF
#   wsl bash solana/build.sh --ids    # print the program id and exit
#   wsl bash solana/build.sh --features local-rollup
#                                     # a build for tests/rollup.sh: private holdings
#                                     # also accept MagicBlock's local validator
#
# Run from WSL. The Rust target directory stays on the Linux filesystem:
# building under /mnt/c goes through the 9p bridge and is many times slower.
# The program keypair lives beside the build output, not in the repo: it is a
# deploy authority, not source.
set -euo pipefail

export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
HERE="$(cd "$(dirname "$0")" && pwd)"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/assetflow-target}"
DEPLOY="$CARGO_TARGET_DIR/deploy"
mkdir -p "$DEPLOY"

for tool in cargo solana-keygen cargo-build-sbf; do
  command -v "$tool" >/dev/null || { echo "missing $tool"; exit 1; }
done

key="$DEPLOY/assetflow-keypair.json"
[ -f "$key" ] || solana-keygen new --no-bip39-passphrase --silent -o "$key"
id="$(solana-keygen pubkey "$key")"
# Keep declare_id! in step with the keypair that will deploy it; a mismatch
# only surfaces at deploy time, as DeclaredProgramIdMismatch.
sed -i -E "s/^declare_id!\(\"[^\"]+\"\);/declare_id!(\"$id\");/" "$HERE/programs/assetflow/src/lib.rs"
echo "assetflow = $id"

[ "${1:-}" = "--ids" ] && exit 0

cd "$HERE"
cargo build-sbf "$@"
ls -la "$CARGO_TARGET_DIR"/sbpf*/release/assetflow.so 2>/dev/null || ls -la "$DEPLOY"/*.so
