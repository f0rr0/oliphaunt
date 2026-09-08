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

source "$root/src/runtimes/liboliphaunt/native/tools/liboliphaunt-extension-guard.sh"

fetch_release_source_assets() {
  if [ "${OLIPHAUNT_RELEASE_FETCH_ASSETS:-1}" = "0" ]; then
    return 0
  fi
  echo "==> Fetching pinned source assets"
  bash src/sources/tools/fetch-sources.sh native-runtime >/tmp/liboliphaunt-release-linux-assets-fetch.log
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

version="$(tools/dev/bun.sh src/shared/product-metadata/product-version.mts version liboliphaunt-native)"
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

if [ "${OLIPHAUNT_RELEASE_BUILD_RUNTIME:-1}" = "1" ]; then
  echo "==> Building liboliphaunt $target_id"
  src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh >/tmp/liboliphaunt-release-"$target_id".log
fi

[ -f "$lib" ] || fail "missing Linux liboliphaunt shared library at $lib"
oliphaunt_assert_base_embedded_modules_exact "$embedded_modules" so ||
  fail "base $target_id embedded module inventory must contain only regular dict_snowball.so and plpgsql.so modules"
for tool in initdb pg_basebackup pg_ctl pg_dump postgres psql; do
  [ -x "$runtime/bin/$tool" ] || fail "missing Linux $tool at $runtime/bin/$tool"
done

echo "==> Verifying base liboliphaunt $target_id runtime is extension-clean"
cargo run -p oliphaunt-native-packaging --bin oliphaunt-resources --locked -- --list-extensions >"$catalog_file"
oliphaunt_assert_base_runtime_has_no_optional_extensions "$catalog_file" "$runtime" ||
  fail "base $target_id runtime must not ship optional extension assets"

rsync -a --delete "$headers_dir/" "$stage/include/"
cp "$lib" "$stage/lib/"
rsync -a --delete "$embedded_modules/" "$stage/lib/modules/"
rsync -a --delete \
  --exclude '/bin/pg_dump' \
  --exclude '/bin/pg_basebackup' \
  --exclude '/bin/psql' \
  --exclude 'share/icu/***' \
  "$runtime/" "$stage/runtime/"
bash src/runtimes/liboliphaunt/native/tools/stage-native-cluster-seed.sh \
  --runtime "$runtime" \
  --destination "$stage/cluster-seed" \
  --target "$target_id" \
  --profile standard
bash src/runtimes/liboliphaunt/native/tools/stage-native-cluster-seed.sh \
  --runtime "$runtime" \
  --destination "$stage/cluster-seed-icu" \
  --target "$target_id" \
  --profile icu \
  --icu-data "$work_root/icu/share/icu"
if [ ! -f "$stage/runtime/manifest.properties" ]; then
  manifest_work="$stage/runtime-manifest"
  OLIPHAUNT_INSTALL_DIR="$runtime" OLIPHAUNT_EMBEDDED_MODULE_DIR="$embedded_modules" \
    cargo run -p oliphaunt-native-packaging --bin oliphaunt-resources --locked -- \
      --output "$manifest_work" --mode native-direct --force
  cp "$manifest_work/oliphaunt/runtime/manifest.properties" "$stage/runtime/manifest.properties"
  rm -rf "$manifest_work"
fi
tools/dev/bun.sh src/runtimes/liboliphaunt/native/tools/finalize-native-runtime-carrier.mts \
  --root "$stage" \
  --target "$target_id" \
  --icu-data "$work_root/icu/share/icu"
for tool in pg_basebackup pg_dump psql; do
  cp -p "$runtime/bin/$tool" "$tools_stage/runtime/bin/"
done

# PostgreSQL installs versioned shared-library aliases as symlinks. Release
# archives are link-free consumer inputs, so materialize only validated,
# relative aliases that remain inside the staged tree.
tools/dev/bun.sh src/shared/artifact-packaging/materialize-release-symlinks.mts "$stage"

echo "==> Optimizing staged liboliphaunt $target_id release payload"
tools/dev/bun.sh src/runtimes/liboliphaunt/native/tools/native-runtime-payload.mts "$stage" --target "$target_id" --tool-set runtime

echo "==> Optimizing staged oliphaunt-tools $target_id release payload"
tools/dev/bun.sh src/runtimes/liboliphaunt/native/tools/native-runtime-payload.mts "$tools_stage" --target "$target_id" --tool-set tools

bash src/shared/artifact-packaging/strip-native-binaries.sh --target "$target_id" "$stage" "$tools_stage"

echo "==> Verifying staged $target_id binary compatibility"
tools/dev/bun.sh src/shared/artifact-packaging/platform-binary-contract.mts --target "$target_id" --root "$stage"
tools/dev/bun.sh src/shared/artifact-packaging/platform-binary-contract.mts --target "$target_id" --root "$tools_stage"
src/shared/artifact-packaging/check-linux-consumer-baseline.sh --target "$target_id" --root "$stage"
src/shared/artifact-packaging/check-linux-consumer-baseline.sh \
  --target "$target_id" \
  --root "$tools_stage" \
  --library-root "$stage"

tools/dev/bun.sh src/shared/artifact-packaging/release-notices.mts stage "$stage" --profile native-runtime
tools/dev/bun.sh src/shared/artifact-packaging/release-notices.mts stage "$tools_stage" --profile native-tools

echo "==> Smoke testing staged liboliphaunt $target_id release layout"
env \
  OLIPHAUNT_WORK_ROOT="$work_root" \
  LIBOLIPHAUNT_PATH="$stage/lib/liboliphaunt.so" \
  OLIPHAUNT_INSTALL_DIR="$stage/runtime" \
  OLIPHAUNT_SMOKE_BIN_DIR="$stage_root/smoke-bin-$target_id" \
  OLIPHAUNT_SMOKE_ROOT="$stage_root/smoke-root-$target_id" \
  OLIPHAUNT_STANDARD_CLUSTER_SEED="$stage/cluster-seed" \
  OLIPHAUNT_ICU_CLUSTER_SEED="$stage/cluster-seed-icu" \
  OLIPHAUNT_ICU_DATA_DIR="$work_root/icu/share/icu" \
  bash src/runtimes/liboliphaunt/native/tools/run-host-c-smoke.sh --cluster-seeds

src/shared/artifact-packaging/archive-directory.mts "$stage" "$out_dir/$asset"
src/shared/artifact-packaging/archive-directory.mts "$tools_stage" "$out_dir/$tools_asset"
tools/dev/bun.sh src/shared/artifact-packaging/release-notices.mts check-archive "$out_dir/$asset" --profile native-runtime
tools/dev/bun.sh src/shared/artifact-packaging/release-notices.mts check-archive "$out_dir/$tools_asset" --profile native-tools
echo "liboliphauntLinuxReleaseAsset=$out_dir/$asset"
echo "oliphauntToolsLinuxReleaseAsset=$out_dir/$tools_asset"
