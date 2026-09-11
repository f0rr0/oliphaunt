#!/usr/bin/env bash

# Run the independent Apple slices within one CPU budget. Each lane owns a
# process group; cancellation reaches build shells as well as their compilers.
oliphaunt_parallel_apple_builds() (
  set -euo pipefail
  local jobs="${OLIPHAUNT_JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 4)}"
  local command pid running status attempt alive
  local pids=() remaining=()
  case "$jobs" in ''|0*|*[!0-9]*) echo 'OLIPHAUNT_JOBS must be positive' >&2; return 2 ;; esac
  [ "$#" -gt 0 ] || return 2
  if [ "$jobs" -lt "$#" ]; then
    for command in "$@"; do "$command"; done
    return
  fi
  export OLIPHAUNT_JOBS="$((jobs / $#))"
  stop_lanes() {
    status="$?"
    trap - EXIT HUP INT TERM
    for pid in ${pids[@]+"${pids[@]}"}; do kill -TERM -- "-$pid" 2>/dev/null || true; done
    for attempt in 1 2 3 4 5; do
      alive=0
      for pid in ${pids[@]+"${pids[@]}"}; do
        if kill -0 -- "-$pid" 2>/dev/null; then alive=1; fi
      done
      [ "$alive" = 1 ] || break
      sleep 1
    done
    for pid in ${pids[@]+"${pids[@]}"}; do
      kill -KILL -- "-$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    done
    exit "$status"
  }
  trap stop_lanes EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  set -m
  for command in "$@"; do
    "$command" &
    pids+=("$!")
  done
  set +m
  while [ -n "${pids[*]-}" ]; do
    running=" $(jobs -pr | tr '\n' ' ') "
    remaining=()
    for pid in "${pids[@]}"; do
      case "$running" in
        *" $pid "*) remaining+=("$pid") ;;
        *) if wait "$pid"; then :; else return "$?"; fi ;;
      esac
    done
    pids=(${remaining[@]+"${remaining[@]}"})
    [ -z "${pids[*]-}" ] || sleep 1
  done
)

oliphaunt_capture_build_artifact_path() {
  local description="${1:?oliphaunt_capture_build_artifact_path requires a description}"
  shift
  local log_file="${1:?oliphaunt_capture_build_artifact_path requires a log file}"
  shift
  local log_dir tmp status artifact

  log_dir="$(dirname "$log_file")"
  mkdir -p "$log_dir"
  tmp="$(mktemp "${TMPDIR:-/tmp}/oliphaunt-build-output.XXXXXX")"

  set +e
  "$@" 2>&1 | tee "$tmp" | tee "$log_file" >&2
  status="${PIPESTATUS[0]}"
  set -e

  if [ "$status" -ne 0 ]; then
    rm -f "$tmp"
    echo "error: $description failed; see $log_file" >&2
    return "$status"
  fi

  artifact=""
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    if [ -e "$line" ]; then
      artifact="$line"
    fi
  done < "$tmp"
  if [ -z "$artifact" ]; then
    artifact="$(awk 'NF { line = $0 } END { if (line != "") print line }' "$tmp")"
  fi
  rm -f "$tmp"
  if [ -z "$artifact" ]; then
    echo "error: $description did not print an artifact path; see $log_file" >&2
    return 1
  fi

  printf '%s\n' "$artifact"
}
