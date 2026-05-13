#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TARGET_ROOT="$REPO_ROOT/target/perf"

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RTT_ITERATIONS=100
PREPARED_ROWS=25000
SPEED_REPEATS=10
RUN_WASIX=1
RUN_PREPARED=1
BUILD_XTASK="${PGLITE_OXIDE_PERF_BUILD_XTASK:-1}"

usage() {
  cat >&2 <<'USAGE'
usage: tools/scripts/perf/run_native_libpglite_matrix.sh [options]

Options:
  --run-id ID             Output run id. Defaults to current UTC timestamp.
  --rtt-iterations N     RTT samples per case. Default: 100.
  --prepared-rows N      Prepared-update rows. Default: 25000.
  --speed-repeats N      Fresh-process speed-suite repeats for p50/p90. Default: 10.
  --skip-wasix           Skip WASIX direct/server release-lane controls.
  --skip-prepared        Skip prepared-update suites.
  --skip-build           Reuse target/release/xtask without rebuilding it.
  -h, --help             Show this help.

Environment:
  LIBPGLITE_OXIDE_LIBPGLITE      Required path to libpglite.dylib/.so.
  LIBPGLITE_OXIDE_POSTGRES       Path to matching postgres binary.
  LIBPGLITE_OXIDE_INITDB         Path to matching initdb binary.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id)
      RUN_ID="${2:?--run-id requires a value}"
      shift 2
      ;;
    --rtt-iterations)
      RTT_ITERATIONS="${2:?--rtt-iterations requires a value}"
      shift 2
      ;;
    --prepared-rows)
      PREPARED_ROWS="${2:?--prepared-rows requires a value}"
      shift 2
      ;;
    --speed-repeats)
      SPEED_REPEATS="${2:?--speed-repeats requires a value}"
      shift 2
      ;;
    --skip-wasix)
      RUN_WASIX=0
      shift
      ;;
    --skip-prepared)
      RUN_PREPARED=0
      shift
      ;;
    --skip-build)
      BUILD_XTASK=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ "$RTT_ITERATIONS" -le 0 || "$PREPARED_ROWS" -le 0 || "$SPEED_REPEATS" -le 0 ]]; then
  echo "iteration, row, and repeat counts must be positive" >&2
  exit 2
fi

LIBPGLITE="${LIBPGLITE_OXIDE_LIBPGLITE:-${PGLITE_OXIDE_NATIVE_LIBPGLITE:-$REPO_ROOT/target/libpglite-pg18/out/libpglite.dylib}}"
POSTGRES_BIN="${LIBPGLITE_OXIDE_POSTGRES:-${PGLITE_OXIDE_NATIVE_POSTGRES:-$REPO_ROOT/target/libpglite-pg18/install/bin/postgres}}"
INITDB_BIN="${LIBPGLITE_OXIDE_INITDB:-${PGLITE_OXIDE_NATIVE_INITDB:-$REPO_ROOT/target/libpglite-pg18/install/bin/initdb}}"

if [[ ! -f "$LIBPGLITE" ]]; then
  echo "missing native libpglite: $LIBPGLITE" >&2
  exit 1
fi
if [[ ! -x "$POSTGRES_BIN" ]]; then
  echo "missing native postgres binary: $POSTGRES_BIN" >&2
  exit 1
fi
if [[ ! -x "$INITDB_BIN" ]]; then
  echo "missing native initdb binary: $INITDB_BIN" >&2
  exit 1
fi

export LIBPGLITE_OXIDE_LIBPGLITE="$LIBPGLITE"
export LIBPGLITE_OXIDE_POSTGRES="$POSTGRES_BIN"
export LIBPGLITE_OXIDE_INITDB="$INITDB_BIN"
export PGLITE_OXIDE_NATIVE_LIBPGLITE="$LIBPGLITE"
export PGLITE_OXIDE_NATIVE_POSTGRES="$POSTGRES_BIN"
export PGLITE_OXIDE_NATIVE_INITDB="$INITDB_BIN"

RUN_DIR="$TARGET_ROOT/native-libpglite-$RUN_ID"
mkdir -p "$RUN_DIR"

XTASK="$REPO_ROOT/target/release/xtask"

if [[ "$BUILD_XTASK" -eq 1 ]]; then
  echo "Building release xtask..."
  cargo build --release -p xtask
elif [[ ! -x "$XTASK" ]]; then
  echo "missing release xtask: $XTASK" >&2
  echo "run without --skip-build first" >&2
  exit 1
else
  echo "Reusing existing release xtask: $XTASK"
fi

run_timed_json() {
  local name="$1"
  shift
  local json="$RUN_DIR/$name.json"
  local resource="$RUN_DIR/$name.resource.txt"

  echo "Running $name..."
  if [[ "$(uname -s)" == "Darwin" ]]; then
    /usr/bin/time -l -o "$resource" "$@" > "$json"
  elif /usr/bin/time -v true >/dev/null 2>&1; then
    /usr/bin/time -v -o "$resource" "$@" > "$json"
  else
    /usr/bin/time -p -o "$resource" "$@" > "$json"
  fi
}

run_timed_json native-libpglite-rtt \
  "$XTASK" perf native-libpglite \
  --suite rtt \
  --iterations "$RTT_ITERATIONS"

run_timed_json native-libpglite-speed \
  "$XTASK" perf native-libpglite \
  --suite speed \
  --speed-source pglite

run_timed_json native-postgres-tokio-all \
  "$XTASK" perf native-postgres \
  --suite all \
  --iterations "$RTT_ITERATIONS" \
  --speed-source pglite \
  --client tokio-postgres-simple \
  --postgres-bin "$POSTGRES_BIN" \
  --initdb-bin "$INITDB_BIN"

run_timed_json native-postgres-sqlx-all \
  "$XTASK" perf native-postgres \
  --suite all \
  --iterations "$RTT_ITERATIONS" \
  --speed-source pglite \
  --client sqlx \
  --postgres-bin "$POSTGRES_BIN" \
  --initdb-bin "$INITDB_BIN"

if [[ "$RUN_WASIX" -eq 1 ]]; then
  run_timed_json wasix-direct-all \
    "$XTASK" perf bench \
    --suite all \
    --mode direct \
    --iterations "$RTT_ITERATIONS" \
    --speed-source pglite

  run_timed_json wasix-server-sqlx-all \
    "$XTASK" perf bench \
    --suite all \
    --mode server-sqlx \
    --iterations "$RTT_ITERATIONS" \
    --speed-source pglite

  run_timed_json wasix-server-tokio-rtt \
    "$XTASK" perf bench \
    --suite rtt \
    --mode server-tokio-postgres-simple \
    --iterations "$RTT_ITERATIONS" \
    --speed-source pglite
fi

if [[ "$RUN_PREPARED" -eq 1 ]]; then
  run_timed_json native-libpglite-prepared \
    "$XTASK" perf native-libpglite \
    --suite prepared-updates \
    --rows "$PREPARED_ROWS"

  run_timed_json prepared-updates \
    "$XTASK" perf prepared-updates \
    --rows "$PREPARED_ROWS"
fi

if [[ "$SPEED_REPEATS" -gt 1 ]]; then
  mkdir -p "$RUN_DIR/repeats"
  for index in $(seq -w 1 "$SPEED_REPEATS"); do
    run_timed_json "repeats/native-libpglite-speed-$index" \
      "$XTASK" perf native-libpglite \
      --suite speed \
      --speed-source pglite
    run_timed_json "repeats/native-postgres-tokio-speed-$index" \
      "$XTASK" perf native-postgres \
      --suite speed \
      --speed-source pglite \
      --client tokio-postgres-simple \
      --postgres-bin "$POSTGRES_BIN" \
      --initdb-bin "$INITDB_BIN"
    if [[ "$RUN_WASIX" -eq 1 ]]; then
      run_timed_json "repeats/wasix-direct-speed-$index" \
        "$XTASK" perf bench \
        --suite speed \
        --mode direct \
        --speed-source pglite
      run_timed_json "repeats/wasix-server-sqlx-speed-$index" \
        "$XTASK" perf bench \
        --suite speed \
        --mode server-sqlx \
        --speed-source pglite
    fi
  done
fi

node "$SCRIPT_DIR/summarize_native_libpglite_matrix.mjs" \
  --run-dir "$RUN_DIR" \
  --run-id "$RUN_ID" \
  --postgres-version "$("$POSTGRES_BIN" --version)" \
  --speed-repeats "$SPEED_REPEATS" \
  > "$RUN_DIR/report.md"

echo "$RUN_DIR/report.md"
