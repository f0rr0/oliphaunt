#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
qualifier="$root/bin/qualify-wasix-cold-ownership.sh"
bench="$root/bin/bench-wasix-concurrent-query-suite.sh"
temp="$(mktemp -d)"
cleanup() {
  [ ! -d "$temp/dynamic-carrier" ] || chmod 0755 "$temp/dynamic-carrier" 2>/dev/null || true
  [ ! -d "$temp/dynamic-pgdata" ] || chmod 0755 "$temp/dynamic-pgdata" 2>/dev/null || true
  chmod -R u+rwX "$temp" 2>/dev/null || true
  rm -rf -- "$temp"
}
trap cleanup EXIT HUP INT TERM
mkdir -p "$temp/carrier"

if "$qualifier" --sealed-carrier "$temp/carrier" --blocks 5 --print-plan \
  >"$temp/missing-receipt.out" 2>"$temp/missing-receipt.err"; then
  echo "cold qualifier accepted no immutable deployment receipt" >&2
  exit 1
fi
grep -Fq -- '--immutable-carrier-receipt is required' \
  "$temp/missing-receipt.err"
grep -Fq -- '--require-zero-write-aot' "$qualifier"
grep -Fq -- '--immutable-carrier-receipt "$immutable_carrier_receipt"' \
  "$qualifier"
grep -Fq 'required_snapshot_mode\tdirect-immutable-inode' "$qualifier"
grep -Fq 'global_drop_caches\tforbidden' "$qualifier"
grep -Fq -- '--immutable-carrier-verification-scope campaign-fast' "$qualifier"
grep -Fq -- '--cold-ownership-workloads' "$bench"
grep -Fq 'cold_ownership_mode=whole-lifecycle' "$bench"
grep -Fq 'oliphaunt.wasix-postmaster.cold-ownership-mode.v1' "$bench"

if "$qualifier" --sealed-carrier "$temp/carrier" --blocks 4 --print-plan \
  >"$temp/short.out" 2>"$temp/short.err"; then
  echo "cold qualifier accepted fewer than five independent blocks" >&2
  exit 1
fi
grep -Fq 'at least 5' "$temp/short.err"

if "$bench" --cold-ownership --resource-detail full \
  >"$temp/bench.out" 2>"$temp/bench.err"; then
  echo "cold bench accepted missing cgroup limits and sealed carrier" >&2
  exit 1
fi
grep -Fq 'requires explicit cgroup MemoryMax' "$temp/bench.err"

# Execute the actual start_wasix_server function with the roots made unreadable
# immediately after the real mincore helper returns. Any accidental verifier,
# hash, stat, or content open before the mocked exec boundary then fails.
sed -n '/^start_wasix_server()/,/^run_client_process()/p' "$bench" |
  sed '$d' >"$temp/start-wasix-server.sh"
# shellcheck source=/dev/null
source "$temp/start-wasix-server.sh"
dynamic_carrier="$temp/dynamic-carrier"
dynamic_pgdata="$temp/dynamic-pgdata"
mkdir -p "$dynamic_carrier/bin" "$dynamic_pgdata"
printf 'sealed runtime fixture\n' >"$dynamic_carrier/bin/wasmer-headless"
chmod 0555 "$dynamic_carrier/bin/wasmer-headless" "$dynamic_carrier/bin" \
  "$dynamic_carrier"
dynamic_receipt="$temp/dynamic-cold-receipt.json"
FRESH_ROOT="$root"
sealed_carrier_root="$dynamic_carrier"
sealed_manifest_hash="$(printf manifest | sha256sum | awk '{ print $1 }')"
sealed_receipt_hash="$(printf receipt | sha256sum | awk '{ print $1 }')"
sealed_payload_inventory_hash="$(printf payload | sha256sum | awk '{ print $1 }')"
execution_identity_sha256="$(printf execution | sha256sum | awk '{ print $1 }')"
cold_ownership=1
wasix_perf_stats=0
wasix_wait_dump_interval_ms=0
wasix_lifecycle_plateau=0
wasix_runtime_mode=sealed-headless
require_zero_write_aot=0
timeout_seconds=1
connections=1
effective_postgres_gucs=()
wasmer_env=()
wasmer_args=()
wasmer_env_command=(env)
wasmer_bin="$dynamic_carrier/bin/wasmer-headless"
wasix_initdb_module="$dynamic_carrier/bin/wasmer-headless"
wasix_postgres_module="$dynamic_carrier/bin/wasmer-headless"
roots_locked=0
build_wasmer_args() {
  wasmer_env=()
  wasmer_args=()
  wasmer_env_command=(env)
}
run_logged_timeout() {
  printf '%s\n' "$*" >"$temp/initdb-command"
  mkdir -p "$dynamic_pgdata/base"
  printf '18\n' >"$dynamic_pgdata/PG_VERSION"
  printf 'relation data\n' >"$dynamic_pgdata/base/1"
}
now_ns() { printf '1000000000\n'; }
python3() {
  command python3 "$@"
  local status=$?
  [ "$status" -eq 0 ] || return "$status"
  if [ "$1" = "$FRESH_ROOT/bin/prove-linux-cold-residency.py" ]; then
    find "$dynamic_carrier" "$dynamic_pgdata" -type f -exec chmod 000 {} +
    roots_locked=1
  fi
}
fresh_spawn_process_group() {
  [ "$roots_locked" -eq 1 ]
  [ ! -r "$dynamic_carrier/bin/wasmer-headless" ]
  [ ! -r "$dynamic_pgdata/PG_VERSION" ]
  printf '%s\n' "$*" >"$temp/server-command"
  FRESH_PROCESS_GROUP_PID=42
  FRESH_PROCESS_GROUP_PGID=42
  FRESH_PROCESS_GROUP_IDENTITY=fixture:42
}
start_wasix_server "$dynamic_pgdata" "$temp/dev-shm" 15432 \
  "$temp/initdb.log" "$temp/server.log" "$temp/initdb-perf.log" \
  "$temp/server-perf.log" "$temp/limits" "$temp/fence.request" \
  "$temp/fence.ack" "$dynamic_receipt" "$temp/sealed-loader-audit.jsonl" \
  "$temp/cache-offers-initdb.json" "$temp/cache-offers-postgres.json"
[ "$started_server_pid" = 42 ] && [ -s "$dynamic_receipt" ]
grep -Fq "OLIPHAUNT_WASIX_CACHE_OFFER_TELEMETRY_FILE=$temp/cache-offers-initdb.json" \
  "$temp/initdb-command"
grep -Fq "OLIPHAUNT_WASIX_CACHE_OFFER_TELEMETRY_FILE=$temp/cache-offers-postgres.json" \
  "$temp/server-command"
chmod 0755 "$dynamic_carrier" "$dynamic_pgdata"
find "$dynamic_carrier" "$dynamic_pgdata" -depth -exec chmod u+rwX {} +

if grep -Eq 'drop_caches|malloc_trim' "$qualifier"; then
  # The help/plan intentionally names drop_caches as forbidden. Only an actual
  # procfs write or allocator call is prohibited.
  grep -Eq '/proc/sys/vm/drop_caches|malloc_trim[[:space:]]*\(' "$qualifier" && {
    echo "cold qualifier contains a forbidden global cache/allocator operation" >&2
    exit 1
  }
fi

printf 'cold ownership qualifier policy tests passed\n'
