#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
version="$(bun ../../tools/release/product-version.mts version oliphaunt-query-ts)"
destination="$PWD/../../target/sdk-artifacts/oliphaunt-query-ts"
rm -rf "$destination"
mkdir -p "$destination"
bun pm pack --filename "$destination/oliphaunt-ts-query-$version.tgz"
bun ../../tools/packaging/staging.mts "$destination"
