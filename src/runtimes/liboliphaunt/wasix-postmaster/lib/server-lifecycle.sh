#!/usr/bin/env bash

# Requires process-supervision.sh.

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
  perl -MIO::Socket::INET -e '
    my ($host, $port) = @ARGV;
    my $socket = IO::Socket::INET->new(
      PeerAddr => $host,
      PeerPort => $port,
      Proto => "tcp",
      Timeout => 0.2,
    );
    exit($socket ? 0 : 1);
  ' "$host" "$port"
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
