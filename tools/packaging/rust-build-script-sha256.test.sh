#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
scratch=$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-rust-hash-XXXXXX")
trap 'rm -rf "$scratch"' EXIT
bun tools/packaging/rust-build-script-sha256.test.mts prepare "$scratch"
rustc --edition 2024 -o "$scratch/sha256-fixture" "$scratch/main.rs"
for fixture in "$scratch"/fixture-*.bin; do
  "$scratch/sha256-fixture" "$fixture" > "$fixture.sha256"
done
bun tools/packaging/rust-build-script-sha256.test.mts verify "$scratch"
