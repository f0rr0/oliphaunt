#!/usr/bin/env bash
set -euo pipefail
[[ $# == 2 ]] || { echo 'usage: audit-rust-dependency-licenses.sh <owner-contract.mts> <cargo-package>' >&2; exit 2; }
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
helper=$1
package=$2
[[ -f "$helper" && "$helper" != /* && "$helper" != -* && "$helper" != *..* ]] || { echo 'contract must be a repository-relative file' >&2; exit 2; }
[[ "$package" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo 'invalid Cargo package' >&2; exit 2; }
scratch=$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-rust-licenses-XXXXXX")
scratch=$(cd "$scratch" && pwd -P)
trap 'rm -rf "$scratch"' EXIT
bun "$helper" audit-targets > "$scratch/targets"
# Cache the locked platform closure; the audit reads actual source license bytes.
CARGO_NET_OFFLINE=false cargo fetch --locked
cargo metadata --locked --offline --format-version 1 | head -c 134217729 > "$scratch/metadata.json"
while IFS= read -r cargo_target; do
  cargo tree -p "$package" --locked --offline -e normal --target "$cargo_target" \
    --prefix none --format '{p}' | head -c 134217729 > "$scratch/$cargo_target.tree"
done < "$scratch/targets"
bun "$helper" audit-contract "$scratch"
