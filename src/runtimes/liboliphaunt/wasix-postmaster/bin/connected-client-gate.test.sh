#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bench="$root/bin/bench-wasix-concurrent-query-suite.sh"
tmp="$(mktemp -d)"
worker_pid=""
cleanup() {
  if [ -n "$worker_pid" ] && kill -0 "$worker_pid" 2>/dev/null; then
    kill "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
  rm -rf -- "$tmp"
}
trap cleanup EXIT

sed -n '/^write_connected_client_script()/,/^run_client_process()/p' "$bench" |
  sed '$d' >"$tmp/write-connected-client-script.sh"
# shellcheck source=/dev/null
source "$tmp/write-connected-client-script.sh"

gate_root="$tmp/gates with a quote'"
mkdir -p "$gate_root"
source_sql="$gate_root/source.sql"
connected_sql="$gate_root/connected.sql"
ready_file="$gate_root/client.ready"
start_gate="$gate_root/fanout.start"
end_file="$gate_root/client.end_ms"
drain_gate="$gate_root/fanout.drain"
finished_file="$gate_root/client.finished"

printf '%s\n' '\set ON_ERROR_STOP 1' 'SELECT 42;' >"$source_sql"
write_connected_client_script "$source_sql" "$connected_sql" \
  "$ready_file" "$start_gate" "$end_file" "$drain_gate"

[ "$(stat -c '%a' "$connected_sql")" = "600" ]
grep -Fxq '\set ON_ERROR_STOP 1' "$connected_sql"
grep -Fxq 'SELECT 42;' "$connected_sql"
mapfile -t gate_commands < <(sed -n 's/^\\! //p' "$connected_sql")
[ "${#gate_commands[@]}" -eq 4 ]

(
  sh -c "${gate_commands[0]}"
  sh -c "${gate_commands[1]}"
  sh -c "${gate_commands[2]}"
  sh -c "${gate_commands[3]}"
  : >"$finished_file"
) &
worker_pid="$!"

for _ in $(seq 1 500); do
  [ -f "$ready_file" ] && break
  sleep 0.01
done
[ -f "$ready_file" ]
kill -0 "$worker_pid"
[ ! -e "$end_file" ]

: >"$start_gate"
for _ in $(seq 1 500); do
  [ -s "$end_file" ] && break
  sleep 0.01
done
[ -s "$end_file" ]
case "$(tr -d '[:space:]' <"$end_file")" in
  '' | *[!0-9]*)
    echo 'completion marker was not a monotonic millisecond timestamp' >&2
    exit 1
    ;;
esac
kill -0 "$worker_pid"
[ ! -e "$finished_file" ]

: >"$drain_gate"
wait "$worker_pid"
worker_pid=""
[ -f "$finished_file" ]

if write_connected_client_script "$source_sql" "$connected_sql" \
  "$ready_file" "$start_gate" "$end_file" "$drain_gate" 2>/dev/null; then
  echo 'connected-client generation overwrote an existing script' >&2
  exit 1
fi

symlink_source="$gate_root/source-link.sql"
ln -s "$source_sql" "$symlink_source"
if write_connected_client_script "$symlink_source" "$gate_root/from-link.sql" \
  "$gate_root/link.ready" "$gate_root/link.start" "$gate_root/link.end" \
  "$gate_root/link.drain" 2>/dev/null; then
  echo 'connected-client generation accepted a symlink SQL source' >&2
  exit 1
fi

echo 'connected client gate tests passed'
