#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
repo_root="$(git -C "$project_root" rev-parse --show-toplevel)"
source "$project_root/lib/common.sh"
source "$project_root/lib/sealed-carrier.sh"

carrier_dir="${OLIPHAUNT_WASIX_POSTMASTER_CARRIER_DIR:-}"
release_target="${OLIPHAUNT_WASIX_POSTMASTER_RELEASE_TARGET:-}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --carrier-dir)
      shift
      [ "$#" -gt 0 ] || { echo '--carrier-dir requires a directory' >&2; exit 2; }
      [ -z "$carrier_dir" ] || {
        echo 'select the carrier with either the environment or --carrier-dir, not both' >&2
        exit 2
      }
      carrier_dir="$1"
      ;;
    --target)
      shift
      [ "$#" -gt 0 ] || { echo '--target requires a release target' >&2; exit 2; }
      [ -z "$release_target" ] || {
        echo 'select the target with either the environment or --target, not both' >&2
        exit 2
      }
      release_target="$1"
      ;;
    *)
      echo 'usage: package-release-assets.sh [--carrier-dir DIR] [--target TARGET]' >&2
      exit 2
      ;;
  esac
  shift
done

if [ -z "$release_target" ]; then
  release_target="$(fresh_release_target)"
fi
expected_target_triple="$(fresh_release_target_triple "$release_target")"
actual_release_target="$(fresh_release_target)"
[ "$release_target" = "$actual_release_target" ] || {
  printf 'release target %s does not match this host (%s)\n' \
    "$release_target" "$actual_release_target" >&2
  exit 2
}

if [ -z "$carrier_dir" ]; then
  carrier_dir="$(fresh_select_current_sealed_carrier)"
fi

[ -d "$carrier_dir" ] && [ ! -L "$carrier_dir" ] || {
  printf 'carrier is not a regular directory: %s\n' "$carrier_dir" >&2
  exit 2
}
carrier_dir="$(cd "$carrier_dir" && pwd -P)"
"$project_root/bin/verify-sealed-headless-carrier.sh" "$carrier_dir"
python3 - "$carrier_dir/manifest.json" "$expected_target_triple" <<'PY'
import json
import pathlib
import sys

manifest = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
if manifest.get("target-triple") != sys.argv[2]:
    raise SystemExit(
        "sealed carrier target differs from release target: "
        f"expected {sys.argv[2]}, got {manifest.get('target-triple')!r}"
    )
PY

version="$(tr -d '\r\n' <"$project_root/VERSION")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  printf 'invalid product version: %s\n' "$version" >&2
  exit 2
}

asset_dir="$repo_root/target/oliphaunt-wasix-postmaster/release-assets"
mkdir -p "$asset_dir"
asset_name="liboliphaunt-wasix-postmaster-$version-$release_target.tar.zst"
[ ! -e "$asset_dir/$asset_name" ] || {
  echo 'refusing to overwrite existing WASIX postmaster release assets' >&2
  exit 2
}

stage_root="$(mktemp -d "$repo_root/target/oliphaunt-wasix-postmaster/.release-stage.XXXXXX")"
cleanup() {
  chmod -R u+w "$stage_root" 2>/dev/null || true
  rm -rf -- "$stage_root"
}
trap cleanup EXIT HUP INT TERM

package_root="$stage_root/liboliphaunt-wasix-postmaster-$version-$release_target"
mkdir -p "$package_root/bin" "$package_root/carrier"
cp -a "$carrier_dir/." "$package_root/carrier/"
cp -p "$project_root/bin/run-release-carrier.sh" \
  "$package_root/bin/oliphaunt-wasix-postmaster"
chmod 0555 "$package_root/bin/oliphaunt-wasix-postmaster"
cp -p "$repo_root/LICENSE" "$package_root/LICENSE"
cp -p "$repo_root/THIRD_PARTY_NOTICES.md" "$package_root/THIRD_PARTY_NOTICES.md"
cp -p "$project_root/README.md" "$package_root/README.md"

"$repo_root/tools/dev/bun.sh" "$repo_root/tools/release/archive_dir.mjs" \
  --keep-parent "$package_root" "$asset_dir/$asset_name"
asset_sha256="$(fresh_wasmer_bin_hash "$asset_dir/$asset_name")"
asset_size="$(wc -c <"$asset_dir/$asset_name" | tr -d '[:space:]')"
chmod 0444 "$asset_dir/$asset_name"

printf 'packaged WASIX postmaster release asset: %s (%s bytes, %s)\n' \
  "$asset_dir/$asset_name" "$asset_size" "$asset_sha256"
