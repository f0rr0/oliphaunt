#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
source src/third-party/tools/fetch-sources.sh
engine_dir=src/wasix/runtime/engine
plan=target/oliphaunt-wasix/engine/source-plan
mkdir -p "$plan"
bun "$engine_dir/prepare-sources.mts" plan "$plan"
for name in wasmer wasmer-wasix-types wasmer-journal wasmer-wasix; do
  fetch_source "$plan/$name.json" target/oliphaunt-sources/checkouts target/oliphaunt-sources/archives fetch
done
bun "$engine_dir/prepare-sources.mts" prepare
