#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bun test ./tools/release/github-content-write-pacer.test.mts
scratch="$(mktemp -d)"
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
  rm -rf "$scratch"
}
trap cleanup EXIT
export GITHUB_ACTIONS=false GITHUB_REPOSITORY=f0rr0/oliphaunt GITHUB_RUN_ATTEMPT=1 GITHUB_RUN_ID=456
export GITHUB_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH="$scratch/pacer.json" OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_TEST_MODE=true
export OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH="$scratch/core.json" OLIPHAUNT_REQUIRE_GITHUB_CORE_REQUEST_JOURNAL=true
bun tools/release/github-content-write-pacer.test.mts seed
for lane in 0 1 2 3 4; do
  bun tools/release/github-content-write-pacer.test.mts worker "$lane" > "$scratch/$lane.log" 2>&1 &
  pids+=("$!")
done
failed=0
for pid in "${pids[@]}"; do wait "$pid" || failed=1; done
pids=()
if [[ "$failed" != 0 ]]; then cat "$scratch/"*.log >&2; exit 1; fi
bun tools/release/github-content-write-pacer.test.mts assert
echo 'GitHub pacer: five concurrent lanes preserve all ordered reservations'
