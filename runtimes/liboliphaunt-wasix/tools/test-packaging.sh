#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
export OLIPHAUNT_WASIX_PACKAGING_TEST_ROOT OLIPHAUNT_TEST_RUST_HOST
OLIPHAUNT_WASIX_PACKAGING_TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$OLIPHAUNT_WASIX_PACKAGING_TEST_ROOT"' EXIT
OLIPHAUNT_TEST_RUST_HOST="$(rustc --print host-tuple)"
contract=runtimes/liboliphaunt-wasix/tools/wasix-cargo-artifact-contract.mts
bun "$contract" all > "$OLIPHAUNT_WASIX_PACKAGING_TEST_ROOT/targets.tsv"
while IFS=$'\t' read -r triple artifact target; do
  expected="$triple"$'\t'"$artifact"$'\t'"$target"
  [[ "$(bun "$contract" "$target")" == "$expected" ]]
  [[ "$(bun "$contract" "$triple")" == "$expected" ]]
done < "$OLIPHAUNT_WASIX_PACKAGING_TEST_ROOT/targets.tsv"
if bun "$contract" unsupported > /dev/null 2>&1; then
  echo 'Unsupported AOT download target was accepted' >&2
  exit 1
fi
bun test --timeout=30000 ./runtimes/liboliphaunt-wasix/tools
node runtimes/liboliphaunt-wasix/tools/wasix-runtime-npm.test-consumer.mts
for scenario in nested-owner aggregate; do
  root="$OLIPHAUNT_WASIX_PACKAGING_TEST_ROOT/$scenario"
  # Keep registry dependencies at the qualified workspace versions; this
  # disposable consumer only changes local carrier paths and feature selection.
  cp Cargo.lock "$root/app/Cargo.lock"
  cargo fetch --manifest-path "$root/app/Cargo.toml"
  CARGO_TARGET_DIR="$OLIPHAUNT_WASIX_PACKAGING_TEST_ROOT/cargo-target" \
    OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT="$root" \
    cargo run --locked --offline --manifest-path "$root/app/Cargo.toml"
done
root="$OLIPHAUNT_WASIX_PACKAGING_TEST_ROOT/aggregate"
chunk="$(find "$root/work/cargo-package-sources/oliphaunt-extension-contrib-pg18-wasix-part-001/payload" -type f -print -quit)"
printf 'corrupt' >> "$chunk"
if CARGO_TARGET_DIR="$OLIPHAUNT_WASIX_PACKAGING_TEST_ROOT/cargo-target" \
  OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT="$root" \
  cargo check --locked --offline --manifest-path "$root/app/Cargo.toml" > "$root/corrupt.log" 2>&1; then
  echo 'Corrupt extracted extension payload was accepted' >&2
  exit 1
fi
rg -q 'extension payload digest mismatch' "$root/corrupt.log"
