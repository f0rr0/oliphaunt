#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
bun="$(command -v bun)"
export OLIPHAUNT_BROKER_LICENSE_TEST_ROOT
OLIPHAUNT_BROKER_LICENSE_TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$OLIPHAUNT_BROKER_LICENSE_TEST_ROOT"' EXIT
scratch="$OLIPHAUNT_BROKER_LICENSE_TEST_ROOT"
mkdir -p "$scratch/empty-path" "$scratch/empty-cargo-home" "$scratch/offline"
contract=broker/tools/broker-dependency-license-contract.mts
PATH="$scratch/empty-path" CARGO_HOME="$scratch/empty-cargo-home" \
  "$bun" "$contract" stage "$scratch/offline" --target linux-x64-gnu
"$bun" "$contract" check-directory "$scratch/offline" --target linux-x64-gnu

version="$("$bun" tools/release/product-version.mts version oliphaunt-broker)"
"$bun" broker/tools/create-release-fixture.mts --asset-dir "$scratch/assets" --version "$version"
package() {
  PATH="$scratch/empty-path" CARGO_HOME="$scratch/empty-cargo-home" \
    "$bun" broker/tools/package_broker_cargo_artifacts.mts \
    --asset-dir "$scratch/assets" --output-dir "$scratch/cargo-$1" \
    --source-output-dir "$scratch/source-$1" --version "$version" \
    > "$scratch/package-$1.log" 2>&1
}
package a & first=$!
package b & second=$!
status=0
wait "$first" || status=1
wait "$second" || status=1
if [ "$status" -ne 0 ]; then
  cat "$scratch/package-a.log" "$scratch/package-b.log" >&2
  exit "$status"
fi
mkdir -p "$scratch/extracted"
for crate in "$scratch/cargo-a/"*.crate; do
  tar -xzf "$crate" -C "$scratch/extracted"
  package_name="$(basename "$crate" .crate)"
  OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD=1 cargo check --offline \
    --manifest-path "$scratch/extracted/$package_name/Cargo.toml" \
    --target-dir "$scratch/cargo-check"
done
"$bun" test --timeout=30000 ./broker/tools/broker-dependency-license-contract.test.mts
