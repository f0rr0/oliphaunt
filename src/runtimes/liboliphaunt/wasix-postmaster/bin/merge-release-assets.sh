#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
repo_root="$(git -C "$project_root" rev-parse --show-toplevel)"
asset_dir="${OLIPHAUNT_WASIX_POSTMASTER_RELEASE_ASSET_DIR:-$repo_root/target/oliphaunt-wasix-postmaster/release-assets}"
version="$(tr -d '\r\n' <"$project_root/VERSION")"
checksum="$asset_dir/liboliphaunt-wasix-postmaster-$version-release-assets.sha256"
targets=(linux-x64-gnu macos-arm64)

[ -d "$asset_dir" ] && [ ! -L "$asset_dir" ] || {
  printf 'missing regular WASIX postmaster release asset directory: %s\n' "$asset_dir" >&2
  exit 2
}
[ ! -e "$checksum" ] || {
  printf 'refusing to overwrite release checksum: %s\n' "$checksum" >&2
  exit 2
}

temporary="$checksum.tmp.$$"
trap 'rm -f -- "$temporary"' EXIT HUP INT TERM
: >"$temporary"
for target in "${targets[@]}"; do
  archive="liboliphaunt-wasix-postmaster-$version-$target.tar.gz"
  [ -f "$asset_dir/$archive" ] && [ ! -L "$asset_dir/$archive" ] || {
    printf 'missing regular WASIX postmaster release archive: %s\n' "$archive" >&2
    exit 2
  }
  printf '%s  %s\n' "$(
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum "$asset_dir/$archive" | awk '{print $1}'
    else
      shasum -a 256 "$asset_dir/$archive" | awk '{print $1}'
    fi
  )" "$archive" >>"$temporary"
done
mv "$temporary" "$checksum"
trap - EXIT HUP INT TERM
chmod 0444 "$checksum"
printf 'merged WASIX postmaster release assets: %s\n' "$checksum"
