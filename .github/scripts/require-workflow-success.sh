#!/usr/bin/env bash
set -euo pipefail

workflow="${1:?usage: require-workflow-success.sh <workflow> <sha> [timeout-seconds] [--artifact <name>...]}"
sha="${2:?usage: require-workflow-success.sh <workflow> <sha> [timeout-seconds] [--artifact <name>...]}"
timeout="${3:-7200}"
if [[ $# -ge 3 ]]; then
  shift 3
else
  shift "$#"
fi

required_artifacts=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --artifact)
      required_artifacts+=("${2:?--artifact requires a name}")
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GH_REPO:?GH_REPO is required}"

required_artifacts_present() {
  run_id="$1"
  if [[ "${#required_artifacts[@]}" -eq 0 ]]; then
    return 0
  fi

  artifacts="$(gh api "repos/$GH_REPO/actions/runs/$run_id/artifacts" \
    --paginate \
    --jq '.artifacts[].name')" || return 1
  for expected in "${required_artifacts[@]}"; do
    if ! printf '%s\n' "$artifacts" | grep -Fxq "$expected"; then
      return 1
    fi
  done
}

deadline=$((SECONDS + timeout))
while true; do
  runs="$(gh run list \
    --workflow "$workflow" \
    --commit "$sha" \
    --limit 10 \
    --json databaseId,status,conclusion,url,event \
    --jq '.[] | [.databaseId, .status, (.conclusion // ""), .url, .event] | @tsv')"
  if [ -n "$runs" ]; then
    echo "$runs"
    for run_id in $(echo "$runs" | awk -F '\t' '$2 == "completed" && $3 == "success" { print $1 }'); do
      if required_artifacts_present "$run_id"; then
        exit 0
      fi
      echo "$workflow run $run_id is successful but is missing one or more required artifacts"
    done
    if echo "$runs" | awk -F '\t' '$2 != "completed" { active=1 } END { exit active ? 0 : 1 }'; then
      echo "$workflow is still running for $sha"
    elif echo "$runs" | awk -F '\t' '$2 == "completed" && $3 != "success" && $5 != "workflow_dispatch" { failed=1 } END { exit failed ? 0 : 1 }'; then
      echo "$workflow failed for $sha" >&2
      exit 1
    else
      echo "waiting for successful $workflow workflow for $sha"
    fi
  else
    echo "waiting for $workflow workflow for $sha"
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "timed out waiting for successful $workflow workflow for $sha" >&2
    exit 1
  fi
  sleep 60
done
