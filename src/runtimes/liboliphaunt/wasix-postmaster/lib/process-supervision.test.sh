#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/process-supervision.sh"

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-process-supervision-test.XXXXXX")"
TIMEOUT_TREE="$TEST_ROOT/timeout-tree.sh"
RESIDUE_TREE="$TEST_ROOT/residue-tree.sh"

cleanup() {
  local pid_file pid
  for pid_file in "$TEST_ROOT"/*.pid; do
    [ -s "$pid_file" ] || continue
    pid="$(tr -d '[:space:]' <"$pid_file")"
    case "$pid" in
      ""|*[!0-9]*) continue ;;
    esac
    kill -KILL "$pid" 2>/dev/null || true
  done
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT HUP INT TERM

cat >"$TIMEOUT_TREE" <<'EOF_TIMEOUT_TREE'
#!/usr/bin/env bash
set -euo pipefail
trap '' TERM
printf '%s\n' "$$" >"$LEADER_PID_FILE"
bash -c '
  set -euo pipefail
  trap "" TERM
  printf "%s\n" "$$" >"$CHILD_PID_FILE"
  bash -c '\''
    set -euo pipefail
    trap "" TERM
    printf "%s\n" "$$" >"$GRANDCHILD_PID_FILE"
    while :; do sleep 1; done
  '\'' &
  while [ ! -s "$GRANDCHILD_PID_FILE" ]; do sleep 0.01; done
  while :; do sleep 1; done
' &
while [ ! -s "$CHILD_PID_FILE" ] || [ ! -s "$GRANDCHILD_PID_FILE" ]; do
  sleep 0.01
done
while :; do sleep 1; done
EOF_TIMEOUT_TREE

cat >"$RESIDUE_TREE" <<'EOF_RESIDUE_TREE'
#!/usr/bin/env bash
set -euo pipefail
bash -c '
  set -euo pipefail
  trap "" TERM
  printf "%s\n" "$$" >"$RESIDUE_PID_FILE"
  while :; do sleep 1; done
' &
while [ ! -s "$RESIDUE_PID_FILE" ]; do sleep 0.01; done
exit 0
EOF_RESIDUE_TREE
chmod +x "$TIMEOUT_TREE" "$RESIDUE_TREE"

assert_pid_gone() {
  local label="$1"
  local pid_file="$2"
  local pid

  [ -s "$pid_file" ] || {
    printf 'missing %s PID evidence: %s\n' "$label" "$pid_file" >&2
    return 1
  }
  pid="$(tr -d '[:space:]' <"$pid_file")"
  case "$pid" in
    ""|*[!0-9]*)
      printf 'invalid %s PID evidence: %s\n' "$label" "$pid" >&2
      return 1
      ;;
  esac
  if kill -0 "$pid" 2>/dev/null; then
    printf '%s process survived supervision: %s\n' "$label" "$pid" >&2
    return 1
  fi
}

export LEADER_PID_FILE="$TEST_ROOT/leader.pid"
export CHILD_PID_FILE="$TEST_ROOT/child.pid"
export GRANDCHILD_PID_FILE="$TEST_ROOT/grandchild.pid"
timeout_tree_ms=400
if [ "$(uname -s)" = Darwin ]; then
  # A loaded macOS runner can spend most of the short Linux fixture window
  # scheduling the nested Bash tree before it writes its PID evidence.
  timeout_tree_ms=2000
fi
set +e
WASIX_PROCESS_TERM_GRACE_MS=100 \
WASIX_PROCESS_KILL_GRACE_MS=3000 \
  fresh_run_process_group_timeout_ms "$timeout_tree_ms" -- "$TIMEOUT_TREE" \
    >"$TEST_ROOT/timeout.log" 2>&1
timeout_status=$?
set -e
[ "$timeout_status" -eq 124 ] || {
  printf 'expected timeout status 124, got %s\n' "$timeout_status" >&2
  sed -n '1,120p' "$TEST_ROOT/timeout.log" >&2
  exit 1
}
assert_pid_gone leader "$LEADER_PID_FILE"
assert_pid_gone child "$CHILD_PID_FILE"
assert_pid_gone grandchild "$GRANDCHILD_PID_FILE"
if fresh_process_group_exists "$FRESH_PROCESS_GROUP_LAST_PGID"; then
  printf 'timed-out process group survived: %s\n' \
    "$FRESH_PROCESS_GROUP_LAST_PGID" >&2
  exit 1
fi

export RESIDUE_PID_FILE="$TEST_ROOT/residue.pid"
set +e
WASIX_PROCESS_TERM_GRACE_MS=100 \
WASIX_PROCESS_KILL_GRACE_MS=3000 \
  fresh_run_process_group_timeout_ms 2000 -- "$RESIDUE_TREE" \
    >"$TEST_ROOT/residue.log" 2>&1
residue_status=$?
set -e
[ "$residue_status" -eq 125 ] || {
  printf 'expected residue status 125, got %s\n' "$residue_status" >&2
  sed -n '1,120p' "$TEST_ROOT/residue.log" >&2
  exit 1
}
assert_pid_gone residue "$RESIDUE_PID_FILE"
if fresh_process_group_exists "$FRESH_PROCESS_GROUP_LAST_PGID"; then
  printf 'post-exit residue process group survived: %s\n' \
    "$FRESH_PROCESS_GROUP_LAST_PGID" >&2
  exit 1
fi

fresh_run_process_group_timeout_ms 1000 -- bash -c 'exit 0'

set +e
fresh_run_process_group_timeout_ms 1000 -- bash -c 'exit 37'
nonzero_status=$?
set -e
[ "$nonzero_status" -eq 37 ] || {
  printf 'expected supervised exit status 37, got %s\n' "$nonzero_status" >&2
  exit 1
}
[ "$FRESH_PROCESS_GROUP_WAIT_STATUS" -eq 37 ] || {
  printf 'expected reaped leader wait status 37, got %s\n' \
    "$FRESH_PROCESS_GROUP_WAIT_STATUS" >&2
  exit 1
}

set +e
fresh_run_process_group_timeout_ms 1000 -- bash -c '
  if IFS= read -r unexpected; then
    printf "inherited supervised stdin: %s\n" "$unexpected" >&2
    exit 9
  fi
' <<<"must-not-reach-supervised-command" \
  >"$TEST_ROOT/stdin.log" 2>&1
stdin_status=$?
set -e
[ "$stdin_status" -eq 0 ] || {
  printf 'supervised command inherited caller stdin (status %s)\n' \
    "$stdin_status" >&2
  sed -n '1,120p' "$TEST_ROOT/stdin.log" >&2
  exit 1
}

fresh_spawn_process_group -- bash -c 'trap "" INT TERM; while :; do sleep 1; done'
owned_pid="$FRESH_PROCESS_GROUP_PID"
owned_pgid="$FRESH_PROCESS_GROUP_PGID"
owned_identity="$(fresh_process_birth_identity "$owned_pid")"
[ -n "$owned_identity" ]
[ "$FRESH_PROCESS_GROUP_IDENTITY" = "$owned_identity" ]
if fresh_signal_owned_pid TERM "$owned_pid" "linux-starttime:1" \
  >"$TEST_ROOT/reused.out" 2>"$TEST_ROOT/reused.err"
then
  echo "mismatched process birth identity was signalled" >&2
  exit 1
fi
fresh_supervision_pid_running "$owned_pid" || {
  echo "identity-mismatch guard killed the owned fixture" >&2
  exit 1
}
grep -Fq 'refusing to signal reused process identity' "$TEST_ROOT/reused.err"
WASIX_PROCESS_TERM_GRACE_MS=100 \
WASIX_PROCESS_KILL_GRACE_MS=3000 \
  fresh_terminate_owned_process_group "$owned_pgid" "$owned_pid" "$owned_identity"
fresh_process_group_exists "$owned_pgid" && {
  echo "identity-owned process group survived termination" >&2
  exit 1
}

fresh_spawn_process_group -- bash -c \
  'trap "exit 0" TERM; while :; do sleep 1; done'
graceful_pid="$FRESH_PROCESS_GROUP_PID"
graceful_pgid="$FRESH_PROCESS_GROUP_PGID"
graceful_identity="$FRESH_PROCESS_GROUP_IDENTITY"
fresh_stop_owned_process_group \
  TERM "$graceful_pgid" "$graceful_pid" "$graceful_identity" 1000 3000
fresh_process_group_exists "$graceful_pgid" && {
  echo "gracefully stopped process group survived" >&2
  exit 1
}

fresh_spawn_process_group -- bash -c \
  'trap "" TERM; while :; do sleep 1; done'
forced_pid="$FRESH_PROCESS_GROUP_PID"
forced_pgid="$FRESH_PROCESS_GROUP_PGID"
forced_identity="$FRESH_PROCESS_GROUP_IDENTITY"
set +e
fresh_stop_owned_process_group \
  TERM "$forced_pgid" "$forced_pid" "$forced_identity" 100 3000
forced_status=$?
set -e
[ "$forced_status" -eq 124 ] || {
  printf 'forced process-group stop returned %s instead of 124\n' \
    "$forced_status" >&2
  exit 1
}
fresh_process_group_exists "$forced_pgid" && {
  echo "force-stopped process group survived" >&2
  exit 1
}

printf 'process supervision tests passed\n'
