#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace="$(mktemp -d)"
trap 'rm -rf "$workspace"' EXIT
fixture="$workspace/src/postgres/versions/18"
common="$workspace/src/runtimes/liboliphaunt/wasix-postmaster/lib"
native="$workspace/src/runtimes/liboliphaunt/native"
mkdir -p "$fixture" "$common" "$native/tools" "$native/bin" "$workspace/tools/bin" \
  "$workspace/build/src/test/regress" "$workspace/source/src/test/regress" "$workspace/icu/share/icu"
cp "$script_dir/run-regression.sh" "$script_dir/embedded_schedule" "$fixture/"
cat >"$common/common.sh" <<'SH'
REPO_ROOT="$REGRESSION_TEST_ROOT"
CLIENT_TOOLS_INSTALL_DIR="$REPO_ROOT/tools"
CLIENT_TOOLS_BUILD_DIR="$REPO_ROOT/build"
BASELINE_DIR="$REPO_ROOT/source"
POSTGRES_VERSION=18.4
fresh_lock_postgres_baseline() { :; }
fresh_unlock_postgres_baseline() { :; }
fresh_postgres_baseline_fingerprint() { echo fixture; }
fresh_require_postgres_baseline() { :; }
SH
cat >"$native/tools/runtime-preflight.sh" <<'SH'
oliphaunt_runtime_native_host_install_dir() { echo "${OLIPHAUNT_INSTALL_DIR:-$REPO_ROOT/tools}"; }
oliphaunt_runtime_native_host_work_root() { echo "$REPO_ROOT"; }
SH
cat >"$native/bin/icu.sh" <<'SH'
oliphaunt_icu_files_data_ready() { :; }
SH
cat >"$workspace/build/src/test/regress/pg_regress" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$REGRESSION_TEST_ROOT/arguments"
printf 'deliberate mismatch\n' >regression.diffs
exit "${REGRESSION_TEST_STATUS:-0}"
SH
chmod +x "$workspace/build/src/test/regress/pg_regress"
for tool in psql postgres initdb; do
  cp "$workspace/build/src/test/regress/pg_regress" "$workspace/tools/bin/$tool"
done
export REGRESSION_TEST_ROOT="$workspace"
export PGHOST=127.0.0.1 PGPORT=54321 PGUSER=postgres PGDATABASE=postgres
(
  cd "$workspace"
  OLIPHAUNT_INSTALL_DIR=tools OLIPHAUNT_ICU_DATA_DIR=icu/share/icu \
    bash "$fixture/run-regression.sh" native
) >"$workspace/log"
grep -Fx -- "--bindir=$workspace/tools/bin" "$workspace/arguments"
grep -Fx -- "--schedule=$workspace/source/src/test/regress/parallel_schedule" "$workspace/arguments"
grep -F -- '--temp-instance=' "$workspace/arguments"
bash "$fixture/run-regression.sh" embedded >"$workspace/log"
grep -Fx -- "--schedule=$fixture/embedded_schedule" "$workspace/arguments"
grep -Fx -- '--use-existing' "$workspace/arguments"
grep -Fx -- '--max-connections=1' "$workspace/arguments"
grep -Fx -- '--port=54321' "$workspace/arguments"
if REGRESSION_TEST_STATUS=1 bash "$fixture/run-regression.sh" embedded >"$workspace/log" 2>&1; then
  echo 'regression mismatch was swallowed' >&2
  exit 1
else
  [ "$?" -eq 1 ]
fi
# Preserve the upstream diagnostics and fail before execution without a target.
[ "$(find "$workspace/target" -name regression.diffs | wc -l)" -eq 3 ]
rm "$workspace/arguments"
if (
  unset PGPORT
  bash "$fixture/run-regression.sh" embedded
) >"$workspace/log" 2>&1; then
  echo 'missing server endpoint was accepted' >&2
  exit 1
fi
[ ! -f "$workspace/arguments" ]
if bash "$fixture/run-regression.sh" invalid >"$workspace/log" 2>&1; then
  echo 'invalid profile was accepted' >&2
  exit 1
fi
echo 'PostgreSQL regression runner checks passed'
