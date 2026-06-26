#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"
source "$root/tools/release/liboliphaunt-extension-guard.sh"

fail() {
  echo "package-liboliphaunt-macos-assets.sh: $*" >&2
  exit 1
}

fetch_release_source_assets() {
  if [ "${OLIPHAUNT_RELEASE_FETCH_ASSETS:-1}" = "0" ]; then
    return 0
  fi
  echo "==> Fetching pinned source assets"
  bun tools/policy/fetch-sources.mjs native-runtime >/tmp/liboliphaunt-release-macos-assets-fetch.log
}

if [ "$(uname -s)" != "Darwin" ]; then
  fail "macOS liboliphaunt release assets must be built on macOS"
fi

case "$(uname -m)" in
  arm64|aarch64) target_id="macos-arm64" ;;
  *) fail "unsupported macOS architecture $(uname -m)" ;;
esac

version="$(python3 tools/release/product_metadata.py version liboliphaunt-native)"
command -v bun >/dev/null 2>&1 || fail "missing required command: bun"
out_dir="${OLIPHAUNT_LIBOLIPHAUNT_RELEASE_ASSETS:-$root/target/liboliphaunt/release-assets}"
stage_root="$root/target/liboliphaunt/release-stage-$target_id"
work_root="${OLIPHAUNT_WORK_ROOT:-$root/target/liboliphaunt-pg18}"
headers_dir="$root/src/runtimes/liboliphaunt/native/include"
lib="$work_root/out/liboliphaunt.dylib"
embedded_modules="$work_root/out/modules"
runtime="$work_root/install"
stage="$stage_root/liboliphaunt-${version}-${target_id}"
asset="liboliphaunt-${version}-${target_id}.tar.gz"
tools_stage="$stage_root/oliphaunt-tools-${version}-${target_id}"
tools_asset="oliphaunt-tools-${version}-${target_id}.tar.gz"
catalog_file="$stage_root/extension-catalog.tsv"

rm -rf "$stage_root"
mkdir -p "$out_dir" "$stage/include" "$stage/lib" "$stage/runtime" "$tools_stage/runtime/bin"

fetch_release_source_assets

echo "==> Building liboliphaunt $target_id"
OLIPHAUNT_BUILD_EXTENSIONS="${OLIPHAUNT_BUILD_EXTENSIONS:-0}" \
  src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh >/tmp/liboliphaunt-release-"$target_id".log

[ -f "$lib" ] || fail "missing macOS liboliphaunt dylib at $lib"
[ -f "$embedded_modules/plpgsql.dylib" ] || fail "missing macOS embedded plpgsql module at $embedded_modules/plpgsql.dylib"
for tool in initdb pg_ctl pg_dump postgres psql; do
  [ -x "$runtime/bin/$tool" ] || fail "missing macOS $tool at $runtime/bin/$tool"
done

echo "==> Verifying base liboliphaunt $target_id runtime is extension-clean"
cargo run -p oliphaunt --bin oliphaunt-resources --locked -- --list-extensions >"$catalog_file"
oliphaunt_assert_base_runtime_has_no_optional_extensions "$catalog_file" "$runtime" ||
  fail "base $target_id runtime must not ship optional extension assets"

rsync -a --delete "$headers_dir/" "$stage/include/"
cp "$lib" "$stage/lib/"
rsync -a --delete "$embedded_modules/" "$stage/lib/modules/"
rsync -a --delete --exclude 'share/icu/***' "$runtime/" "$stage/runtime/"
for tool in pg_dump psql; do
  cp -p "$runtime/bin/$tool" "$tools_stage/runtime/bin/"
done

echo "==> Optimizing staged liboliphaunt $target_id release payload"
python3 tools/release/optimize_native_runtime_payload.py "$stage" --target "$target_id" --tool-set runtime

echo "==> Optimizing staged oliphaunt-tools $target_id release payload"
python3 tools/release/optimize_native_runtime_payload.py "$tools_stage" --target "$target_id" --tool-set tools

echo "==> Smoke testing staged liboliphaunt $target_id release layout"
env \
  OLIPHAUNT_WORK_ROOT="$work_root" \
  LIBOLIPHAUNT_PATH="$stage/lib/liboliphaunt.dylib" \
  OLIPHAUNT_INSTALL_DIR="$stage/runtime" \
  OLIPHAUNT_SMOKE_BIN_DIR="$stage_root/smoke-bin-$target_id" \
  OLIPHAUNT_SMOKE_ROOT="$stage_root/smoke-root-$target_id" \
  node src/runtimes/liboliphaunt/native/tools/run-host-c-smoke.mjs

tools/release/archive_dir.mjs "$stage" "$out_dir/$asset"
tools/release/archive_dir.mjs "$tools_stage" "$out_dir/$tools_asset"
echo "liboliphauntMacosReleaseAsset=$out_dir/$asset"
echo "oliphauntToolsMacosReleaseAsset=$out_dir/$tools_asset"
