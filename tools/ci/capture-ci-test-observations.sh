#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
directory="${1:?expected observation directory}"
bash tools/dev/bun.sh tools/ci/ci-plan-test-observations.mts "$directory"
unset MOON_BASE MOON_HEAD
export MOON_CACHE=off
while IFS=$'\t' read -r kind id target; do
  case "$kind" in
    affected)
      "${MOON_BIN:-moon}" query affected stdin --upstream none --downstream deep \
        < "$directory/affected-$id.input" > "$directory/affected-$id.json" ;;
    task) "${MOON_BIN:-moon}" task-graph "$target" --json > "$directory/task-$id.json" ;;
    *) echo "unexpected test observation kind: $kind" >&2; exit 1 ;;
  esac
done < "$directory/requests.tsv"
