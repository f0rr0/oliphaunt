#!/usr/bin/env bash
set -euo pipefail
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"
. src/wasix/runtime/tools/runtime-preflight.sh
oliphaunt_runtime_wasm_require
export OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD=1
export OLIPHAUNT_WASIX_GENERATED_ASSETS_DIR="$root/target/oliphaunt-wasix/assets"
export OLIPHAUNT_WASM_GENERATED_AOT_DIR="$root/target/oliphaunt-wasix/aot"
version="$(cat src/database-resources/VERSION)"
export OLIPHAUNT_TEST_STANDARD_SEED="$root/target/database-resources/release-assets/database-resources-$version-seed-wasix-standard.tar.zst"
export OLIPHAUNT_TEST_ICU_SEED="$root/target/database-resources/release-assets/database-resources-$version-seed-wasix-icu.tar.zst"
OLIPHAUNT_TEST_ICU_ROOT="$(mktemp -d)"
export OLIPHAUNT_TEST_ICU_ROOT
trap 'rm -rf "$OLIPHAUNT_TEST_ICU_ROOT"' EXIT
tar -xzf "$root/target/database-resources/release-assets/database-resources-$version-icu-data.tar.gz" -C "$OLIPHAUNT_TEST_ICU_ROOT"
cargo test -p oliphaunt-wasix --locked --test resources --color never -- --ignored --test-threads=1 \
  2>&1 | tee "$OLIPHAUNT_TEST_ICU_ROOT/tests.log"
grep -Eq '^test result: ok\. [1-9][0-9]* passed;' "$OLIPHAUNT_TEST_ICU_ROOT/tests.log" || {
  echo 'WASIX resource tests must execute and pass' >&2
  exit 1
}
