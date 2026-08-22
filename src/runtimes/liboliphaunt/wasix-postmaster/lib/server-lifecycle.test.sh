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

port_file="$fixture/listener.port"
python3 - "$port_file" >"$fixture/listener.log" 2>&1 <<'PY' &
import http.server
import pathlib
import sys

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), http.server.SimpleHTTPRequestHandler)
pathlib.Path(sys.argv[1]).write_text(str(server.server_address[1]), encoding="ascii")
server.serve_forever()
PY
listener_pid="$!"
# Release qualification runs this dependency beside the Rust runtime build on
# three-core macOS runners. Keep fixture startup bounded, but allow for the
# listener process to be descheduled under that intentional contention.
listener_deadline_ms="$(( $(fresh_supervision_now_ms) + 120000 ))"
while [ "$(fresh_supervision_now_ms)" -lt "$listener_deadline_ms" ]; do
  [ -s "$port_file" ] && break
  if ! kill -0 "$listener_pid" 2>/dev/null; then
    cat "$fixture/listener.log" >&2
    echo "test TCP listener exited before publishing its port" >&2
    exit 1
  fi
  sleep 0.05
done
[ -s "$port_file" ] || {
  cat "$fixture/listener.log" >&2
  echo "test TCP listener did not publish its port" >&2
  exit 1
}
port="$(cat "$port_file")"
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
