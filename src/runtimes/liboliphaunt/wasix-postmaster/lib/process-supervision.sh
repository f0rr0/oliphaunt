#!/usr/bin/env bash

# Supervised product lifecycle commands must own a dedicated process group.
# Killing only the shell's direct child can leave psql, Wasmer, or another
# helper running after its evidence row has already been classified as timed
# out. These helpers keep process-group creation, bounded escalation, direct
# child reaping, and residue checks under one contract.

FRESH_PROCESS_GROUP_PID=""
FRESH_PROCESS_GROUP_PGID=""
# Set for live long-running children; consumed by server lifecycle callers.
# shellcheck disable=SC2034
FRESH_PROCESS_GROUP_IDENTITY=""
FRESH_PROCESS_GROUP_WAIT_STATUS=""
FRESH_PROCESS_GROUP_LAST_PID=""
FRESH_PROCESS_GROUP_LAST_PGID=""

fresh_supervision_now_ms() {
  perl -MTime::HiRes=clock_gettime,CLOCK_MONOTONIC \
    -e 'printf "%.0f\n", clock_gettime(CLOCK_MONOTONIC) * 1000'
}

fresh_supervision_pid_running() {
  local pid="$1"
  local state

  kill -0 "$pid" 2>/dev/null || return 1
  state="$(ps -o stat= -p "$pid" 2>/dev/null | awk 'NR == 1 { print $1 }')"
  case "$state" in
    ""|Z*) return 1 ;;
    *) return 0 ;;
  esac
}

# Return an immutable birth identity for a live process. Linux /proc starttime is
# monotonic since boot and survives exec, which is exactly what server launch via
# systemd-run needs. The ps fallback covers non-Linux development hosts.
fresh_process_birth_identity() {
  local pid="$1"
  local kernel stat_line remainder starttime started
  local -a stat_fields

  case "$pid" in ""|0|*[!0-9]*) return 1 ;; esac
  # Prefer the Linux procfs identity without spawning `uname` and `awk` for
  # every PID.  The full-memory sampler checks every process twice per row;
  # external parsing made its cost scale with dozens of short-lived host
  # processes instead of the measured tree itself.
  if [ -r "/proc/$pid/stat" ]; then
    stat_line="$(<"/proc/$pid/stat")" || return 1
    case "$stat_line" in *') '*) ;; *) return 1 ;; esac
    remainder="${stat_line##*) }"
    read -r -a stat_fields <<<"$remainder"
    [ "${#stat_fields[@]}" -ge 20 ] || return 1
    starttime="${stat_fields[19]}"
    case "$starttime" in ""|*[!0-9]*) return 1 ;; esac
    printf 'linux-starttime:%s\n' "$starttime"
    return 0
  fi
  kernel="$(uname -s 2>/dev/null || printf unknown)"
  started="$(ps -o lstart= -p "$pid" 2>/dev/null | awk '{$1=$1; print; exit}')"
  [ -n "$started" ] || return 1
  printf '%s-lstart:%s\n' "$kernel" "$started"
}

fresh_pid_matches_birth_identity() {
  local pid="$1"
  local expected="$2"
  local actual

  actual="$(fresh_process_birth_identity "$pid" 2>/dev/null)" || return 1
  [ "$actual" = "$expected" ]
}

fresh_signal_owned_pid() {
  local signal="$1"
  local pid="$2"
  local identity="$3"

  if ! fresh_supervision_pid_running "$pid"; then
    return 0
  fi
  if [ "$(uname -s 2>/dev/null || true)" = Linux ]; then
    python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/signal-owned-pid.py" \
      --signal "$signal" --pid "$pid" --identity "$identity"
    return
  fi
  if ! fresh_pid_matches_birth_identity "$pid" "$identity"; then
    printf 'refusing to signal reused process identity: pid=%s expected=%s\n' \
      "$pid" "$identity" >&2
    return 125
  fi
  kill "-$signal" "$pid"
}

fresh_process_group_exists() {
  local pgid="${1:-}"

  case "$pgid" in
    ""|0|*[!0-9]*) return 1 ;;
  esac
  kill -0 -- "-$pgid" 2>/dev/null
}

fresh_reap_process_group_leader() {
  local pid="$1"
  local wait_status

  if wait "$pid" 2>/dev/null; then
    wait_status=0
  else
    wait_status=$?
  fi
  FRESH_PROCESS_GROUP_WAIT_STATUS="$wait_status"
  return 0
}

fresh_terminate_unisolated_leader() {
  local pid="$1"
  local term_grace_ms="${WASIX_PROCESS_TERM_GRACE_MS:-1000}"
  local kill_grace_ms="${WASIX_PROCESS_KILL_GRACE_MS:-3000}"
  local deadline

  case "$term_grace_ms:$kill_grace_ms" in
    *[!0-9:]*|:*)
      echo "process-group grace periods must be nonnegative integer milliseconds" >&2
      return 125
      ;;
  esac

  kill -TERM "$pid" 2>/dev/null || true
  deadline=$(( $(fresh_supervision_now_ms) + term_grace_ms ))
  while fresh_supervision_pid_running "$pid" &&
    [ "$(fresh_supervision_now_ms)" -lt "$deadline" ]; do
    sleep 0.05
  done
  if fresh_supervision_pid_running "$pid"; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  deadline=$(( $(fresh_supervision_now_ms) + kill_grace_ms ))
  while fresh_supervision_pid_running "$pid" &&
    [ "$(fresh_supervision_now_ms)" -lt "$deadline" ]; do
    sleep 0.05
  done
  fresh_supervision_pid_running "$pid" && return 125
  fresh_reap_process_group_leader "$pid"
}

fresh_spawn_process_group() {
  local pid actual_pgid own_pgid identity attempt monitor_was_on=0

  FRESH_PROCESS_GROUP_PID=""
  FRESH_PROCESS_GROUP_PGID=""
  FRESH_PROCESS_GROUP_IDENTITY=""
  [ "${1:-}" = "--" ] || {
    echo "fresh_spawn_process_group requires -- before the command" >&2
    return 125
  }
  shift
  [ "$#" -gt 0 ] || {
    echo "fresh_spawn_process_group requires a command" >&2
    return 125
  }

  # In a non-interactive Bash shell, monitor mode makes each background job
  # the leader of a distinct process group. Disable it immediately after the
  # fork so the remainder of the lifecycle runner retains normal script semantics.
  case "$-" in
    *m*) monitor_was_on=1 ;;
  esac
  if [ "$monitor_was_on" -eq 0 ]; then
    if ! set -m 2>/dev/null; then
      echo "could not enable Bash monitor mode for process-group isolation" >&2
      return 125
    fi
  fi
  # A supervised command is deliberately placed in its own background process
  # group.  Letting that group inherit a controlling terminal as stdin makes a
  # read stop it with SIGTTIN, leaving an otherwise healthy command parked
  # until its timeout. Supervised product and server commands are
  # non-interactive, so detach stdin at the process-ownership boundary.
  "$@" </dev/null &
  pid=$!
  if [ "$monitor_was_on" -eq 0 ]; then
    set +m
  fi

  actual_pgid=""
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    : "$attempt"
    if ! fresh_supervision_pid_running "$pid"; then
      break
    fi
    actual_pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
    [ -z "$actual_pgid" ] || break
    sleep 0.01
  done
  if fresh_supervision_pid_running "$pid" && [ "$actual_pgid" != "$pid" ]; then
    fresh_terminate_unisolated_leader "$pid" || true
    printf 'live supervised child %s does not own process group %s\n' \
      "$pid" "${actual_pgid:-unknown}" >&2
    return 125
  fi
  own_pgid="$(ps -o pgid= -p "$$" 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$own_pgid" ] && [ "$own_pgid" = "$pid" ]; then
    fresh_terminate_unisolated_leader "$pid" || true
    printf 'refusing to supervise child %s in the lifecycle-runner process group\n' "$pid" >&2
    return 125
  fi
  identity="$(fresh_process_birth_identity "$pid" 2>/dev/null || true)"
  if [ -z "$identity" ] && fresh_supervision_pid_running "$pid"; then
    fresh_terminate_process_group "$pid" "$pid" || true
    printf 'could not capture supervised child birth identity: pid=%s\n' "$pid" >&2
    return 125
  fi

  FRESH_PROCESS_GROUP_PID="$pid"
  FRESH_PROCESS_GROUP_PGID="$pid"
  # shellcheck disable=SC2034
  FRESH_PROCESS_GROUP_IDENTITY="$identity"
  # Read by product-owned tests and callers that need post-run residue proof.
  # shellcheck disable=SC2034
  FRESH_PROCESS_GROUP_LAST_PID="$pid"
  # shellcheck disable=SC2034
  FRESH_PROCESS_GROUP_LAST_PGID="$pid"
}

fresh_terminate_process_group() {
  local pgid="$1"
  local leader_pid="$2"
  local term_grace_ms="${3:-${WASIX_PROCESS_TERM_GRACE_MS:-1000}}"
  local kill_grace_ms="${4:-${WASIX_PROCESS_KILL_GRACE_MS:-3000}}"
  local own_pgid deadline now leader_reaped=0

  case "$pgid:$leader_pid" in
    *[!0-9:]*|:*)
      echo "process-group termination requires numeric PGID and leader PID" >&2
      return 125
      ;;
  esac
  [ "$pgid" -gt 0 ] && [ "$pgid" = "$leader_pid" ] || {
    printf 'refusing unsafe process-group identity pgid=%s leader=%s\n' \
      "$pgid" "$leader_pid" >&2
    return 125
  }
  case "$term_grace_ms:$kill_grace_ms" in
    *[!0-9:]*|:*)
      echo "process-group grace periods must be nonnegative integer milliseconds" >&2
      return 125
      ;;
  esac
  own_pgid="$(ps -o pgid= -p "$$" 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$own_pgid" ] && [ "$own_pgid" = "$pgid" ]; then
    printf 'refusing to signal the lifecycle-runner process group %s\n' "$pgid" >&2
    return 125
  fi

  if fresh_process_group_exists "$pgid"; then
    kill -TERM -- "-$pgid" 2>/dev/null || true
  fi
  deadline=$(( $(fresh_supervision_now_ms) + term_grace_ms ))
  while fresh_process_group_exists "$pgid"; do
    if [ "$leader_reaped" -eq 0 ] && ! fresh_supervision_pid_running "$leader_pid"; then
      fresh_reap_process_group_leader "$leader_pid"
      leader_reaped=1
    fi
    now="$(fresh_supervision_now_ms)"
    [ "$now" -lt "$deadline" ] || break
    sleep 0.05
  done

  if fresh_process_group_exists "$pgid"; then
    kill -KILL -- "-$pgid" 2>/dev/null || true
  fi
  deadline=$(( $(fresh_supervision_now_ms) + kill_grace_ms ))
  while fresh_process_group_exists "$pgid"; do
    if [ "$leader_reaped" -eq 0 ] && ! fresh_supervision_pid_running "$leader_pid"; then
      fresh_reap_process_group_leader "$leader_pid"
      leader_reaped=1
    fi
    now="$(fresh_supervision_now_ms)"
    [ "$now" -lt "$deadline" ] || break
    sleep 0.05
  done

  if [ "$leader_reaped" -eq 0 ] && ! fresh_supervision_pid_running "$leader_pid"; then
    fresh_reap_process_group_leader "$leader_pid"
    leader_reaped=1
  fi
  if fresh_process_group_exists "$pgid" || fresh_supervision_pid_running "$leader_pid"; then
    printf 'process group %s survived bounded SIGTERM/SIGKILL escalation\n' "$pgid" >&2
    return 125
  fi
  if [ "$leader_reaped" -eq 0 ]; then
    fresh_reap_process_group_leader "$leader_pid"
  fi
  return 0
}

# Identity-checked wrapper for a process group whose PGID is its original
# leader PID. A live PID that no longer has the captured birth identity is never
# signalled or waited: it belongs to somebody else. Linux does not recycle a
# numeric process-group ID while members of that group remain, so descendants
# remain safe to terminate after the original leader exits.
fresh_terminate_owned_process_group() {
  local pgid="$1"
  local leader_pid="$2"
  local leader_identity="$3"
  local term_grace_ms="${4:-${WASIX_PROCESS_TERM_GRACE_MS:-1000}}"
  local kill_grace_ms="${5:-${WASIX_PROCESS_KILL_GRACE_MS:-3000}}"

  [ "$pgid" = "$leader_pid" ] || {
    printf 'owned process group identity differs: pgid=%s leader=%s\n' \
      "$pgid" "$leader_pid" >&2
    return 125
  }
  if fresh_supervision_pid_running "$leader_pid" &&
    ! fresh_pid_matches_birth_identity "$leader_pid" "$leader_identity"; then
    if fresh_process_group_exists "$pgid"; then
      printf 'refusing to terminate reused process group %s\n' "$pgid" >&2
      return 125
    fi
    return 0
  fi
  fresh_process_group_exists "$pgid" || {
    if fresh_pid_matches_birth_identity "$leader_pid" "$leader_identity"; then
      fresh_reap_process_group_leader "$leader_pid"
    fi
    return 0
  }
  fresh_terminate_process_group \
    "$pgid" "$leader_pid" "$term_grace_ms" "$kill_grace_ms"
}

# Ask an identity-owned process-group leader to stop, allow the complete group
# to drain, and bound escalation if the application cannot shut down cleanly.
# A forced cleanup returns 124 even when SIGKILL removed every process so
# qualification cannot mistake teardown recovery for a graceful lifecycle.
fresh_stop_owned_process_group() {
  local signal="$1"
  local pgid="$2"
  local leader_pid="$3"
  local leader_identity="$4"
  local stop_grace_ms="${5:-5000}"
  local kill_grace_ms="${6:-${WASIX_PROCESS_KILL_GRACE_MS:-3000}}"
  local deadline leader_reaped=0 wait_status=0

  case "$stop_grace_ms:$kill_grace_ms" in
    *[!0-9:]*|:*)
      echo "process-group stop grace periods must be nonnegative integer milliseconds" >&2
      return 125
      ;;
  esac
  [ "$pgid" = "$leader_pid" ] || {
    printf 'owned process group identity differs: pgid=%s leader=%s\n' \
      "$pgid" "$leader_pid" >&2
    return 125
  }
  if fresh_supervision_pid_running "$leader_pid"; then
    fresh_pid_matches_birth_identity "$leader_pid" "$leader_identity" || {
      printf 'refusing to stop reused process group %s\n' "$pgid" >&2
      return 125
    }
    fresh_signal_owned_pid "$signal" "$leader_pid" "$leader_identity" || return
  fi

  deadline=$(( $(fresh_supervision_now_ms) + stop_grace_ms ))
  while fresh_process_group_exists "$pgid"; do
    if [ "$leader_reaped" -eq 0 ] && \
      ! fresh_supervision_pid_running "$leader_pid"; then
      fresh_reap_process_group_leader "$leader_pid"
      wait_status="$FRESH_PROCESS_GROUP_WAIT_STATUS"
      leader_reaped=1
    fi
    [ "$(fresh_supervision_now_ms)" -lt "$deadline" ] || break
    sleep 0.05
  done
  if fresh_process_group_exists "$pgid"; then
    fresh_terminate_owned_process_group \
      "$pgid" "$leader_pid" "$leader_identity" 0 "$kill_grace_ms" || return
    return 124
  fi
  if [ "$leader_reaped" -eq 0 ]; then
    fresh_reap_process_group_leader "$leader_pid"
    wait_status="$FRESH_PROCESS_GROUP_WAIT_STATUS"
  fi
  return "$wait_status"
}

fresh_run_process_group_timeout_ms() {
  local timeout_ms="$1"
  shift
  local started_ms deadline now pid pgid wait_status

  case "$timeout_ms" in
    ""|0|*[!0-9]*)
      echo "process-group timeout must be a positive integer number of milliseconds" >&2
      return 125
      ;;
  esac
  [ "${1:-}" = "--" ] || {
    echo "fresh_run_process_group_timeout_ms requires -- before the command" >&2
    return 125
  }
  started_ms="$(fresh_supervision_now_ms)"
  deadline=$((started_ms + timeout_ms))
  fresh_spawn_process_group "$@" || return
  pid="$FRESH_PROCESS_GROUP_PID"
  pgid="$FRESH_PROCESS_GROUP_PGID"

  while fresh_supervision_pid_running "$pid"; do
    now="$(fresh_supervision_now_ms)"
    if [ "$now" -ge "$deadline" ]; then
      printf 'command timed out after %s milliseconds\ncommand:' "$timeout_ms" >&2
      printf ' %q' "${@:2}" >&2
      printf '\n' >&2
      if ! fresh_terminate_process_group "$pgid" "$pid"; then
        return 125
      fi
      return 124
    fi
    sleep 0.05
  done

  fresh_reap_process_group_leader "$pid"
  wait_status="$FRESH_PROCESS_GROUP_WAIT_STATUS"
  if fresh_process_group_exists "$pgid"; then
    printf 'supervised command exited while process group %s remained live\n' "$pgid" >&2
    if ! fresh_terminate_process_group "$pgid" "$pid"; then
      return 125
    fi
    return 125
  fi
  return "$wait_status"
}

fresh_run_process_group_timeout() {
  local timeout_seconds="$1"
  shift

  case "$timeout_seconds" in
    ""|0|*[!0-9]*)
      echo "process-group timeout must be a positive integer number of seconds" >&2
      return 125
      ;;
  esac
  fresh_run_process_group_timeout_ms "$((timeout_seconds * 1000))" "$@"
}
