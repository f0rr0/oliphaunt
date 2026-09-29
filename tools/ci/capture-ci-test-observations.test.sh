#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cat > "$work/moon" <<'MOON'
#!/bin/sh
# Fail graph queries after successful affected queries have already completed.
if [ "$1" = task-graph ]; then exit 7; fi
printf '{}\n'
MOON
chmod +x "$work/moon"
if MOON_BIN="$work/moon" bash "$root/tools/ci/capture-ci-test-observations.sh" "$work/observations with spaces"; then
  echo 'parallel observation capture swallowed a failed query' >&2
  exit 1
fi
[ -n "$(find "$work/observations with spaces" -name 'affected-*.json' -print -quit)" ]
echo 'Parallel Moon observation failures propagate after completed queries'
