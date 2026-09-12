#!/usr/bin/env bash
set -euo pipefail
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"
version="$(cat database-resources/VERSION)"
export OLIPHAUNT_TEST_STANDARD_SEED="$root/target/database-resources/release-assets/database-resources-$version-seed-wasix-standard.tar.zst"
export OLIPHAUNT_TEST_ICU_SEED="$root/target/database-resources/release-assets/database-resources-$version-seed-wasix-icu.tar.zst"
OLIPHAUNT_TEST_ICU_ROOT="$(mktemp -d)"
export OLIPHAUNT_TEST_ICU_ROOT
trap 'rm -rf "$OLIPHAUNT_TEST_ICU_ROOT"' EXIT
tar -xzf "$root/target/database-resources/release-assets/database-resources-$version-icu-data.tar.gz" -C "$OLIPHAUNT_TEST_ICU_ROOT"
cargo test -p oliphaunt-wasix --locked --test resources -- --ignored --test-threads=1
