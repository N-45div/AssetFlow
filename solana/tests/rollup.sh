#!/usr/bin/env bash
# Start MagicBlock's local stack for the private-holdings tests:
#   Solana        http://127.0.0.1:8899  AssetFlow, Token ACL, SAS, and MagicBlock's
#                                        delegation, committor and permission programs
#   rollup        http://127.0.0.1:7799  an ephemeral rollup validator
#   read filter   http://127.0.0.1:6699  the query filtering service: private accounts
#                                        are readable only by their permission's members,
#                                        the role the TEE endpoint plays on devnet; it answers
#                                        browsers too, for the app on localnet
#
#   wsl bash solana/build.sh --features local-rollup   # private holdings accept the local validator
#   wsl bash solana/tests/rollup.sh                    # run in the foreground; Ctrl-C stops it
#   wsl bash solana/tests/rollup.sh --stop             # stop a running one
#
# The rollup validator and the filtering service come from npm; MagicBlock's
# programs and test accounts are fetched once from MagicBlock's repositories
# at pinned versions. Token ACL and SAS are copied from devnet, as in
# validator.sh. None of this is a TEE: nothing here attests anything.
set -euo pipefail

export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="${CARGO_TARGET_DIR:-$HOME/assetflow-target}"
SO="$TARGET/sbpf-solana-solana/release/assetflow.so"
LEDGER="${LEDGER:-$HOME/assetflow-ledger}"
MB="$TARGET/magicblock"
TOKEN_ACL_ID="TACLkU6CiCdkQN2MjoyDkVg2yAH9zkxiHDsiztQ52TP"
SAS_ID="22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG"

# MagicBlock's releases these files are pinned to.
VALIDATOR_REPO="https://raw.githubusercontent.com/magicblock-labs/magicblock-validator"
VALIDATOR_TAG="v0.14.10"
COMMITTOR_COMMIT="0bf0863f" # committor-program/bin is not in the tag
ESPL_REPO="https://raw.githubusercontent.com/magicblock-labs/ephemeral-spl-token"
ESPL_COMMIT="1d4564a" # e-token/tests/fixtures/acl.so: the permission program
ER_NPM="@magicblock-labs/ephemeral-validator-linux-x64@0.14.10"
QFS_NPM="@magicblock-labs/query-filtering-service-linux-x64@0.1.3"

stop() {
  pkill -x query-filtering 2>/dev/null || true
  pkill -x ephemeral-valid 2>/dev/null || true
  pkill -x solana-test-val 2>/dev/null || true
}
if [ "${1:-}" = "--stop" ]; then
  stop
  echo "stopped"
  exit 0
fi

[ -f "$SO" ] || { echo "missing $SO — run: wsl bash solana/build.sh --features local-rollup"; exit 1; }
mkdir -p "$MB/accounts"

fetch() { [ -f "$2" ] || curl -sSfL -o "$2" "$1"; }
fetch "$VALIDATOR_REPO/$VALIDATOR_TAG/test-integration/schedulecommit/elfs/dlp.so" "$MB/dlp.so"
fetch "$VALIDATOR_REPO/$VALIDATOR_TAG/test-integration/schedulecommit/elfs/noop.so" "$MB/noop.so"
fetch "$VALIDATOR_REPO/$COMMITTOR_COMMIT/committor-program/bin/magicblock_committor_program.so" "$MB/committor.so"
fetch "$ESPL_REPO/$ESPL_COMMIT/e-token/tests/fixtures/acl.so" "$MB/acl.so"
ACCOUNTS=(validator-authority luzid-authority validator-fees-vault protocol-fees-vault magic-fee-vault magic-fee-vault-delegation-record)
for name in "${ACCOUNTS[@]}"; do
  fetch "$VALIDATOR_REPO/$VALIDATOR_TAG/test-integration/configs/accounts/$name.json" "$MB/accounts/$name.json"
done
for pkg in "$ER_NPM" "$QFS_NPM"; do
  dir="$MB/$(echo "$pkg" | sed 's|.*/||; s|@.*||')"
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir"
    (cd "$dir" && tar xzf "$(npm pack --silent "$pkg")" --strip-components=1)
  fi
done
for pair in "$TOKEN_ACL_ID:$TARGET/token_acl.so" "$SAS_ID:$TARGET/sas.so"; do
  id="${pair%%:*}" so="${pair#*:}"
  [ -f "$so" ] || solana program dump -u "${SOLANA_DEVNET_RPC_URL:-https://api.devnet.solana.com}" "$id" "$so"
done

# The rollup signs as MagicBlock's public test validator, mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev,
# whose key MagicBlock publishes in its integration tests.
fetch "$VALIDATOR_REPO/$VALIDATOR_TAG/test-integration/test-tools/src/loaded_accounts.rs" "$MB/loaded_accounts.rs"
VALIDATOR_KEY="$(node -e '
  const src = require("fs").readFileSync(process.argv[1], "utf8");
  const bytes = src.match(/TEST_KEYPAIR_BYTES: \[u8; 64\] = \[([^\]]+)\]/)[1].split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt("0x" + Buffer.from(bytes).toString("hex")), out = "";
  while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b) break; out = "1" + out; }
  process.stdout.write(out);
' "$MB/loaded_accounts.rs")"

cat > "$MB/rollup.toml" <<EOF
lifecycle = "ephemeral"
remotes = ["http://127.0.0.1:8899", "ws://127.0.0.1:8900"]

[aperture]
listen = "127.0.0.1:7799"

[ledger]
reset = true
EOF

stop
trap stop EXIT INT TERM
# tr: a Windows checkout gives lib.rs CRLF endings, and a trailing \r makes the id unparseable
ID="$(sed -nE 's/^declare_id!\("([^"]+)"\);/\1/p' "$HERE/../programs/assetflow/src/lib.rs" | tr -d '\r')"
echo "assetflow at $ID"
ACCOUNT_ARGS=()
for name in "${ACCOUNTS[@]}"; do ACCOUNT_ARGS+=(--account - "$MB/accounts/$name.json"); done
solana-test-validator --reset --quiet --ledger "$LEDGER" \
  --bpf-program "$ID" "$SO" \
  --bpf-program "$TOKEN_ACL_ID" "$TARGET/token_acl.so" \
  --bpf-program "$SAS_ID" "$TARGET/sas.so" \
  --bpf-program DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh "$MB/dlp.so" \
  --bpf-program ComtrB2KEaWgXsW1dhr1xYL4Ht4Bjj3gXnnL6KMdABq "$MB/committor.so" \
  --bpf-program noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV "$MB/noop.so" \
  --bpf-program ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1 "$MB/acl.so" \
  "${ACCOUNT_ARGS[@]}" > "$MB/solana.log" 2>&1 &

# The rollup sets itself up against Solana on start, so Solana must be past
# its first slots, not merely answering.
for _ in $(seq 1 60); do
  [ "$(solana -u http://127.0.0.1:8899 slot 2>/dev/null || echo 0)" -gt 20 ] && break
  sleep 1
done

# The rollup raises its open-file limit to 1,000,000; where the hard limit is
# lower (containers, some WSL setups) a small preload lowers the request.
PRELOAD=""
if [ "$(ulimit -Hn)" != "unlimited" ] && [ "$(ulimit -Hn)" -lt 1000000 ] && command -v gcc >/dev/null; then
  cat > "$MB/nofile.c" <<'EOF'
#define _GNU_SOURCE
#include <dlfcn.h>
#include <sys/resource.h>
int setrlimit(__rlimit_resource_t res, const struct rlimit *rl) {
    int (*real)(__rlimit_resource_t, const struct rlimit *) = dlsym(RTLD_NEXT, "setrlimit");
    if (res == RLIMIT_NOFILE) {
        struct rlimit cur, c = *rl;
        getrlimit(RLIMIT_NOFILE, &cur);
        if (c.rlim_max > cur.rlim_max) c.rlim_max = cur.rlim_max;
        if (c.rlim_cur > c.rlim_max) c.rlim_cur = c.rlim_max;
        return real(res, &c);
    }
    return real(res, rl);
}
EOF
  gcc -shared -fPIC -o "$MB/nofile.so" "$MB/nofile.c" -ldl
  PRELOAD="$MB/nofile.so"
fi
LD_PRELOAD="$PRELOAD" "$MB/ephemeral-validator-linux-x64/bin/ephemeral-validator" "$MB/rollup.toml" \
  --no-tui --storage "$MB/rollup-storage" --keypair "$VALIDATOR_KEY" > "$MB/rollup.log" 2>&1 &
for _ in $(seq 1 60); do
  curl -sf -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' \
    http://127.0.0.1:7799 >/dev/null && break
  sleep 1
done

(cd "$MB" && "$MB/query-filtering-service-linux-x64/bin/query-filtering-service" \
  --listen-addr 127.0.0.1:6699 --listen-addr-ws 127.0.0.1:6700 \
  --ephemeral-url http://127.0.0.1:7799 --ephemeral-url-ws ws://127.0.0.1:7800 \
  --validator-kp "$VALIDATOR_KEY" --add-cors-headers > "$MB/filter.log" 2>&1) &

echo "Solana :8899, rollup :7799, read filter :6699 (logs in $MB)"
wait
