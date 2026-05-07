#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TARGET_DIR="$REPO_ROOT/target/perf"
NODE_BENCH_DIR="$SCRIPT_DIR/node-bench"

RUN_ID="${1:-$(date -u +%Y%m%dT%H%M%SZ)}"

POSTGRES_BIN="${PGLITE_OXIDE_NATIVE_POSTGRES:-/opt/homebrew/opt/postgresql@18/bin/postgres}"
INITDB_BIN="${PGLITE_OXIDE_NATIVE_INITDB:-/opt/homebrew/opt/postgresql@18/bin/initdb}"

if [[ ! -x "$POSTGRES_BIN" ]]; then
  POSTGRES_BIN="$(command -v postgres)"
fi

if [[ ! -x "$INITDB_BIN" ]]; then
  INITDB_BIN="$(command -v initdb)"
fi

mkdir -p "$TARGET_DIR"

if [[ ! -d "$NODE_BENCH_DIR/node_modules" ]]; then
  (
    cd "$NODE_BENCH_DIR"
    npm install --no-fund --no-audit
  )
fi

OXIDE_JSON="$TARGET_DIR/bench-oxide-$RUN_ID.json"
NATIVE_JSON="$TARGET_DIR/bench-native-postgres-sqlx-$RUN_ID.json"
NODE_JSON="$TARGET_DIR/bench-pglite-nodefs-sqlx-$RUN_ID.json"
NODE_READY_JSON="$TARGET_DIR/bench-pglite-nodefs-sqlx-ready-$RUN_ID.json"
NODE_LOG="$TARGET_DIR/bench-pglite-nodefs-sqlx-$RUN_ID.log"
REPORT_MD="$TARGET_DIR/bench-comparison-$RUN_ID.md"

NATIVE_VERSION="$("$POSTGRES_BIN" --version | sed 's/^postgres (PostgreSQL) //')"
OS_LABEL="$(uname -smr)"
if command -v sw_vers >/dev/null 2>&1; then
  OS_LABEL="$(sw_vers -productName) $(sw_vers -productVersion) (${OS_LABEL})"
fi
CPU_LABEL="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m)"
RAM_LABEL="$(
  python3 - <<'PY'
import os
try:
    mem = int(os.popen('sysctl -n hw.memsize').read().strip())
    print(f"{mem/1024/1024/1024:.0f} GB")
except Exception:
    print("unknown")
PY
)"
CORES_LABEL="$(sysctl -n hw.ncpu 2>/dev/null || getconf _NPROCESSORS_ONLN || echo unknown)"

echo "Running oxide benchmark suite..."
cargo run --release -p xtask -- perf bench \
  --suite all \
  --mode server-sqlx \
  --iterations 100 \
  --speed-source pglite \
  > "$OXIDE_JSON"

echo "Running native Postgres SQLx benchmark suite..."
cargo run --release -p xtask -- perf native-postgres \
  --suite all \
  --iterations 100 \
  --speed-source pglite \
  --client sqlx \
  --postgres-bin "$POSTGRES_BIN" \
  --initdb-bin "$INITDB_BIN" \
  > "$NATIVE_JSON"

echo "Starting PGlite NodeFS socket server..."
node "$NODE_BENCH_DIR/start_nodefs_socket.mjs" \
  --ready "$NODE_READY_JSON" \
  --run-id "$RUN_ID" \
  > "$NODE_LOG" 2>&1 &
NODE_PID="$!"
cleanup_node_server() {
  if kill -0 "$NODE_PID" >/dev/null 2>&1; then
    kill "$NODE_PID" >/dev/null 2>&1 || true
    wait "$NODE_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup_node_server EXIT

for _ in $(seq 1 300); do
  if [[ -s "$NODE_READY_JSON" ]]; then
    break
  fi
  if ! kill -0 "$NODE_PID" >/dev/null 2>&1; then
    cat "$NODE_LOG" >&2 || true
    echo "PGlite NodeFS socket server exited before becoming ready" >&2
    exit 1
  fi
  sleep 0.1
done

if [[ ! -s "$NODE_READY_JSON" ]]; then
  cat "$NODE_LOG" >&2 || true
  echo "Timed out waiting for PGlite NodeFS socket server" >&2
  exit 1
fi

NODE_DATABASE_URL="$(node -e "const fs=require('fs'); console.log(JSON.parse(fs.readFileSync(process.argv[1], 'utf8')).databaseUrl)" "$NODE_READY_JSON")"
NODE_OPEN_MICROS="$(node -e "const fs=require('fs'); console.log(JSON.parse(fs.readFileSync(process.argv[1], 'utf8')).openMicros)" "$NODE_READY_JSON")"

echo "Running PGlite NodeFS SQLx benchmark suite..."
cargo run --release -p xtask -- perf pglite-nodefs-sqlx \
  --suite all \
  --iterations 100 \
  --speed-source pglite \
  --database-url "$NODE_DATABASE_URL" \
  --open-micros "$NODE_OPEN_MICROS" \
  > "$NODE_JSON"

cleanup_node_server
trap - EXIT

echo "Building comparison markdown..."
node "$SCRIPT_DIR/build_bench_matrix.mjs" \
  --output "$REPORT_MD" \
  --oxide "$OXIDE_JSON" \
  --native "$NATIVE_JSON" \
  --node "$NODE_JSON" \
  --node-server "$NODE_READY_JSON" \
  --run-id "$RUN_ID" \
  --native-version "$NATIVE_VERSION" \
  --machine-os "$OS_LABEL" \
  --machine-cpu "$CPU_LABEL" \
  --machine-ram "$RAM_LABEL" \
  --machine-cores "$CORES_LABEL"

echo "$REPORT_MD"
