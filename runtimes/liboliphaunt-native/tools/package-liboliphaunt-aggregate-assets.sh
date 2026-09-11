#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "package-liboliphaunt-aggregate-assets.sh: must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

fail() {
  echo "package-liboliphaunt-aggregate-assets.sh: $*" >&2
  exit 1
}

asset_dir="${OLIPHAUNT_LIBOLIPHAUNT_RELEASE_ASSETS:-target/liboliphaunt/release-assets}"
[ -d "$asset_dir" ] || fail "missing liboliphaunt release asset directory: $asset_dir"

version="$(tools/dev/bun.sh tools/release/product-version.mts version liboliphaunt-native)"
checksum_file="$asset_dir/liboliphaunt-${version}-release-assets.sha256"

tools/packaging/write-checksum-manifest.mts \
  --asset-dir "$asset_dir" \
  --output "$(basename "$checksum_file")" \
  --pattern '*.tar.gz' \
  --pattern '*.tar.zst' \
  --pattern '*.zip' \
  --pattern '*.tsv'

tools/dev/bun.sh runtimes/liboliphaunt-native/tools/check-release-assets.mts --asset-dir "$asset_dir"
