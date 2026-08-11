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
run_step "static product contract" "$FRESH_ROOT/bin/check-prior-art.sh"
run_step "apply WASIX core overlay" "$FRESH_ROOT/bin/apply-wasix-core-overlay.sh"
run_step "prepare pinned runtime" "$FRESH_ROOT/runtime/bin/prepare-upstream-checkouts.sh"
run_step "build patched runtime" "$FRESH_ROOT/runtime/bin/build-runtime.sh"
run_step "strict exec-backend blockers" "$FRESH_ROOT/runtime/bin/run-exec-backend-probes.sh"
run_step "build native oracle" "$FRESH_ROOT/bin/build-native-oracle.sh"
run_step "native smoke" "$FRESH_ROOT/bin/smoke-native-oracle.sh"
run_step "build WASIX core" "$FRESH_ROOT/bin/build-wasix-core.sh"
run_step "WASIX smoke" "$FRESH_ROOT/bin/smoke-wasix-core.sh"
run_step "WASIX initdb lifecycle stress" "$FRESH_ROOT/bin/stress-wasix-initdb.sh" --iterations "${WASIX_INITDB_STRESS_ITERATIONS:-20}"
run_step "WASIX concurrent connections smoke" env WASIX_SKIP_PRECOMPILE=1 "$FRESH_ROOT/bin/smoke-wasix-concurrent-connections.sh"
run_step "WASIX pg_regress subset" env \
  WASIX_SKIP_PRECOMPILE=1 \
  WASIX_REGRESS_SUITE_NAME=wasix-regress-acceptance \
  "$FRESH_ROOT/bin/run-wasix-regress-subset.sh" \
  test_setup create_function_c boolean case copy
