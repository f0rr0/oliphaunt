#!/usr/bin/env bash
set -euo pipefail
[[ $# == 0 ]] || { echo 'usage: audit-dependency-licenses.sh' >&2; exit 2; }
cd "$(dirname "${BASH_SOURCE[0]}")/../../../.."
helper=src/runtimes/broker/tools/broker-dependency-license-contract.mts
scratch=$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-broker-license-XXXXXX")
scratch=$(cd "$scratch" && pwd -P)
trap 'rm -rf "$scratch"' EXIT
bun "$helper" audit-targets > "$scratch/targets"
# No --target: cache every locked platform dependency. Existing cache entries
# are reused; the audit verifies their actual legal bytes, not their presence.
CARGO_NET_OFFLINE=false cargo fetch --locked
cargo metadata --locked --offline --format-version 1 | head -c 134217729 > "$scratch/metadata.json"
while IFS= read -r cargo_target; do
  cargo tree -p oliphaunt-broker --locked --offline -e normal --target "$cargo_target" \
    --prefix none --format '{p}' | head -c 134217729 > "$scratch/$cargo_target.tree"
done < "$scratch/targets"
bun "$helper" audit-contract "$scratch"
