#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)" || {
  echo "unable to determine repository root from $script_dir; run this script from a Git checkout" >&2
  exit 1
}
[ -f "$root/package.json" ] && [ -d "$root/runtimes/liboliphaunt-wasix" ] || {
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
bash third-party/tools/fetch-sources.sh wasix-runtime --verify-only
bash runtimes/liboliphaunt-wasix/assets/build/prepare_postgres_source.sh >/dev/null
build=runtimes/liboliphaunt-wasix/assets/build
if [ "${OLIPHAUNT_SKIP_BUILD:-0}" != "1" ]; then
  for script in docker_oliphaunt docker_runtime_support docker_initdb; do
    bash "$build/$script.sh"
  done
fi
awk -v profile="$asset_profile" '$0 == "profile=" profile {found=1} END {exit !found}' \
  target/oliphaunt-wasix/wasix-build/work/docker-oliphaunt/.oliphaunt-wasix-build-profile
cargo run -p xtask -- assets stage-runtime
