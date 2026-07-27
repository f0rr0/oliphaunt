#!/usr/bin/env bash

# Shared Metro process/port helpers for React Native Expo mobile runners.
# Platform runners still own the actual Metro start command because iOS and
# Android use different host/release behavior.

port_is_listening() {
  lsof -nP -iTCP:"$metro_port" -sTCP:LISTEN >/dev/null 2>&1
}

reserve_metro_port() {
  [ "${reuse_metro:-0}" != "1" ] || return 0
  [ -z "${metro_pid:-}" ] || return 0
  port_is_listening || return 0
  [ "$metro_port_explicit" = "0" ] ||
    fail "Expo Metro port $metro_port is already in use; stop it, set ${reuse_metro_env_name:-OLIPHAUNT_REUSE_METRO}=1, or choose ${metro_port_env_name:-OLIPHAUNT_METRO_PORT}"

  local requested_port="$metro_port"
  local candidate
  for candidate in $(seq 8082 8099); do
    metro_port="$candidate"
    if ! port_is_listening; then
      echo "Metro port $requested_port is busy; using $metro_port for this controlled dev-client run"
      return 0
    fi
  done
  metro_port="$requested_port"
  fail "Expo Metro port $requested_port is busy and no free fallback port was found in 8082-8099"
}

kill_process_tree() {
  local pid="$1"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_process_tree "$child"
  done
  kill "$pid" >/dev/null 2>&1 || true
}

stop_owned_metro() {
  if [ -n "${metro_pid:-}" ]; then
    kill_process_tree "$metro_pid"
    wait "$metro_pid" >/dev/null 2>&1 || true
  fi
  metro_pid=""
  metro_bundle_runner=""
  metro_bundle_root=""
}

cleanup() {
  if [ "${keep_metro:-0}" != "1" ]; then
    stop_owned_metro
  fi
}
