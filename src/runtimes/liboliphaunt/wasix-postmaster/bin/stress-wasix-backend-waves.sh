#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

attempts="${WASIX_BACKEND_WAVE_ATTEMPTS:-10}"
connections="${WASIX_BACKEND_WAVE_CONNECTIONS:-4}"
iterations="${WASIX_BACKEND_WAVE_ITERATIONS:-32}"
timeout_seconds="${WASIX_BACKEND_WAVE_TIMEOUT:-90}"
start_port="${PGPORT:-55820}"
label="${WASIX_BACKEND_WAVE_LABEL:-backend-wave-$(date -u +%Y%m%dT%H%M%SZ)}"
sealed_carrier=""

usage() {
  cat <<'USAGE'
Usage: stress-wasix-backend-waves.sh [options]

Run repeated fresh-postmaster concurrent connection waves. Each wave proves
distinct overlapping PostgreSQL backends plus indexed insert/update progress.

Options:
  --attempts N       Fresh postmaster waves. Default: 10.
  --connections N    Concurrent libpq clients per wave. Default: 4.
  --iterations N     Rows inserted and updated per client. Default: 32.
  --timeout SECONDS  Client fanout deadline per wave. Default: 90.
  --start-port PORT  First TCP port candidate. Default: PGPORT or 55820.
  --label NAME       Report label prefix.
  --sealed-carrier DIR
                     Run every wave through the exact release carrier.
  -h, --help         Show this help.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --attempts|--connections|--iterations|--timeout|--start-port|--label|--sealed-carrier)
      option="$1"
      shift
      [ "$#" -gt 0 ] || { printf '%s requires a value\n' "$option" >&2; exit 2; }
      case "$option" in
        --attempts) attempts="$1" ;;
        --connections) connections="$1" ;;
        --iterations) iterations="$1" ;;
        --timeout) timeout_seconds="$1" ;;
        --start-port) start_port="$1" ;;
        --label) label="$1" ;;
        --sealed-carrier)
          [ -z "$sealed_carrier" ] || {
            echo '--sealed-carrier may only be specified once' >&2
            exit 2
          }
          sealed_carrier="$1"
          ;;
      esac
      ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

for value in "$attempts" "$connections" "$iterations" "$timeout_seconds" "$start_port"; do
  case "$value" in ''|*[!0-9]*|0) echo 'numeric options require positive integers' >&2; exit 2 ;; esac
done
[ "$start_port" -le 65535 ] || {
  echo 'backend-wave start port exceeds 65535' >&2
  exit 2
}
case "$label" in
  ''|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*) echo 'invalid backend-wave label' >&2; exit 2 ;;
esac
[ -n "$sealed_carrier" ] || {
  echo '--sealed-carrier is required for product stress qualification' >&2
  exit 2
}
[ -d "$sealed_carrier" ] && [ ! -L "$sealed_carrier" ] || {
  printf 'invalid sealed carrier: %s\n' "$sealed_carrier" >&2
  exit 2
}
sealed_carrier="$(cd "$sealed_carrier" && pwd -P)"

select_available_port() {
  local candidate="$1"

  python3 - "$candidate" <<'PY'
import socket
import sys

candidate = int(sys.argv[1])
for port in range(candidate, 65536):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        try:
            listener.bind(("127.0.0.1", port))
        except OSError:
            continue
        print(port)
        raise SystemExit(0)
raise SystemExit("no available backend-wave TCP port remains")
PY
}

next_port="$start_port"
for ((attempt = 1; attempt <= attempts; attempt++)); do
  port="$(select_available_port "$next_port")"
  if [ "$port" -ne "$next_port" ]; then
    printf 'backend-wave port %s is occupied; selected %s\n' "$next_port" "$port"
  fi
  next_port=$((port + 1))
  printf '==> WASIX backend wave %s/%s\n' "$attempt" "$attempts"
  WASIX_SKIP_PRECOMPILE=1 \
    "$FRESH_ROOT/bin/smoke-wasix-concurrent-connections.sh" \
      --connections "$connections" \
      --iterations "$iterations" \
      --hold-seconds 0.5 \
      --timeout "$timeout_seconds" \
      --port "$port" \
      --label "$label-$attempt" \
      --skip-build \
      --skip-precompile \
      --sealed-carrier "$sealed_carrier"
done

printf 'WASIX backend waves passed: %s/%s\n' "$attempts" "$attempts"
