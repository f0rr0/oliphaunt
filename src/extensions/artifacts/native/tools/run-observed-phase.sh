#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: run-observed-phase.sh --label LABEL --log PATH -- COMMAND [ARG...]
EOF
}

label=""
log_path=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --label)
      [ "$#" -ge 2 ] || { usage; exit 2; }
      label="$2"
      shift 2
      ;;
    --log)
      [ "$#" -ge 2 ] || { usage; exit 2; }
      log_path="$2"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [ -z "$label" ] || [ -z "$log_path" ] || [ "$#" -eq 0 ]; then
  usage
  exit 2
fi

heartbeat_seconds="${OLIPHAUNT_PHASE_HEARTBEAT_SECONDS:-60}"
case "$heartbeat_seconds" in
  ""|0|*[!0-9]*)
    echo "run-observed-phase.sh: OLIPHAUNT_PHASE_HEARTBEAT_SECONDS must be a positive integer" >&2
    exit 2
    ;;
esac

mkdir -p "$(dirname "$log_path")"

child_pid=""
child_pgid=""
heartbeat_pid=""
# Invoked indirectly by the signal/exit traps below.
# shellcheck disable=SC2317
stop_heartbeat() {
  if [ -n "$heartbeat_pid" ]; then
    kill "$heartbeat_pid" 2>/dev/null || true
    wait "$heartbeat_pid" 2>/dev/null || true
    heartbeat_pid=""
  fi
}

# Every observed command runs as a separate background job while monitor mode
# is enabled, which gives it a process group whose id is the job leader pid.
# Terminating that group prevents compilers and nested build shells from
# continuing to mutate the workspace after a step timeout or cancellation.
# shellcheck disable=SC2317
terminate_child_group() {
  local signal="${1:-TERM}"
  local _attempt
  if [ -z "$child_pgid" ]; then
    return 0
  fi
  kill -s "$signal" -- "-$child_pgid" 2>/dev/null || true
  for _attempt in 1 2 3; do
    if ! kill -0 -- "-$child_pgid" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  if kill -0 -- "-$child_pgid" 2>/dev/null; then
    kill -KILL -- "-$child_pgid" 2>/dev/null || true
  fi
  if [ -n "$child_pid" ]; then
    wait "$child_pid" 2>/dev/null || true
  fi
  child_pid=""
  child_pgid=""
}

# shellcheck disable=SC2317
cleanup() {
  local status="$?"
  trap - EXIT INT TERM HUP
  stop_heartbeat
  terminate_child_group TERM
  exit "$status"
}

# shellcheck disable=SC2317
interrupt() {
  local signal="$1"
  local status="$2"
  local finished_epoch record
  trap - EXIT INT TERM HUP
  stop_heartbeat
  finished_epoch="$(date +%s)"
  record="==> phase-interrupted timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ) label=$label elapsed_seconds=$((finished_epoch - started_epoch)) signal=$signal status=$status log=$log_path"
  printf '%s\n' "$record" >&2
  terminate_child_group "$signal"
  printf '%s\n' "$record" >>"$log_path"
  if [ -s "$log_path" ]; then
    echo "run-observed-phase.sh: last 80 captured output lines:" >&2
    tail -n 80 "$log_path" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'interrupt INT 130' INT
trap 'interrupt TERM 143' TERM
trap 'interrupt HUP 129' HUP

started_epoch="$(date +%s)"
printf '==> phase-start timestamp=%s label=%s log=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$label" "$log_path"

# Bash monitor mode makes this background job the leader of a distinct process
# group even in a non-interactive shell. Disable it immediately after launch so
# it cannot alter the remainder of the wrapper's execution semantics.
set -m
"$@" >"$log_path" 2>&1 &
child_pid="$!"
child_pgid="$child_pid"
set +m
(
  while sleep "$heartbeat_seconds"; do
    kill -0 "$child_pid" 2>/dev/null || exit 0
    now_epoch="$(date +%s)"
    printf '==> phase-heartbeat timestamp=%s label=%s elapsed_seconds=%s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$label" "$((now_epoch - started_epoch))"
  done
) &
heartbeat_pid="$!"

if wait "$child_pid"; then
  status=0
else
  status="$?"
fi
child_pid="" child_pgid=""
kill "$heartbeat_pid" 2>/dev/null || true
wait "$heartbeat_pid" 2>/dev/null || true
heartbeat_pid=""

finished_epoch="$(date +%s)"
if [ "$status" -eq 0 ]; then
  printf '==> phase-complete timestamp=%s label=%s elapsed_seconds=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$label" "$((finished_epoch - started_epoch))"
else
  printf '==> phase-failed timestamp=%s label=%s elapsed_seconds=%s status=%s log=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$label" "$((finished_epoch - started_epoch))" "$status" "$log_path" >&2
  if [ -s "$log_path" ]; then
    echo "run-observed-phase.sh: last 80 captured output lines:" >&2
    tail -n 80 "$log_path" >&2
  fi
fi

exit "$status"
