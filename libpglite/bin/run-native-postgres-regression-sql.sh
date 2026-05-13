#!/usr/bin/env bash
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work_root="${LIBPGLITE_WORK_ROOT:-${PGLITE_OXIDE_NATIVE_WORK_ROOT:-$repo_root/target/libpglite-pg18}}"
libpglite="${LIBPGLITE_OXIDE_LIBPGLITE:-${PGLITE_OXIDE_NATIVE_LIBPGLITE:-$work_root/out/libpglite.dylib}}"
initdb="${LIBPGLITE_OXIDE_INITDB:-${PGLITE_OXIDE_NATIVE_INITDB:-$work_root/install/bin/initdb}}"
postgres="${LIBPGLITE_OXIDE_POSTGRES:-${PGLITE_OXIDE_NATIVE_POSTGRES:-$work_root/install/bin/postgres}}"
test_bin="${PGLITE_OXIDE_NATIVE_POSTGRES_REGRESSION_BIN:-}"

cases=(
  datatypes_cover_pglite_basic_surface
  ddl_schema_view_trigger_and_rollback_behave_like_postgres
  transactions_savepoints_and_error_recovery_match_postgres
  expected_sql_error_recovery_stays_inside_protocol_loop
  pg17_uuidv4_alias_error_is_recoverable
  planner_uses_indexes_for_selective_queries_and_updates
  direct_blob_copy_round_trips_csv_with_pglite_dev_blob_surface
)

if [ ! -f "$libpglite" ] || [ ! -x "$initdb" ] || [ ! -x "$postgres" ]; then
  echo "native libpglite artifacts are missing; run libpglite/bin/build-postgres18-macos.sh first" >&2
  exit 1
fi

if [ -z "$test_bin" ] || [ ! -x "$test_bin" ]; then
  (
    cd "$repo_root"
    cargo test --test postgres_regression --no-run
  ) || exit $?
  test_bin="$(
    find "$repo_root/target/debug/deps" \
      -maxdepth 1 \
      -type f \
      -name 'postgres_regression-*' \
      -perm -111 \
      -print |
      sort |
      tail -n 1
  )"
fi

if [ -z "$test_bin" ] || [ ! -x "$test_bin" ]; then
  echo "could not locate compiled postgres_regression test binary" >&2
  exit 1
fi

export LIBPGLITE_INITDB="$initdb"
export LIBPGLITE_POSTGRES="$postgres"
export LIBPGLITE_OXIDE_LIBPGLITE="$libpglite"
export LIBPGLITE_OXIDE_INITDB="$initdb"
export LIBPGLITE_OXIDE_POSTGRES="$postgres"
export PGLITE_OXIDE_NATIVE_LIBPGLITE="$libpglite"
export PGLITE_OXIDE_NATIVE_INITDB="$initdb"
export PGLITE_OXIDE_NATIVE_POSTGRES="$postgres"
export PGLITE_OXIDE_POSTGRES_REGRESSION_NATIVE=1

failed=()
for case in "${cases[@]}"; do
  printf '\n===== native SQL regression: %s =====\n' "$case"
  if ! "$test_bin" "$case" --exact --nocapture; then
    failed+=("$case")
  fi
done

if [ "${#failed[@]}" -ne 0 ]; then
  printf '\nFAILED native SQL regression cases:\n' >&2
  printf '  %s\n' "${failed[@]}" >&2
  exit 1
fi

printf '\nAll native SQL regression cases passed.\n'
