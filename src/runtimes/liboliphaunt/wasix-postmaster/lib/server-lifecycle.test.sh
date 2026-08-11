#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$root/process-supervision.sh"
source "$root/server-lifecycle.sh"

fixture="$(mktemp -d)"
cleanup() {
  [ -z "${listener_pid:-}" ] || kill "$listener_pid" 2>/dev/null || true
  [ -z "${listener_pid:-}" ] || wait "$listener_pid" 2>/dev/null || true
  rm -rf -- "$fixture"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$fixture/empty" "$fixture/busy"
: >"$fixture/empty/cgroup.procs"
printf '123\n' >"$fixture/busy/cgroup.procs"
empty_identity="$(fresh_path_identity "$fixture/empty")"
busy_identity="$(fresh_path_identity "$fixture/busy")"
fresh_wait_cgroup_empty "$fixture/empty" "$empty_identity" 10
if fresh_wait_cgroup_empty "$fixture/busy" "$busy_identity" 10 >/dev/null 2>&1; then
  echo "busy cgroup fixture passed residue gate" >&2
  exit 1
fi
if fresh_wait_cgroup_empty "$fixture/empty" wrong-identity 10 >/dev/null 2>&1; then
  echo "reused cgroup identity passed residue gate" >&2
  exit 1
fi

port=$((42000 + ($$ % 10000)))
fresh_wait_tcp_port_closed 127.0.0.1 "$port" 100
python3 -m http.server "$port" --bind 127.0.0.1 >"$fixture/listener.log" 2>&1 &
listener_pid="$!"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  fresh_tcp_port_open 127.0.0.1 "$port" && break
  sleep 0.05
done
fresh_tcp_port_open 127.0.0.1 "$port"
if fresh_wait_tcp_port_closed 127.0.0.1 "$port" 10 >/dev/null 2>&1; then
  echo "live TCP listener passed residue gate" >&2
  exit 1
fi
kill "$listener_pid"
wait "$listener_pid" 2>/dev/null || true
listener_pid=""
fresh_wait_tcp_port_closed 127.0.0.1 "$port" 1000

printf 'server lifecycle tests passed\n'
