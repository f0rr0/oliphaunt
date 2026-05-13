#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

continue_on_failure=0
if [ "${1:-}" = "--continue" ]; then
  continue_on_failure=1
fi

run_step() {
  local name="$1"
  shift
  printf '==> %s\n' "$name"
  set +e
  "$@"
  local status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    printf 'PASS %s\n' "$name"
    return 0
  fi
  printf 'FAIL %s exit=%s\n' "$name" "$status" >&2
  if [ "$continue_on_failure" -eq 1 ]; then
    return 0
  fi
  return "$status"
}

run_step "prepare clean baseline" "$FRESH_ROOT/bin/prepare-baseline.sh"
run_step "apply WASIX core overlay" "$FRESH_ROOT/bin/apply-wasix-core-overlay.sh"
run_step "build native oracle" "$FRESH_ROOT/bin/build-native-oracle.sh"
run_step "native smoke" "$FRESH_ROOT/bin/smoke-native-oracle.sh"
run_step "build WASIX core" "$FRESH_ROOT/bin/build-wasix-core.sh"
run_step "WASIX smoke" "$FRESH_ROOT/bin/smoke-wasix-core.sh"
if [ "$continue_on_failure" -eq 1 ] || [ "${WASIX_ACCEPTANCE_CONCURRENT:-0}" = "1" ]; then
  run_step "WASIX concurrent connections smoke" env WASIX_SKIP_PRECOMPILE=1 "$FRESH_ROOT/bin/smoke-wasix-concurrent-connections.sh"
fi
