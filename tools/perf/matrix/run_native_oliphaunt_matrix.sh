#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)"; then
  :
else
  REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
fi
TARGET_ROOT="$REPO_ROOT/target/perf"

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RELEASE_MIN_RTT_ITERATIONS=100
RELEASE_MIN_RTT_REPEATS=10
RELEASE_MIN_PREPARED_ROWS=25000
RELEASE_MIN_PREPARED_REPEATS=10
RELEASE_MIN_SPEED_REPEATS=20
RELEASE_MIN_BACKUP_REPEATS=10
RTT_ITERATIONS="$RELEASE_MIN_RTT_ITERATIONS"
RTT_REPEATS="$RELEASE_MIN_RTT_REPEATS"
PREPARED_ROWS="$RELEASE_MIN_PREPARED_ROWS"
PREPARED_REPEATS="$RELEASE_MIN_PREPARED_REPEATS"
SPEED_REPEATS="$RELEASE_MIN_SPEED_REPEATS"
BACKUP_REPEATS="$RELEASE_MIN_BACKUP_REPEATS"
RUN_SQLITE=1
RUN_PREPARED=1
BUILD_PERF_RUNNER="${OLIPHAUNT_PERF_BUILD_RUNNER:-1}"
PLAN_ONLY=0
DURABILITY="${OLIPHAUNT_PERF_DURABILITY:-safe}"
RUNTIME_FOOTPRINT="${OLIPHAUNT_PERF_RUNTIME_FOOTPRINT:-throughput}"
PGDATA_COPY_MODE="${OLIPHAUNT_PGDATA_COPY_MODE:-copy}"
NATIVE_ENGINES="${OLIPHAUNT_PERF_ENGINES:-direct,broker,server}"
SUITES="${OLIPHAUNT_PERF_SUITES:-rtt,speed,streaming,prepared,backup}"
STARTUP_GUCS=()
if [[ -n "${OLIPHAUNT_PERF_STARTUP_GUCS:-}" ]]; then
  IFS=',' read -r -a STARTUP_GUCS <<< "${OLIPHAUNT_PERF_STARTUP_GUCS//[[:space:]]/}"
fi

usage() {
  cat >&2 <<'USAGE'
usage: tools/perf/matrix/run_native_oliphaunt_matrix.sh [options]

Options:
  --run-id ID             Output run id. Defaults to current UTC timestamp.
  --rtt-iterations N     RTT samples per case. Default: 100.
  --rtt-repeats N        Fresh-process RTT repeats for release-grade gating. Default: 10.
  --prepared-rows N      Prepared-update rows. Default: 25000.
  --prepared-repeats N   Fresh-process prepared-update repeats for p90/p95. Default: 10.
  --speed-repeats N      Fresh-process speed-suite repeats for p50/p90/p95. Default: 20.
  --backup-repeats N     Fresh-process backup/restore repeats for p50/p90/p95. Default: 10.
  --durability PROFILE   Native durability profile: safe, balanced, or fast-dev. Default: safe.
  --runtime-footprint PROFILE
                         Native runtime footprint: throughput, balanced-mobile, or small-mobile.
                         Default: throughput.
  --startup-guc NAME=VALUE
                         PostgreSQL startup GUC override. Repeatable; applied after footprint
                         and durability defaults.
  --pgdata-copy-mode MODE PGDATA template hydration: copy or prefer-clone. Default: copy.
  --engines LIST         Comma-separated native engines: direct, broker, server, or all.
                         Default: direct,broker,server.
  --suite LIST           Alias for --suites.
  --suites LIST          Comma-separated suites: rtt, speed, streaming, prepared, backup, or all.
                         Default: rtt,speed,streaming,prepared,backup.
  --quick                Fast plumbing preset: 10 RTT samples, one repeat, 1000 prepared rows.
  --plan-only            Print the native-only benchmark plan and exit without artifact checks.
  --skip-sqlite          Skip SQLite embedded control.
  --skip-prepared        Skip prepared-update suites.
  --skip-build           Reuse target/release/oliphaunt-perf without rebuilding it.
  -h, --help             Show this help.

Environment:
  LIBOLIPHAUNT_PATH      Required path to liboliphaunt.dylib/.so.
  OLIPHAUNT_POSTGRES       Path to matching postgres binary.
  OLIPHAUNT_INITDB         Path to matching initdb binary.
  OLIPHAUNT_PERF_STARTUP_GUCS
                         Comma-separated NAME=VALUE startup GUC overrides.
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
    --rtt-repeats)
      RTT_REPEATS="${2:?--rtt-repeats requires a value}"
      shift 2
      ;;
    --prepared-rows)
      PREPARED_ROWS="${2:?--prepared-rows requires a value}"
      shift 2
      ;;
    --prepared-repeats)
      PREPARED_REPEATS="${2:?--prepared-repeats requires a value}"
      shift 2
      ;;
    --speed-repeats)
      SPEED_REPEATS="${2:?--speed-repeats requires a value}"
      shift 2
      ;;
    --backup-repeats)
      BACKUP_REPEATS="${2:?--backup-repeats requires a value}"
      shift 2
      ;;
    --durability)
      DURABILITY="${2:?--durability requires a value}"
      shift 2
      ;;
    --runtime-footprint)
      RUNTIME_FOOTPRINT="${2:?--runtime-footprint requires a value}"
      shift 2
      ;;
    --startup-guc)
      STARTUP_GUCS+=("${2:?--startup-guc requires a value}")
      shift 2
      ;;
    --pgdata-copy-mode)
      PGDATA_COPY_MODE="${2:?--pgdata-copy-mode requires a value}"
      shift 2
      ;;
    --engines)
      NATIVE_ENGINES="${2:?--engines requires a value}"
      shift 2
      ;;
    --suite|--suites)
      SUITES="${2:?--suites requires a value}"
      shift 2
      ;;
    --quick)
      RTT_ITERATIONS=10
      RTT_REPEATS=1
      PREPARED_ROWS=1000
      PREPARED_REPEATS=1
      SPEED_REPEATS=1
      BACKUP_REPEATS=1
      shift
      ;;
    --plan-only)
      PLAN_ONLY=1
      shift
      ;;
    --skip-sqlite)
      RUN_SQLITE=0
      shift
      ;;
    --skip-prepared)
      RUN_PREPARED=0
      shift
      ;;
    --skip-build)
      BUILD_PERF_RUNNER=0
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

csv_has() {
  local csv="$1"
  local value="$2"
  [[ ",$csv," == *",$value,"* ]]
}

normalize_csv_arg() {
  local name="$1"
  local raw="${2//[[:space:]]/}"
  local allowed="$3"
  local default_value="$4"
  local item
  local output=""

  if [[ -z "$raw" || "$raw" == "all" ]]; then
    printf '%s\n' "$default_value"
    return
  fi

  IFS=',' read -r -a items <<< "$raw"
  for item in "${items[@]}"; do
    if [[ -z "$item" ]]; then
      echo "$name must not contain empty entries" >&2
      exit 2
    fi
    if [[ "$item" == "all" ]]; then
      printf '%s\n' "$default_value"
      return
    fi
    if ! csv_has "$allowed" "$item"; then
      echo "unknown $name value: $item" >&2
      exit 2
    fi
    if ! csv_has "$output" "$item"; then
      output="${output:+$output,}$item"
    fi
  done

  if [[ -z "$output" ]]; then
    echo "$name must not be empty" >&2
    exit 2
  fi
  printf '%s\n' "$output"
}

NATIVE_ENGINES="$(normalize_csv_arg "--engines" "$NATIVE_ENGINES" "direct,broker,server" "direct,broker,server")"
SUITES="$(normalize_csv_arg "--suites" "$SUITES" "rtt,speed,streaming,prepared,backup" "rtt,speed,streaming,prepared,backup")"
if ! csv_has "$SUITES" speed; then
  RUN_SQLITE=0
fi
if ! csv_has "$SUITES" prepared; then
  RUN_PREPARED=0
fi

if [[ "$RTT_ITERATIONS" -le 0 || "$RTT_REPEATS" -le 0 || "$PREPARED_ROWS" -le 0 || "$PREPARED_REPEATS" -le 0 || "$SPEED_REPEATS" -le 0 || "$BACKUP_REPEATS" -le 0 ]]; then
  echo "iteration, row, and repeat counts must be positive" >&2
  exit 2
fi

case "$DURABILITY" in
  safe|balanced|fast-dev) ;;
  *)
    echo "unknown durability profile: $DURABILITY" >&2
    exit 2
    ;;
esac

case "$RUNTIME_FOOTPRINT" in
  throughput|balanced-mobile|small-mobile) ;;
  *)
    echo "unknown runtime footprint profile: $RUNTIME_FOOTPRINT" >&2
    exit 2
    ;;
esac

STARTUP_GUC_COUNT="${#STARTUP_GUCS[@]}"
if [[ "$STARTUP_GUC_COUNT" -gt 0 ]]; then
  for startup_guc in "${STARTUP_GUCS[@]}"; do
    case "$startup_guc" in
      *=?*) ;;
      *)
        echo "startup GUC must be formatted as name=value: $startup_guc" >&2
        exit 2
        ;;
    esac
  done
fi

TUNING_ARGS=(--runtime-footprint "$RUNTIME_FOOTPRINT")
if [[ "$STARTUP_GUC_COUNT" -gt 0 ]]; then
  for startup_guc in "${STARTUP_GUCS[@]}"; do
    TUNING_ARGS+=(--startup-guc "$startup_guc")
  done
fi

join_csv() {
  local IFS=,
  printf '%s\n' "$*"
}
STARTUP_GUCS_CSV=""
if [[ "$STARTUP_GUC_COUNT" -gt 0 ]]; then
  STARTUP_GUCS_CSV="$(join_csv "${STARTUP_GUCS[@]}")"
fi

case "$PGDATA_COPY_MODE" in
  prefer-clone|clone|copy|byte-copy|byte_copy|physical-copy|physical_copy) ;;
  *)
    echo "unknown PGDATA copy mode: $PGDATA_COPY_MODE" >&2
    exit 2
    ;;
esac
export OLIPHAUNT_PGDATA_COPY_MODE="$PGDATA_COPY_MODE"

PARTIAL_REPORT=0
if [[ "$NATIVE_ENGINES" != "direct,broker,server" || "$SUITES" != "rtt,speed,streaming,prepared,backup" || "$RUN_SQLITE" -ne 1 || "$RUN_PREPARED" -ne 1 ]]; then
  PARTIAL_REPORT=1
fi

RELEASE_EVIDENCE=0
if [[ "$PARTIAL_REPORT" -eq 0 &&
  "$RTT_ITERATIONS" -ge "$RELEASE_MIN_RTT_ITERATIONS" &&
  "$RTT_REPEATS" -ge "$RELEASE_MIN_RTT_REPEATS" &&
  "$PREPARED_ROWS" -ge "$RELEASE_MIN_PREPARED_ROWS" &&
  "$PREPARED_REPEATS" -ge "$RELEASE_MIN_PREPARED_REPEATS" &&
  "$SPEED_REPEATS" -ge "$RELEASE_MIN_SPEED_REPEATS" &&
  "$BACKUP_REPEATS" -ge "$RELEASE_MIN_BACKUP_REPEATS" ]]; then
  RELEASE_EVIDENCE=1
fi

DIAGNOSTIC_RUN=0
if [[ "$RELEASE_EVIDENCE" -ne 1 ]]; then
  DIAGNOSTIC_RUN=1
fi

native_case_name() {
  local engine="$1"
  local suite="$2"
  case "$engine:$suite" in
    direct:rtt) echo "native-liboliphaunt-rtt" ;;
    direct:speed) echo "native-liboliphaunt-speed" ;;
    direct:streaming) echo "native-liboliphaunt-streaming" ;;
    direct:prepared) echo "native-liboliphaunt-prepared-direct" ;;
    direct:backup) echo "native-liboliphaunt-backup" ;;
    broker:rtt) echo "native-liboliphaunt-broker-rtt" ;;
    broker:speed) echo "native-liboliphaunt-broker-speed" ;;
    broker:streaming) echo "native-liboliphaunt-broker-streaming" ;;
    broker:prepared) echo "native-liboliphaunt-prepared-broker" ;;
    broker:backup) echo "native-liboliphaunt-broker-backup" ;;
    server:rtt) echo "native-liboliphaunt-server-rtt" ;;
    server:speed) echo "native-liboliphaunt-server-speed" ;;
    server:streaming) echo "native-liboliphaunt-server-streaming" ;;
    server:prepared) echo "native-liboliphaunt-prepared-server" ;;
    server:backup) echo "native-liboliphaunt-server-backup" ;;
    *)
      echo "unsupported native case: $engine $suite" >&2
      exit 2
      ;;
  esac
}

print_native_plan_cases() {
  local suite
  local engine
  for suite in rtt speed streaming prepared backup; do
    if ! csv_has "$SUITES" "$suite"; then
      continue
    fi
    if [[ "$suite" == "prepared" && "$RUN_PREPARED" -ne 1 ]]; then
      continue
    fi
    for engine in direct broker server; do
      if csv_has "$NATIVE_ENGINES" "$engine"; then
        echo "case=$(native_case_name "$engine" "$suite")"
      fi
    done
  done
}

print_native_postgres_plan_cases() {
  if csv_has "$SUITES" rtt && csv_has "$SUITES" speed; then
    echo "case=native-postgres-tokio-all"
    echo "case=native-postgres-sqlx-all"
  else
    if csv_has "$SUITES" rtt; then
      echo "case=native-postgres-tokio-rtt"
      echo "case=native-postgres-sqlx-rtt"
    fi
    if csv_has "$SUITES" speed; then
      echo "case=native-postgres-tokio-speed"
      echo "case=native-postgres-sqlx-speed"
    fi
  fi
  if csv_has "$SUITES" streaming; then
    echo "case=native-postgres-streaming"
  fi
  if csv_has "$SUITES" speed && [[ "$RUN_SQLITE" -eq 1 ]]; then
    echo "case=sqlite-speed"
  fi
  if csv_has "$SUITES" prepared && [[ "$RUN_PREPARED" -eq 1 ]]; then
    echo "case=native-postgres-prepared"
  fi
  if csv_has "$SUITES" backup; then
    echo "case=native-postgres-backup"
    if [[ "$RUN_SQLITE" -eq 1 ]]; then
      echo "case=sqlite-backup"
    fi
  fi
}

print_plan() {
  cat <<PLAN
nativeOnly=true
legacyWasixControls=false
runId=$RUN_ID
nativeEngines=$NATIVE_ENGINES
suites=$SUITES
releaseEvidence=$RELEASE_EVIDENCE
partialReport=$PARTIAL_REPORT
diagnosticRun=$DIAGNOSTIC_RUN
releaseMinRttIterations=$RELEASE_MIN_RTT_ITERATIONS
releaseMinRttRepeats=$RELEASE_MIN_RTT_REPEATS
releaseMinPreparedRows=$RELEASE_MIN_PREPARED_ROWS
releaseMinPreparedRepeats=$RELEASE_MIN_PREPARED_REPEATS
releaseMinSpeedRepeats=$RELEASE_MIN_SPEED_REPEATS
releaseMinBackupRepeats=$RELEASE_MIN_BACKUP_REPEATS
rttIterations=$RTT_ITERATIONS
rttRepeats=$RTT_REPEATS
preparedRows=$PREPARED_ROWS
preparedRepeats=$PREPARED_REPEATS
speedRepeats=$SPEED_REPEATS
backupRepeats=$BACKUP_REPEATS
runSqlite=$RUN_SQLITE
runPrepared=$RUN_PREPARED
buildPerfRunner=$BUILD_PERF_RUNNER
durability=$DURABILITY
runtimeFootprint=$RUNTIME_FOOTPRINT
startupGucs=$STARTUP_GUCS_CSV
pgdataCopyMode=$PGDATA_COPY_MODE
perfRunnerBuildCommand=cargo build --release -p oliphaunt-perf -p oliphaunt --bins
PLAN
  print_native_plan_cases
  print_native_postgres_plan_cases
}

if [[ "$PLAN_ONLY" -eq 1 ]]; then
  print_plan
  exit 0
fi

OLIPHAUNT="${LIBOLIPHAUNT_PATH:-$REPO_ROOT/target/liboliphaunt-pg18/out/liboliphaunt.dylib}"
POSTGRES_BIN="${OLIPHAUNT_POSTGRES:-$REPO_ROOT/target/liboliphaunt-pg18/install/bin/postgres}"
INITDB_BIN="${OLIPHAUNT_INITDB:-$REPO_ROOT/target/liboliphaunt-pg18/install/bin/initdb}"

if [[ ! -f "$OLIPHAUNT" ]]; then
  echo "missing native liboliphaunt-native: $OLIPHAUNT" >&2
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

export LIBOLIPHAUNT_PATH="$OLIPHAUNT"
export OLIPHAUNT_POSTGRES="$POSTGRES_BIN"
export OLIPHAUNT_INITDB="$INITDB_BIN"

RUN_DIR="$TARGET_ROOT/native-liboliphaunt-$RUN_ID"
mkdir -p "$RUN_DIR"

PERF_RUNNER="$REPO_ROOT/target/release/oliphaunt-perf"

RUN_DIR="$RUN_DIR" \
OLIPHAUNT_PATH="$OLIPHAUNT" \
POSTGRES_BIN_PATH="$POSTGRES_BIN" \
INITDB_BIN_PATH="$INITDB_BIN" \
node <<'NODE' > "$RUN_DIR/artifact-sizes.json"
const fs = require('node:fs')
const path = require('node:path')

function sizeBytes(target) {
  if (!target || !fs.existsSync(target)) return null
  const stat = fs.lstatSync(target)
  if (stat.isFile() || stat.isSymbolicLink()) return stat.size
  if (!stat.isDirectory()) return 0
  let total = 0
  for (const entry of fs.readdirSync(target)) {
    total += sizeBytes(path.join(target, entry)) ?? 0
  }
  return total
}

const liboliphaunt = process.env.OLIPHAUNT_PATH
const installDir = path.dirname(path.dirname(process.env.POSTGRES_BIN_PATH))
const embeddedModules = path.join(path.dirname(liboliphaunt), 'modules')
const artifacts = [
  ['liboliphaunt-native', liboliphaunt],
  ['embedded-modules', embeddedModules],
  ['native-postgres-install', installDir],
]
console.log(JSON.stringify({
  artifacts: artifacts.map(([name, filePath]) => ({
    name,
    path: filePath,
    bytes: sizeBytes(filePath),
  })),
}, null, 2))
NODE

if [[ "$BUILD_PERF_RUNNER" -eq 1 ]]; then
  echo "Building native-only release oliphaunt-perf and native broker helper..."
  cargo build --release -p oliphaunt-perf -p oliphaunt --bins
elif [[ ! -x "$PERF_RUNNER" ]]; then
  echo "missing release oliphaunt-perf: $PERF_RUNNER" >&2
  echo "run without --skip-build first" >&2
  exit 1
else
  echo "Reusing existing release oliphaunt-perf: $PERF_RUNNER"
fi

node "$SCRIPT_DIR/native_oliphaunt_provenance.mjs" write \
  --run-dir "$RUN_DIR" \
  --repo-root "$REPO_ROOT" \
  --run-id "$RUN_ID" \
  --native-engines "$NATIVE_ENGINES" \
  --suites "$SUITES" \
  --durability "$DURABILITY" \
  --runtime-footprint "$RUNTIME_FOOTPRINT" \
  --startup-gucs "$STARTUP_GUCS_CSV" \
  --rtt-iterations "$RTT_ITERATIONS" \
  --rtt-repeats "$RTT_REPEATS" \
  --prepared-rows "$PREPARED_ROWS" \
  --prepared-repeats "$PREPARED_REPEATS" \
  --speed-repeats "$SPEED_REPEATS" \
  --backup-repeats "$BACKUP_REPEATS" \
  --pgdata-copy-mode "$PGDATA_COPY_MODE" \
  --run-sqlite "$RUN_SQLITE" \
  --run-prepared "$RUN_PREPARED" \
  --release-evidence "$RELEASE_EVIDENCE" \
  --partial-report "$PARTIAL_REPORT" \
  --diagnostic-run "$DIAGNOSTIC_RUN" \
  --release-min-rtt-iterations "$RELEASE_MIN_RTT_ITERATIONS" \
  --release-min-rtt-repeats "$RELEASE_MIN_RTT_REPEATS" \
  --release-min-prepared-rows "$RELEASE_MIN_PREPARED_ROWS" \
  --release-min-prepared-repeats "$RELEASE_MIN_PREPARED_REPEATS" \
  --release-min-speed-repeats "$RELEASE_MIN_SPEED_REPEATS" \
  --release-min-backup-repeats "$RELEASE_MIN_BACKUP_REPEATS" \
  --liboliphaunt "$OLIPHAUNT" \
  --postgres-bin "$POSTGRES_BIN" \
  --initdb-bin "$INITDB_BIN" \
  --perf-runner "$PERF_RUNNER" \
  > "$RUN_DIR/provenance.path"

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

run_native_liboliphaunt_case() {
  local engine="$1"
  local suite="$2"
  local name="${3:-}"
  if [[ -z "$name" ]]; then
    name="$(native_case_name "$engine" "$suite")"
  fi
  case "$suite" in
    rtt)
      run_timed_json "$name" \
        "$PERF_RUNNER" native-liboliphaunt \
        --engine "$engine" \
        --suite rtt \
        --durability "$DURABILITY" \
        "${TUNING_ARGS[@]}" \
        --iterations "$RTT_ITERATIONS"
      ;;
    speed)
      run_timed_json "$name" \
        "$PERF_RUNNER" native-liboliphaunt \
        --engine "$engine" \
        --suite speed \
        --durability "$DURABILITY" \
        "${TUNING_ARGS[@]}" \
        --speed-source oliphaunt
      ;;
    streaming)
      run_timed_json "$name" \
        "$PERF_RUNNER" native-liboliphaunt \
        --engine "$engine" \
        --suite streaming \
        --durability "$DURABILITY" \
        "${TUNING_ARGS[@]}"
      ;;
    prepared)
      run_timed_json "$name" \
        "$PERF_RUNNER" native-liboliphaunt \
        --engine "$engine" \
        --durability "$DURABILITY" \
        "${TUNING_ARGS[@]}" \
        --suite prepared-updates \
        --rows "$PREPARED_ROWS"
      ;;
    backup)
      run_timed_json "$name" \
        "$PERF_RUNNER" native-liboliphaunt \
        --engine "$engine" \
        --suite backup-restore \
        --durability "$DURABILITY" \
        "${TUNING_ARGS[@]}"
      ;;
  esac
}

run_native_postgres_case() {
  local name="$1"
  local client="$2"
  local suite="$3"
  local args=(
    "$PERF_RUNNER" native-postgres
    --suite "$suite"
    --durability "$DURABILITY"
    "${TUNING_ARGS[@]}"
    --postgres-bin "$POSTGRES_BIN"
    --initdb-bin "$INITDB_BIN"
  )
  if [[ "$suite" == "all" || "$suite" == "rtt" ]]; then
    args+=(--iterations "$RTT_ITERATIONS")
  fi
  if [[ "$suite" == "all" || "$suite" == "speed" ]]; then
    args+=(--speed-source oliphaunt)
  fi
  if [[ -n "$client" ]]; then
    args+=(--client "$client")
  fi
  run_timed_json "$name" "${args[@]}"
}

run_native_postgres_prepared() {
  local name="$1"
  run_timed_json "$name" \
    "$PERF_RUNNER" native-postgres \
    --suite prepared-updates \
    --rows "$PREPARED_ROWS" \
    --durability "$DURABILITY" \
    "${TUNING_ARGS[@]}" \
    --postgres-bin "$POSTGRES_BIN" \
    --initdb-bin "$INITDB_BIN"
}

for suite in rtt speed streaming prepared backup; do
  if ! csv_has "$SUITES" "$suite"; then
    continue
  fi
  if [[ "$suite" == "prepared" && "$RUN_PREPARED" -ne 1 ]]; then
    continue
  fi
  for engine in direct broker server; do
    if csv_has "$NATIVE_ENGINES" "$engine"; then
      run_native_liboliphaunt_case "$engine" "$suite"
    fi
  done
done

if csv_has "$SUITES" rtt && csv_has "$SUITES" speed; then
  run_native_postgres_case native-postgres-tokio-all tokio-postgres-simple all
  run_native_postgres_case native-postgres-sqlx-all sqlx all
else
  if csv_has "$SUITES" rtt; then
    run_native_postgres_case native-postgres-tokio-rtt tokio-postgres-simple rtt
    run_native_postgres_case native-postgres-sqlx-rtt sqlx rtt
  fi
  if csv_has "$SUITES" speed; then
    run_native_postgres_case native-postgres-tokio-speed tokio-postgres-simple speed
    run_native_postgres_case native-postgres-sqlx-speed sqlx speed
  fi
fi

if csv_has "$SUITES" streaming; then
  run_native_postgres_case native-postgres-streaming "" streaming
fi

if csv_has "$SUITES" speed && [[ "$RUN_SQLITE" -eq 1 ]]; then
  run_timed_json sqlite-speed \
    "$PERF_RUNNER" sqlite \
    --suite speed \
    --durability "$DURABILITY" \
    --speed-source oliphaunt
fi

if csv_has "$SUITES" prepared && [[ "$RUN_PREPARED" -eq 1 ]]; then
  run_native_postgres_prepared native-postgres-prepared
fi

if csv_has "$SUITES" backup; then
  run_native_postgres_case native-postgres-backup tokio-postgres-simple backup-restore
  if [[ "$RUN_SQLITE" -eq 1 ]]; then
    run_timed_json sqlite-backup \
      "$PERF_RUNNER" sqlite \
      --suite backup-restore \
      --durability "$DURABILITY"
  fi
fi

if csv_has "$SUITES" prepared && [[ "$RUN_PREPARED" -eq 1 && "$PREPARED_REPEATS" -gt 1 ]]; then
  mkdir -p "$RUN_DIR/repeats"
  for index in $(seq -w 1 "$PREPARED_REPEATS"); do
    run_native_postgres_prepared "repeats/native-postgres-prepared-$index"
    for engine in direct broker server; do
      if csv_has "$NATIVE_ENGINES" "$engine"; then
        run_native_liboliphaunt_case "$engine" prepared "repeats/$(native_case_name "$engine" prepared)-$index"
      fi
    done
  done
fi

if csv_has "$SUITES" rtt && [[ "$RTT_REPEATS" -gt 1 ]]; then
  mkdir -p "$RUN_DIR/repeats"
  for index in $(seq -w 1 "$RTT_REPEATS"); do
    for engine in direct broker server; do
      if csv_has "$NATIVE_ENGINES" "$engine"; then
        run_timed_json "repeats/$(native_case_name "$engine" rtt)-$index" \
          "$PERF_RUNNER" native-liboliphaunt \
          --engine "$engine" \
          --suite rtt \
          --durability "$DURABILITY" \
          "${TUNING_ARGS[@]}" \
          --iterations "$RTT_ITERATIONS"
      fi
    done
    run_native_postgres_case "repeats/native-postgres-tokio-rtt-$index" tokio-postgres-simple rtt
  done
fi

if csv_has "$SUITES" speed && [[ "$SPEED_REPEATS" -gt 1 ]]; then
  mkdir -p "$RUN_DIR/repeats"
  for index in $(seq -w 1 "$SPEED_REPEATS"); do
    for engine in direct broker server; do
      if csv_has "$NATIVE_ENGINES" "$engine"; then
        run_timed_json "repeats/$(native_case_name "$engine" speed)-$index" \
          "$PERF_RUNNER" native-liboliphaunt \
          --engine "$engine" \
          --suite speed \
          --durability "$DURABILITY" \
          "${TUNING_ARGS[@]}" \
          --speed-source oliphaunt
      fi
    done
    run_native_postgres_case "repeats/native-postgres-tokio-speed-$index" tokio-postgres-simple speed
    if [[ "$RUN_SQLITE" -eq 1 ]]; then
      run_timed_json "repeats/sqlite-speed-$index" \
        "$PERF_RUNNER" sqlite \
        --suite speed \
        --durability "$DURABILITY" \
        --speed-source oliphaunt
    fi
  done
fi

if csv_has "$SUITES" backup && [[ "$BACKUP_REPEATS" -gt 1 ]]; then
  mkdir -p "$RUN_DIR/repeats"
  for index in $(seq -w 1 "$BACKUP_REPEATS"); do
    for engine in direct broker server; do
      if csv_has "$NATIVE_ENGINES" "$engine"; then
        run_native_liboliphaunt_case "$engine" backup "repeats/$(native_case_name "$engine" backup)-$index"
      fi
    done
    run_native_postgres_case "repeats/native-postgres-backup-$index" tokio-postgres-simple backup-restore
    if [[ "$RUN_SQLITE" -eq 1 ]]; then
      run_timed_json "repeats/sqlite-backup-$index" \
        "$PERF_RUNNER" sqlite \
        --suite backup-restore \
        --durability "$DURABILITY"
    fi
  done
fi

node "$SCRIPT_DIR/summarize_native_oliphaunt_matrix.mjs" \
  --run-dir "$RUN_DIR" \
  --run-id "$RUN_ID" \
  --postgres-version "$("$POSTGRES_BIN" --version)" \
  --native-engines "$NATIVE_ENGINES" \
  --suites "$SUITES" \
  --durability "$DURABILITY" \
  --runtime-footprint "$RUNTIME_FOOTPRINT" \
  --startup-gucs "$STARTUP_GUCS_CSV" \
  --pgdata-copy-mode "$PGDATA_COPY_MODE" \
  --release-evidence "$RELEASE_EVIDENCE" \
  --partial-report "$PARTIAL_REPORT" \
  --rtt-repeats "$RTT_REPEATS" \
  --prepared-repeats "$PREPARED_REPEATS" \
  --speed-repeats "$SPEED_REPEATS" \
  --backup-repeats "$BACKUP_REPEATS" \
  > "$RUN_DIR/report.md"

echo "$RUN_DIR/report.md"
