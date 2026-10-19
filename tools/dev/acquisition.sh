#!/usr/bin/env sh
# One budget per acquisition, shared by retries, mirrors and lock waits.
# POSIX shell and curl suffice for bootstrap downloads; other subprocesses use
# GNU timeout (already required for source Git operations).

oliphaunt_acquisition_start() {
  oliphaunt_acquisition_label=$1
  oliphaunt_acquisition_seconds=${OLIPHAUNT_ACQUISITION_TIMEOUT_SECONDS:-$2}
  case "$oliphaunt_acquisition_seconds" in
    ''|0*|*[!0-9]*|?????*) echo 'acquisition timeout must be an integer from 1 to 7200 seconds' >&2; return 2 ;;
  esac
  if [ "$oliphaunt_acquisition_seconds" -lt 1 ] || [ "$oliphaunt_acquisition_seconds" -gt 7200 ]; then
    echo 'acquisition timeout must be an integer from 1 to 7200 seconds' >&2
    return 2
  fi
  oliphaunt_acquisition_end=$(( $(date +%s) + oliphaunt_acquisition_seconds ))
  if [ -n "${oliphaunt_acquisition_deadline:-}" ] &&
    [ "$oliphaunt_acquisition_deadline" -lt "$oliphaunt_acquisition_end" ]; then
    oliphaunt_acquisition_end=$oliphaunt_acquisition_deadline
  fi
  oliphaunt_acquisition_deadline=$oliphaunt_acquisition_end
}

oliphaunt_acquisition_remaining() (
  remaining=$(( ${oliphaunt_acquisition_deadline:?start an acquisition first} - $(date +%s) ))
  if [ "$remaining" -le 0 ]; then
    echo "acquisition deadline exhausted: $oliphaunt_acquisition_label" >&2
    exit 124
  fi
  [ "$remaining" -le "$1" ] || remaining=$1
  printf '%s\n' "$remaining"
)

oliphaunt_acquisition_sleep() (
  remaining=$(oliphaunt_acquisition_remaining 7200) || exit $?
  if [ "$1" -ge "$remaining" ]; then
    echo "acquisition retry would exceed deadline: $oliphaunt_acquisition_label" >&2
    exit 124
  fi
  sleep "$1"
)

# Git for Windows can have System32/timeout.exe ahead of GNU timeout in PATH.
# Prefer Coreutils and fall back to the shell's bundled /usr/bin copy.
oliphaunt_acquisition_timeout() (
  for candidate in gtimeout timeout /usr/bin/timeout; do
    timer=$(command -v "$candidate") || continue
    case "$("$timer" --version 2>/dev/null)" in
      *'GNU coreutils'*) printf '%s\n' "$timer"; exit 0 ;;
    esac
  done
  echo 'acquisition requires GNU timeout (brew install coreutils on macOS; use Git Bash on Windows)' >&2
  exit 127
)

oliphaunt_acquisition_run() (
  timer=$(oliphaunt_acquisition_timeout) || exit $?
  seconds=$(oliphaunt_acquisition_remaining "$1") || exit $?
  shift
  status=0
  "$timer" --kill-after=5 "${seconds}s" "$@" || status=$?
  if [ "$status" = 124 ] || [ "$status" = 137 ]; then
    echo "acquisition command timed out after ${seconds}s: $oliphaunt_acquisition_label" >&2
  fi
  exit "$status"
)

# CAP ATTEMPTS DELAY CURL ARGS...; CAP bounds this endpoint, not each retry.
# curl's retry-max-time allows a final transfer to overrun its timer. Run single
# attempts with the remaining time instead, without needing a bootstrap runtime.
oliphaunt_acquisition_curl() (
  cap=$1 attempts=$2 delay=$3 curl_command=$4
  shift 4
  endpoint_deadline=$(( $(date +%s) + cap ))
  if [ "$endpoint_deadline" -lt "$oliphaunt_acquisition_deadline" ]; then
    oliphaunt_acquisition_deadline=$endpoint_deadline
  fi
  attempt=1 status=0
  while [ "$attempt" -le "$attempts" ]; do
    seconds=$(oliphaunt_acquisition_remaining "$cap") || exit $?
    if "$curl_command" --disable --retry 0 --max-time "$seconds" "$@"; then
      exit 0
    else
      status=$?
    fi
    # Cancellation is not a transient transport failure.
    case "$status" in 126|127|129|130|137|143) exit "$status" ;; esac
    oliphaunt_acquisition_remaining "$cap" >/dev/null || exit $?
    [ "$attempt" -lt "$attempts" ] || break
    oliphaunt_acquisition_sleep "$delay" || exit $?
    attempt=$((attempt + 1))
  done
  exit "$status"
)
