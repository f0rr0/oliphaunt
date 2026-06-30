#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)" || {
  echo "unable to determine repository root from $script_dir; run this script from a Git checkout" >&2
  exit 1
}
[ -f "$root/package.json" ] && [ -d "$root/src/runtimes/liboliphaunt/wasix" ] || {
  echo "must run inside the Oliphaunt workspace" >&2
  exit 1
}
cd "$root"

asset_profile="${ASSET_PROFILE:-release}"
image="${IMAGE:-oliphaunt-wasix-wasix-build:ci}"
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

cargo run -p xtask --features template-runner -- assets release-build \
  --profile "$asset_profile" \
  --target-triple x86_64-unknown-linux-gnu \
  --skip-aot \
  --skip-package-size

cargo run -p xtask -- assets check --strict-generated
