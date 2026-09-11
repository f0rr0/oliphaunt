#!/usr/bin/env bash

# Requires process-supervision.sh.
_fresh_server_lifecycle_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fresh_path_identity() {
  local path="$1"
  if stat -Lc '%d:%i' "$path" >/dev/null 2>&1; then
    stat -Lc '%d:%i' "$path"
  elif stat -f '%d:%i' "$path" >/dev/null 2>&1; then
    stat -f '%d:%i' "$path"
  else
    return 1
  fi
}

fresh_wait_cgroup_empty() {
  local cgroup_dir="$1"
  local expected_identity="$2"
  local timeout_ms="$3"
  local deadline actual_identity members

  [ -n "$cgroup_dir" ] || return 0
  case "$timeout_ms" in ""|*[!0-9]*) return 125 ;; esac
  deadline=$(( $(fresh_supervision_now_ms) + timeout_ms ))
  while :; do
    [ -e "$cgroup_dir" ] || return 0
    actual_identity="$(fresh_path_identity "$cgroup_dir" 2>/dev/null)" || return 125
    if [ "$actual_identity" != "$expected_identity" ]; then
      printf 'refusing reused cgroup identity: path=%s expected=%s actual=%s\n' \
        "$cgroup_dir" "$expected_identity" "$actual_identity" >&2
      return 125
    fi
    [ -r "$cgroup_dir/cgroup.procs" ] || {
      printf 'tracked cgroup.procs became unreadable: %s\n' "$cgroup_dir" >&2
      return 125
    }
    members="$(tr -d '[:space:]' <"$cgroup_dir/cgroup.procs")"
    [ -z "$members" ] && return 0
    [ "$(fresh_supervision_now_ms)" -lt "$deadline" ] || {
      printf 'tracked cgroup retained processes after shutdown: %s (%s)\n' \
        "$cgroup_dir" "$members" >&2
      return 125
    }
    sleep 0.05
  done
}

fresh_tcp_port_open() {
  local host="$1"
  local port="$2"
  bun "$_fresh_server_lifecycle_root/server-lifecycle.mts" probe "$host" "$port"
}

fresh_wait_tcp_port_closed() {
  local host="$1"
  local port="$2"
  local timeout_ms="$3"
  local deadline

  case "$port:$timeout_ms" in *[!0-9:]*|:*|*:) return 125 ;; esac
  deadline=$(( $(fresh_supervision_now_ms) + timeout_ms ))
  while fresh_tcp_port_open "$host" "$port"; do
    [ "$(fresh_supervision_now_ms)" -lt "$deadline" ] || {
      printf 'TCP listener survived shutdown: %s:%s\n' "$host" "$port" >&2
      return 125
    }
    sleep 0.05
  done
}

wait_for_unassisted_exit() {
  local exit_evidence="$1"
  local deadline wait_status group_deadline cgroup_empty=not-requested

  deadline=$(( $(fresh_supervision_now_ms) + timeout_seconds * 1000 ))
  while fresh_supervision_pid_running "$active_pid"; do
    if ! fresh_pid_matches_birth_identity "$active_pid" "$active_identity"; then
      # The leader can exit between the liveness check above and reading its
      # immutable birth identity.  Only classify an identity mismatch as PID
      # reuse when the numeric PID is still live after that failed read.
      fresh_supervision_pid_running "$active_pid" && return 125
      break
    fi
    [ "$(fresh_supervision_now_ms)" -lt "$deadline" ] || {
      printf 'server did not exit after bridged signal without escalation\n' >&2
      return 124
    }
    sleep 0.05
  done
  fresh_reap_process_group_leader "$active_pid"
  wait_status="$FRESH_PROCESS_GROUP_WAIT_STATUS"
  group_deadline=$(( $(fresh_supervision_now_ms) + timeout_seconds * 1000 ))
  while fresh_process_group_exists "$active_pgid"; do
    [ "$(fresh_supervision_now_ms)" -lt "$group_deadline" ] || {
      printf 'server process group remained after leader exit: %s\n' "$active_pgid" >&2
      return 124
    }
    sleep 0.05
  done
  if [ -n "$active_cgroup_dir" ] && [ -n "$active_cgroup_identity" ]; then
    fresh_wait_cgroup_empty "$active_cgroup_dir" "$active_cgroup_identity" \
      "$((timeout_seconds * 1000))"
    cgroup_empty=true
  fi
  fresh_wait_tcp_port_closed 127.0.0.1 "$port" "$((timeout_seconds * 1000))"
  [ -z "$(find "$dev_shm" -mindepth 1 -print -quit)" ] || {
    printf 'shared objects survived normal guest shutdown: %s\n' "$dev_shm" >&2
    return 1
  }
  [ "$wait_status" -eq 0 ] || {
    printf 'server leader exited nonzero after unassisted guest shutdown: phase=%s status=%s\n' \
      "$active_phase" "$wait_status" >&2
    return 1
  }
  {
    printf 'phase\twait_status\tprocess_group_empty\tcgroup_empty\tport_closed\tshared_objects_empty\tescalation_used\n'
    printf '%s\t%s\ttrue\t%s\ttrue\ttrue\tfalse\n' \
      "$active_phase" "$wait_status" "$cgroup_empty"
  } >"$exit_evidence"
  active_pid=""
  active_pgid=""
  active_identity=""
  active_phase=""
  active_cgroup_unit=""
  active_cgroup_dir=""
  active_cgroup_identity=""
}
