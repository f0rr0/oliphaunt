#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
export OLIPHAUNT_WASM_BUILD_PROFILE="${ASSET_PROFILE:-release}"
build=src/wasix/runtime/assets/build
bash "$build/docker_pgxs_extensions.sh"
bash "$build/docker_contrib_extensions.sh"
extension_scripts="$(bun src/wasix/runtime/tools/extension-build-scripts.mts)"
while IFS= read -r script; do
  [ -z "$script" ] || bash "$script"
done <<<"$extension_scripts"
cargo run -p xtask --locked -- assets package-extensions
