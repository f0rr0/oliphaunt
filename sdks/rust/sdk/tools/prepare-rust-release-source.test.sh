#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
export OLIPHAUNT_RUST_RELEASE_SOURCE_TEST_ROOT
mkdir -p target
OLIPHAUNT_RUST_RELEASE_SOURCE_TEST_ROOT="$(mktemp -d "$PWD/target/rust-release-source-test-XXXXXX")"
trap 'rm -rf "$OLIPHAUNT_RUST_RELEASE_SOURCE_TEST_ROOT"' EXIT
bun sdks/rust/sdk/tools/prepare-rust-release-source.test-inputs.mts
for owner in sdk build; do
  root="$OLIPHAUNT_RUST_RELEASE_SOURCE_TEST_ROOT/$owner"
  bash tools/packaging/package-cargo-source.sh "$root/source/Cargo.toml" "$root/crate"
done
bun test --timeout=30000 ./sdks/rust/sdk/tools/prepare-rust-release-source.test.mts
