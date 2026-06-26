#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

fail() {
  echo "package-liboliphaunt-linux-assets.sh: $*" >&2
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

source "$root/tools/release/liboliphaunt-extension-guard.sh"

fetch_release_source_assets() {
  if [ "${OLIPHAUNT_RELEASE_FETCH_ASSETS:-1}" = "0" ]; then
    return 0
  fi
  echo "==> Fetching pinned source assets"
  bun tools/policy/fetch-sources.mjs native-runtime >/tmp/liboliphaunt-release-linux-assets-fetch.log
}

if [ "$(uname -s)" != "Linux" ]; then
  fail "Linux liboliphaunt release assets must be built on Linux"
fi

case "$(uname -m)" in
  x86_64|amd64) target_id="linux-x64-gnu" ;;
  aarch64|arm64) target_id="linux-arm64-gnu" ;;
  *) fail "unsupported Linux architecture $(uname -m)" ;;
esac

require cargo
require bun
require python3

version="$(python3 tools/release/product_metadata.py version liboliphaunt-native)"
out_dir="${OLIPHAUNT_LIBOLIPHAUNT_RELEASE_ASSETS:-$root/target/liboliphaunt/release-assets}"
stage_root="$root/target/liboliphaunt/release-stage-$target_id"
work_root="${OLIPHAUNT_LINUX_WORK_ROOT:-$root/target/liboliphaunt-pg18-$target_id}"
headers_dir="$root/src/runtimes/liboliphaunt/native/include"
lib="$work_root/out/liboliphaunt.so"
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
src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh >/tmp/liboliphaunt-release-"$target_id".log

[ -f "$lib" ] || fail "missing Linux liboliphaunt shared library at $lib"
[ -f "$embedded_modules/plpgsql.so" ] || fail "missing Linux embedded plpgsql module at $embedded_modules/plpgsql.so"
for tool in initdb pg_ctl pg_dump postgres psql; do
  [ -x "$runtime/bin/$tool" ] || fail "missing Linux $tool at $runtime/bin/$tool"
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
  LIBOLIPHAUNT_PATH="$stage/lib/liboliphaunt.so" \
  OLIPHAUNT_INSTALL_DIR="$stage/runtime" \
  OLIPHAUNT_SMOKE_BIN_DIR="$stage_root/smoke-bin-$target_id" \
  OLIPHAUNT_SMOKE_ROOT="$stage_root/smoke-root-$target_id" \
  node src/runtimes/liboliphaunt/native/tools/run-host-c-smoke.mjs

tools/release/archive_dir.mjs "$stage" "$out_dir/$asset"
tools/release/archive_dir.mjs "$tools_stage" "$out_dir/$tools_asset"
echo "liboliphauntLinuxReleaseAsset=$out_dir/$asset"
echo "oliphauntToolsLinuxReleaseAsset=$out_dir/$tools_asset"
