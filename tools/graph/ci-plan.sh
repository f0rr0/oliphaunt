#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
while IFS= read -r name; do
  case "$name" in PROTO_*) unset "$name" ;; esac
done < <(compgen -e)
moon_bin="${MOON_BIN:-moon}"
expected=$(sed -n 's/^moon *= *"\([^"]*\)".*/\1/p' .prototools)
if [[ -z "$expected" || "$("$moon_bin" --version)" != "moon $expected" ]]; then
  echo "Moon $expected is required" >&2; exit 1
fi
plan_dir=$(mktemp -d)
trap 'rm -rf "$plan_dir"' EXIT
export OLIPHAUNT_MOON_TASK_GRAPH_FILE="$plan_dir/graph.json"
export OLIPHAUNT_MOON_AFFECTED_FILE="$plan_dir/affected.json"
"$moon_bin" task-graph --json > "$OLIPHAUNT_MOON_TASK_GRAPH_FILE"
if [[ $# == 0 && ${GITHUB_EVENT_NAME:-} != workflow_dispatch ]]; then
  : "${MOON_BASE:?MOON_BASE is required for affected CI planning}"
  : "${MOON_HEAD:?MOON_HEAD is required for affected CI planning}"
  "$moon_bin" query affected --upstream none --downstream direct > "$OLIPHAUNT_MOON_AFFECTED_FILE"
fi
bash tools/dev/bun.sh tools/graph/ci_plan.mts "$@"
