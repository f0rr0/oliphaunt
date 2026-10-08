#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
source src/third-party/tools/fetch-sources.sh
engine_dir=src/wasix/runtime/engine
plan=target/oliphaunt-wasix/engine/source-plan
bun "$engine_dir/prepare-sources.mts" plan "$plan"
while IFS= read -r -d '' pin; do
  fetch_source "$pin" target/oliphaunt-sources/checkouts target/oliphaunt-sources/archives fetch
  # Bash 3.2 does not propagate a failed subshell function through this loop.
  status=$?
  [[ "$status" == 0 ]] || exit "$status"
done < "$plan/pins"
bun "$engine_dir/prepare-sources.mts" prepare
