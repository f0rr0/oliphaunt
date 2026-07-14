#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)"; then
  :
else
  REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
IDS=""
REPEATS=10
DURABILITY="${OLIPHAUNT_PERF_DURABILITY:-safe}"
BUILD_PERF_RUNNER=1

usage() {
  cat >&2 <<'USAGE'
usage: tools/perf/matrix/run_native_speed_diagnostics.sh --ids LIST [options]

Options:
  --ids LIST       Comma-separated Oliphaunt fixture speed case ids.
  --repeats N     Fresh-process repeats per case. Default: 10.
  --run-id ID     Output run id. Defaults to current UTC timestamp.
  --durability PROFILE
                  Native durability profile: safe, balanced, or fast-dev.
  --skip-build    Reuse target/release/oliphaunt-perf.
  -h, --help      Show this help.

Environment:
  LIBOLIPHAUNT_PATH  Path to liboliphaunt.dylib/.so. Defaults to target artifact.
  OLIPHAUNT_POSTGRES Path to matching postgres binary. Defaults to target artifact.
  OLIPHAUNT_INITDB   Path to matching initdb binary. Defaults to target artifact.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ids)
      IDS="${2:?--ids requires a value}"
      shift 2
      ;;
    --ids=*)
      IDS="${1#--ids=}"
      shift
      ;;
    --repeats)
      REPEATS="${2:?--repeats requires a value}"
      shift 2
      ;;
    --run-id)
      RUN_ID="${2:?--run-id requires a value}"
      shift 2
      ;;
    --durability)
      DURABILITY="${2:?--durability requires a value}"
      shift 2
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

if [[ -z "$IDS" ]]; then
  echo "--ids is required" >&2
  usage
  exit 2
fi
if [[ "$REPEATS" -le 0 ]]; then
  echo "--repeats must be positive" >&2
  exit 2
fi
case "$DURABILITY" in
  safe|balanced|fast-dev) ;;
  *)
    echo "unknown durability profile: $DURABILITY" >&2
    exit 2
    ;;
esac

OLIPHAUNT="${LIBOLIPHAUNT_PATH:-$REPO_ROOT/target/liboliphaunt-pg18/out/liboliphaunt.dylib}"
POSTGRES_BIN="${OLIPHAUNT_POSTGRES:-$REPO_ROOT/target/liboliphaunt-pg18/install/bin/postgres}"
INITDB_BIN="${OLIPHAUNT_INITDB:-$REPO_ROOT/target/liboliphaunt-pg18/install/bin/initdb}"
PERF_RUNNER="$REPO_ROOT/target/release/oliphaunt-perf"

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

if [[ "$BUILD_PERF_RUNNER" -eq 1 ]]; then
  cargo build --release -p oliphaunt-perf -p oliphaunt --bins
elif [[ ! -x "$PERF_RUNNER" ]]; then
  echo "missing release oliphaunt-perf: $PERF_RUNNER" >&2
  exit 1
fi

RUN_DIR="$REPO_ROOT/target/perf/native-speed-diagnostics-$RUN_ID"
mkdir -p "$RUN_DIR/direct" "$RUN_DIR/native-postgres"

IFS=',' read -r -a ID_LIST <<< "${IDS//[[:space:]]/}"
for id in "${ID_LIST[@]}"; do
  if [[ -z "$id" ]]; then
    echo "--ids must not contain empty entries" >&2
    exit 2
  fi
done

safe_id() {
  printf '%s\n' "${1//./_}"
}

for repeat in $(seq -w 1 "$REPEATS"); do
  echo "Running native-postgres speed diagnostics repeat $repeat..."
  "$PERF_RUNNER" diagnose-speed-cases \
    --engine native-postgres \
    --ids "$IDS" \
    --durability "$DURABILITY" \
    --postgres-bin "$POSTGRES_BIN" \
    --initdb-bin "$INITDB_BIN" \
    > "$RUN_DIR/native-postgres/native-postgres-speed-cases-$repeat.json" \
    2> "$RUN_DIR/native-postgres/native-postgres-speed-cases-$repeat.err"

  for id in "${ID_LIST[@]}"; do
    id_file="$(safe_id "$id")"
    echo "Running native-liboliphaunt speed diagnostic case $id repeat $repeat..."
    LIBOLIPHAUNT_PATH="$OLIPHAUNT" \
    OLIPHAUNT_INSTALL_DIR="$(dirname "$(dirname "$POSTGRES_BIN")")" \
    "$PERF_RUNNER" diagnose-speed-cases \
      --engine native-liboliphaunt \
      --ids "$id" \
      --durability "$DURABILITY" \
      > "$RUN_DIR/direct/native-liboliphaunt-speed-case-$id_file-$repeat.json" \
      2> "$RUN_DIR/direct/native-liboliphaunt-speed-case-$id_file-$repeat.err"
  done
done

node "$SCRIPT_DIR/summarize_native_speed_diagnostics.mjs" \
  --run-dir "$RUN_DIR" \
  --ids "$IDS" \
  --repeats "$REPEATS"

echo "$RUN_DIR/summary.md"
