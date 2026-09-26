#!/usr/bin/env bash
set -euo pipefail
[ "$(uname -s)" = Linux ] || exit 0
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/process-supervision.sh"
sleep 30 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true' EXIT
identity="$(fresh_process_birth_identity "$pid")"
status=0
bash "$script_dir/signal-owned-pid.sh" --pid "$pid" --identity linux-starttime:1 --signal TERM || status=$?
[ "$status" = 125 ]
kill -0 "$pid"
bash "$script_dir/signal-owned-pid.sh" --pid "$pid" --identity "$identity" --signal TERM
status=0
wait "$pid" || status=$?
[ "$status" = 143 ]
trap - EXIT
# A reaped process is already stopped; repeating shutdown succeeds.
bash "$script_dir/signal-owned-pid.sh" --pid "$pid" --identity "$identity" --signal TERM
status=0
bash "$script_dir/signal-owned-pid.sh" --pid -1 --identity "$identity" --signal TERM || status=$?
[ "$status" = 2 ]
