#!/usr/bin/env bash
# shellcheck disable=SC2016
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)"
runner="$root/extensions/artifacts/native/tools/run-observed-phase.sh"
tmp="$(mktemp -d)"
wrapper_pid=""
child_pid=""
grandchild_pid=""
cleanup() {
  local pid
  for pid in "$wrapper_pid" "$child_pid" "$grandchild_pid"; do
    if [ -n "$pid" ]; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  rm -rf "$tmp"
}
trap cleanup EXIT

# The inner shell, not this test process, owns the child pid expansions.
OLIPHAUNT_PHASE_HEARTBEAT_SECONDS=1 "$runner" \
  --label "test slow success" \
  --log "$tmp/success.log" \
  -- sh -c 'printf "captured stdout\n"; sleep 2; printf "inherited stderr\n" >&2' \
  >"$tmp/success.out" 2>"$tmp/success.err"

grep -F 'phase-start ' "$tmp/success.out" >/dev/null
grep -F 'label=test slow success' "$tmp/success.out" >/dev/null
grep -F 'phase-heartbeat ' "$tmp/success.out" >/dev/null
grep -F 'phase-complete ' "$tmp/success.out" >/dev/null
grep -Fx 'captured stdout' "$tmp/success.log" >/dev/null
grep -Fx 'inherited stderr' "$tmp/success.log" >/dev/null
[ ! -s "$tmp/success.err" ]

set +e
OLIPHAUNT_PHASE_HEARTBEAT_SECONDS=1 "$runner" \
  --label "test failure" \
  --log "$tmp/failure.log" \
  -- sh -c 'printf "failure detail\n"; exit 7' \
  >"$tmp/failure.out" 2>"$tmp/failure.err"
status="$?"
set -e
[ "$status" -eq 7 ]
grep -F 'phase-failed ' "$tmp/failure.err" >/dev/null
grep -F 'status=7' "$tmp/failure.err" >/dev/null
grep -Fx 'failure detail' "$tmp/failure.err" >/dev/null
grep -Fx 'failure detail' "$tmp/failure.log" >/dev/null

OLIPHAUNT_PHASE_HEARTBEAT_SECONDS=1 "$runner" \
  --label "test interruption" \
  --log "$tmp/interrupted.log" \
  -- sh -c 'trap "" TERM; printf "interrupted stderr\n" >&2; printf "%s\n" "$$" >"$1"; sleep 60 & printf "%s\n" "$!" >"$2"; wait' \
  sh "$tmp/child.pid" "$tmp/grandchild.pid" \
  >"$tmp/interrupted.out" 2>"$tmp/interrupted.err" &
wrapper_pid="$!"

for _attempt in 1 2 3 4 5; do
  if [ -s "$tmp/child.pid" ] && [ -s "$tmp/grandchild.pid" ]; then
    break
  fi
  sleep 1
done
[ -s "$tmp/child.pid" ]
[ -s "$tmp/grandchild.pid" ]
child_pid="$(cat "$tmp/child.pid")"
grandchild_pid="$(cat "$tmp/grandchild.pid")"
kill -TERM "$wrapper_pid"
set +e
wait "$wrapper_pid"
status="$?"
set -e
wrapper_pid=""
[ "$status" -eq 143 ]

for _attempt in 1 2 3 4 5; do
  if ! kill -0 "$child_pid" 2>/dev/null && ! kill -0 "$grandchild_pid" 2>/dev/null; then
    break
  fi
  sleep 1
done
if kill -0 "$child_pid" 2>/dev/null || kill -0 "$grandchild_pid" 2>/dev/null; then
  echo "observed phase interruption left a child process running" >&2
  exit 1
fi
child_pid=""
grandchild_pid=""
grep -F 'phase-interrupted ' "$tmp/interrupted.err" >/dev/null
grep -F 'signal=TERM status=143' "$tmp/interrupted.err" >/dev/null
grep -Fx 'interrupted stderr' "$tmp/interrupted.err" >/dev/null
grep -F 'phase-interrupted ' "$tmp/interrupted.log" >/dev/null
grep -Fx 'interrupted stderr' "$tmp/interrupted.log" >/dev/null

set +e
OLIPHAUNT_PHASE_HEARTBEAT_SECONDS=0 "$runner" \
  --label "invalid heartbeat" \
  --log "$tmp/invalid.log" \
  -- true >"$tmp/invalid.out" 2>"$tmp/invalid.err"
status="$?"
set -e
[ "$status" -eq 2 ]
grep -F 'must be a positive integer' "$tmp/invalid.err" >/dev/null

echo "observed phase wrapper tests passed"
