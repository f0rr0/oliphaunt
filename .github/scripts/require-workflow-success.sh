#!/usr/bin/env bash
set -euo pipefail

workflow="${1:?usage: require-workflow-success.sh <workflow> <sha> [timeout-seconds] [--job <name>] [--artifact <name>...]}"
sha="${2:?usage: require-workflow-success.sh <workflow> <sha> [timeout-seconds] [--job <name>] [--artifact <name>...]}"
timeout="${3:-7200}"
if [[ $# -ge 3 ]]; then
  shift 3
else
  shift "$#"
fi

required_artifacts=()
required_job=""
expected_run_id=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id)
      expected_run_id="${2:?--run-id requires a run id}"
      shift 2
      ;;
    --job)
      required_job="${2:?--job requires a name}"
      shift 2
      ;;
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

emit_run_id() {
  local run_id="$1"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "run_id=$run_id" >> "$GITHUB_OUTPUT"
  fi
  echo "selected $workflow run $run_id"
}

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

required_job_success() {
  run_id="$1"
  if [[ -z "$required_job" ]]; then
    return 0
  fi

  conclusion="$(
    GH_RUN_JSON="$(gh run view "$run_id" --json jobs)" REQUIRED_JOB="$required_job" python3 -c 'import json, os
required = os.environ["REQUIRED_JOB"]
data = json.loads(os.environ["GH_RUN_JSON"])
print(next((job.get("conclusion") or "" for job in data.get("jobs", []) if isinstance(job, dict) and job.get("name") == required), ""))'
  )" || return 1
  [[ "$conclusion" == "success" ]]
}

if [[ -n "$expected_run_id" ]]; then
  if required_job_success "$expected_run_id" && required_artifacts_present "$expected_run_id"; then
    emit_run_id "$expected_run_id"
    exit 0
  fi
  echo "$workflow run $expected_run_id does not satisfy the required job/artifact gate" >&2
  exit 1
fi

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
    if [[ -n "$required_job" ]]; then
      candidate_run_ids="$(echo "$runs" | awk -F '\t' '{ print $1 }')"
    else
      candidate_run_ids="$(echo "$runs" | awk -F '\t' '$2 == "completed" && $3 == "success" { print $1 }')"
    fi
    for run_id in $candidate_run_ids; do
      if required_job_success "$run_id" && required_artifacts_present "$run_id"; then
        emit_run_id "$run_id"
        exit 0
      fi
      echo "$workflow run $run_id does not satisfy the required job/artifact gate"
    done
    if echo "$runs" | awk -F '\t' '$2 != "completed" { active=1 } END { exit active ? 0 : 1 }'; then
      echo "$workflow is still running for $sha"
    elif [[ -z "$required_job" ]] && echo "$runs" | awk -F '\t' '$2 == "completed" && $3 != "success" && $5 != "workflow_dispatch" { failed=1 } END { exit failed ? 0 : 1 }'; then
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
