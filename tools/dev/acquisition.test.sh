#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
. "$root/tools/dev/acquisition.sh"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

# A fake clock exercises shared budgets without waiting through retry delays.
printf '100\n' > "$scratch/clock"
date() { cat "$scratch/clock"; }
sleep() { printf '%s\n' "$(( $(date +%s) + $1 ))" > "$scratch/clock"; }
unset OLIPHAUNT_ACQUISITION_TIMEOUT_SECONDS oliphaunt_acquisition_deadline
oliphaunt_acquisition_start fixture 20
for invalid in '' 0 -1 08 abc 7201 99999999999999999999; do
  if OLIPHAUNT_ACQUISITION_TIMEOUT_SECONDS="$invalid" oliphaunt_acquisition_start invalid 20 2>/dev/null; then
    # An empty override deliberately selects the caller's default.
    [ -z "$invalid" ] || exit 1
  fi
done
oliphaunt_acquisition_start fixture 20
curl_attempt() {
  local seconds="" argument
  while [ "$#" -gt 0 ]; do
    argument=$1; shift
    case "$argument" in
      --max-time) seconds=$1; shift ;;
      --retry) [ "$1" = 0 ]; shift ;;
    esac
  done
  printf '%s\n' "$seconds" >> "$scratch/attempts"
  # Model an attempt that consumes seven seconds then loses its connection.
  sleep 7
  return 7
}
status=0
oliphaunt_acquisition_curl 20 10 3 curl_attempt || status=$?
[ "$status" = 124 ]
printf '20\n10\n' > "$scratch/expected"
cmp "$scratch/expected" "$scratch/attempts"
[ "$(date +%s)" = 117 ]
# An interrupted transfer must not be retried.
curl_interrupted() { printf 'called\n' >> "$scratch/cancelled"; return 143; }
status=0
oliphaunt_acquisition_curl 20 10 0 curl_interrupted || status=$?
[ "$status" = 143 ] && [ "$(wc -l < "$scratch/cancelled")" -eq 1 ]
# Starting a mirror/sub-operation cannot replenish its parent's remaining time.
oliphaunt_acquisition_start mirror 100
[ "$(oliphaunt_acquisition_remaining 100)" = 3 ]
printf '121\n' > "$scratch/clock"
status=0
oliphaunt_acquisition_run 60 touch "$scratch/late-command" || status=$?
[ "$status" = 124 ] && [ ! -e "$scratch/late-command" ]

# Exhaustion on the final attempt is still a deadline, not a fallback-triggering
# transport error. Endpoint expiry leaves the parent's budget for another mirror.
printf '100\n' > "$scratch/clock"
unset oliphaunt_acquisition_deadline
oliphaunt_acquisition_start endpoint 20
status=0
oliphaunt_acquisition_curl 7 1 0 curl_attempt || status=$?
[ "$status" = 124 ]
[ "$(oliphaunt_acquisition_remaining 20)" = 13 ]

# A non-GNU program named timeout (Windows System32) must not mask Coreutils.
# Intercept discovery so this also tests a Mac with only gtimeout installed.
real_timeout=$(oliphaunt_acquisition_timeout)
for available in gtimeout /usr/bin/timeout missing; do
  command() {
    [ "$1" = -v ] || return 2
    if [ "$2" = "$available" ]; then printf '%s\n' "$real_timeout"
    elif [ "$2" = timeout ]; then printf '%s\n' false
    else return 1; fi
  }
  if [ "$available" = missing ]; then
    status=0
    oliphaunt_acquisition_timeout 2>/dev/null || status=$?
    [ "$status" = 127 ]
  else
    [ "$(oliphaunt_acquisition_timeout)" = "$real_timeout" ]
  fi
  unset -f command
done

# Real GNU timeout must terminate descendants, preserving ordinary exit codes.
unset -f date sleep
unset oliphaunt_acquisition_deadline
oliphaunt_acquisition_start process 30
status=0
oliphaunt_acquisition_run 10 sh -c 'exit 7' || status=$?
[ "$status" = 7 ]
status=0
oliphaunt_acquisition_run 1 sh -c 'sleep 3; touch "$1"' sh "$scratch/orphan" || status=$?
[ "$status" = 124 ]
sleep 3
[ ! -e "$scratch/orphan" ]
echo 'Acquisition deadlines: shared retries, nested budgets, expired admission and process cleanup passed'
