#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
export OLIPHAUNT_WASM_BUILD_PROFILE="${ASSET_PROFILE:-release}"
for tool in pgdump psql; do
  bash "runtimes/liboliphaunt-wasix/assets/build/docker_$tool.sh"
done
cargo run -p xtask --locked -- assets package-tools
