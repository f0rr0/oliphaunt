#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$script_dir/build-output.bash"
root="$(git -C "$script_dir" rev-parse --show-toplevel)"
observer="$root/src/extensions/artifacts/native/tools/run-observed-phase.sh"

if [ "${1:-}" = worker ]; then
  work="$2"
  mode="$3"
  export OLIPHAUNT_JOBS=6
  lane() {
    [ "$OLIPHAUNT_JOBS" = 2 ]
    touch "$work/$1"
    for attempt in 1 2 3 4 5; do
      if [ -f "$work/one" ] && [ -f "$work/two" ] && [ -f "$work/three" ]; then return; fi
      sleep 1
    done
    return 9
  }
  one() { lane one; }
  two() { lane two; }
  three() { lane three; }
  slow() {
    "$observer" --label 'cancelled peer' --log "$work/slow.log" -- \
      bash -c 'trap "" TERM; echo "$$" > "$1"; sleep 60' bash "$work/slow.pid"
  }
  fail_peer() {
    for attempt in 1 2 3 4 5; do
      [ ! -s "$work/slow.pid" ] || return 7
      sleep 1
    done
    return 8
  }
  case "$mode" in
    success) oliphaunt_parallel_apple_builds one two three ;;
    failure) oliphaunt_parallel_apple_builds slow fail_peer ;;
    cancellation) oliphaunt_parallel_apple_builds slow ;;
  esac
  exit
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
bash "$0" worker "$work" success
set +e
bash "$0" worker "$work" failure >"$work/failure.log" 2>&1
status="$?"
set -e
[ "$status" = 7 ]
! kill -0 "$(cat "$work/slow.pid")" 2>/dev/null
rm "$work/slow.pid"
bash "$0" worker "$work" cancellation >"$work/cancellation.log" 2>&1 &
worker="$!"
for attempt in 1 2 3 4 5; do
  [ ! -s "$work/slow.pid" ] || break
  sleep 1
done
[ -s "$work/slow.pid" ]
kill -TERM "$worker"
set +e
wait "$worker"
status="$?"
set -e
[ "$status" = 143 ]
! kill -0 "$(cat "$work/slow.pid")" 2>/dev/null
echo 'parallel Apple build, failure, and cancellation checks passed'
