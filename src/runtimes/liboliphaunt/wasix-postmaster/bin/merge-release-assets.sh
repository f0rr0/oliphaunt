#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
repo_root="$(git -C "$project_root" rev-parse --show-toplevel)"
asset_dir="${OLIPHAUNT_WASIX_POSTMASTER_RELEASE_ASSET_DIR:-$repo_root/target/oliphaunt-wasix-postmaster/release-assets}"
version="$(tr -d '\r\n' <"$project_root/VERSION")"

exec "$repo_root/tools/dev/bun.sh" \
  "$repo_root/tools/release/merge-product-release-assets.mjs" \
  --product liboliphaunt-wasix-postmaster \
  --version "$version" \
  --asset-dir "$asset_dir"
