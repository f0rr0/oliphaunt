#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
bun test ./tools/release/concurrent-github-release-asset-upload.test.mts
scratch=$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-upload-concurrency-XXXXXX")
trap 'rm -rf "$scratch"' EXIT
pids=()
for product in 0 1 2 3 4; do
  bun tools/release/concurrent-github-release-asset-upload.test.mts worker "$scratch" "$product" &
  pids+=("$!")
done
status=0
for pid in "${pids[@]}"; do wait "$pid" || status=1; done
[ "$status" = 0 ]
bun tools/release/concurrent-github-release-asset-upload.test.mts verify "$scratch"
