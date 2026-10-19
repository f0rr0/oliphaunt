#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)" || {
  echo "unable to determine repository root from $script_dir; run this script from a Git checkout" >&2
  exit 1
}
[ -f "$root/package.json" ] && [ -d "$root/src/wasix/runtime" ] || {
  echo "must run inside the Oliphaunt workspace" >&2
  exit 1
}
cd "$root"

asset_profile="${ASSET_PROFILE:-release}"
image="${IMAGE:-oliphaunt-wasix-wasix-build:local}"
export IMAGE="$image"
if [ -z "${DOCKER_CONFIG:-}" ]; then
  docker_config="$root/target/docker/public-config"
  mkdir -p "$docker_config"
  [ -f "$docker_config/config.json" ] || printf '{}\n' >"$docker_config/config.json"
  if [ -d "$HOME/.docker/cli-plugins" ]; then
    mkdir -p "$docker_config/cli-plugins"
    for plugin in "$HOME/.docker/cli-plugins/"*; do
      [ -e "$plugin" ] || continue
      ln -sf "$plugin" "$docker_config/cli-plugins/$(basename "$plugin")"
    done
  fi
  export DOCKER_CONFIG="$docker_config"
fi
export DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-1}"

export OLIPHAUNT_WASM_BUILD_PROFILE="$asset_profile"
bash src/third-party/tools/fetch-sources.sh wasix-runtime --verify-only
bash src/wasix/runtime/assets/build/prepare_postgres_source.sh >/dev/null
build=src/wasix/runtime/assets/build
# Moon owns the complete source/toolchain input hash. Keep the absolute-path
# Make tree in the existing compilation cache, and verify its recorded bytes
# before bypassing compilation. Raw script calls keep normal incremental builds.
compiler_tree=target/oliphaunt-wasix/wasix-build/work/docker-oliphaunt
receipt=target/oliphaunt-wasix/wasix-build/build/compiler-input-hash
checksums=target/oliphaunt-wasix/wasix-build/build/compiler-output-sha256
reuse=0
if [ "${MOON_TARGET:-}" = liboliphaunt-wasix:compiler-output ] &&
  [[ "${MOON_TASK_HASH:-}" =~ ^[0-9a-f]{64}$ ]] &&
  [ "${FORCE_RECONFIGURE:-0}" != 1 ] && [ "${FORCE_IMAGE_BUILD:-0}" != 1 ] &&
  [ -s "$receipt" ] && [ -s "$checksums" ] &&
  [ "$(cat "$receipt")" = "$MOON_TASK_HASH" ] &&
  sha256sum --check --status "$checksums"; then
  reuse=1
  echo 'Reusing verified WASIX compiler output for the current Moon input hash'
fi
if [ "${OLIPHAUNT_SKIP_BUILD:-0}" != "1" ] && [ "$reuse" = 0 ]; then
  rm -f "$receipt" "$checksums"
  for script in docker_oliphaunt docker_runtime_support docker_initdb; do
    bash "$build/$script.sh"
  done
fi
awk -v profile="$asset_profile" '$0 == "profile=" profile {found=1} END {exit !found}' \
  target/oliphaunt-wasix/wasix-build/work/docker-oliphaunt/.oliphaunt-wasix-build-profile
cargo run -p xtask -- assets stage-runtime

if [ "${MOON_TARGET:-}" = liboliphaunt-wasix:compiler-output ] &&
  [[ "${MOON_TASK_HASH:-}" =~ ^[0-9a-f]{64}$ ]] && [ "$reuse" = 0 ] &&
  [ "${OLIPHAUNT_SKIP_BUILD:-0}" != 1 ]; then
  mkdir -p "$(dirname "$receipt")"
  find "$compiler_tree" -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > "$checksums"
  printf '%s\n' "$MOON_TASK_HASH" > "$receipt"
fi
