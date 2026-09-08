#!/usr/bin/env bash
set -euo pipefail

job="${1:-}"
target="${2:-}"
if [[ -z "$job" || "$#" -gt 2 ]]; then
  echo "usage: .github/scripts/run-planned-moon-job.sh <job-id> [target]" >&2
  exit 2
fi

plan_dir="$(mktemp -d)"
trap 'rm -rf "$plan_dir"' EXIT
execution_file="$plan_dir/execution"
"${MOON_BIN:-moon}" task-graph --json >"$plan_dir/graph.json"

resolve_args=("$job")
if [[ -n "$target" ]]; then resolve_args+=("$target"); fi
OLIPHAUNT_MOON_TASK_GRAPH_FILE="$plan_dir/graph.json" \
  bun .github/scripts/resolve-planned-moon-execution.mts "${resolve_args[@]}" >"$execution_file"

targets=()
local_dependencies=()
transferred_dependencies=()
while IFS=$'\t' read -r kind target; do
  target="${target%$'\r'}"
  case "$kind" in
    local) local_dependencies+=("$target") ;;
    target) targets+=("$target") ;;
    transferred) transferred_dependencies+=("$target") ;;
    *)
      echo "CI job '$job' has invalid execution-plan row: $kind" >&2
      exit 2
      ;;
  esac
done <"$execution_file"

if [[ "${#targets[@]}" -eq 0 ]]; then
  echo "CI job '$job' has no planned Moon targets" >&2
  exit 2
fi

moon_args=()
if [[ -n "${OLIPHAUNT_MOON_UPSTREAM:-}" ]]; then
  moon_args+=(--upstream "$OLIPHAUNT_MOON_UPSTREAM")
fi

if [[ "${#transferred_dependencies[@]}" -gt 0 ]]; then
  if [[ "${#moon_args[@]}" -gt 0 ]]; then
    echo "CI job '$job' cannot combine transferred dependencies with OLIPHAUNT_MOON_UPSTREAM" >&2
    exit 2
  fi
  if [[ "${#local_dependencies[@]}" -gt 0 ]]; then
    .github/scripts/run-moon-targets.sh "${local_dependencies[@]}"
  fi
  exec .github/scripts/run-moon-targets.sh --upstream none "${targets[@]}"
fi

if [[ "${#moon_args[@]}" -gt 0 ]]; then
  exec .github/scripts/run-moon-targets.sh "${moon_args[@]}" "${targets[@]}"
fi

exec .github/scripts/run-moon-targets.sh "${targets[@]}"
