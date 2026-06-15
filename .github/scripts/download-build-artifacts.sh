#!/usr/bin/env bash
set -euo pipefail

workflow="${1:?usage: download-build-artifacts.sh <workflow> <sha> <destination> [--run-id <id>] [--job <name>] --artifact <name> [--artifact <name>...]}"
sha="${2:?usage: download-build-artifacts.sh <workflow> <sha> <destination> [--run-id <id>] [--job <name>] --artifact <name> [--artifact <name>...]}"
destination="${3:?usage: download-build-artifacts.sh <workflow> <sha> <destination> [--run-id <id>] [--job <name>] --artifact <name> [--artifact <name>...]}"
shift 3

artifacts=()
required_job=""
selected_run_id=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id)
      selected_run_id="${2:?--run-id requires a run id}"
      shift 2
      ;;
    --job)
      required_job="${2:?--job requires a name}"
      shift 2
      ;;
    --artifact)
      artifacts+=("${2:?--artifact requires a name}")
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ "${#artifacts[@]}" -eq 0 ]]; then
  echo "at least one --artifact is required" >&2
  exit 2
fi

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GH_REPO:?GH_REPO is required}"

artifact_present() {
  local run_id="$1"
  local artifact="$2"
  gh api "repos/$GH_REPO/actions/runs/$run_id/artifacts" \
    --paginate \
    --jq '.artifacts[].name' |
    grep -Fxq "$artifact"
}

required_job_success() {
  local run_id="$1"
  if [[ -z "$required_job" ]]; then
    return 0
  fi

  local conclusion
  conclusion="$(
    GH_RUN_JSON="$(gh run view "$run_id" --json jobs)" REQUIRED_JOB="$required_job" python3 -c 'import json, os
required = os.environ["REQUIRED_JOB"]
data = json.loads(os.environ["GH_RUN_JSON"])
print(next((job.get("conclusion") or "" for job in data.get("jobs", []) if isinstance(job, dict) and job.get("name") == required), ""))'
  )" || return 1
  [[ "$conclusion" == "success" ]]
}

run_id="$selected_run_id"
if [[ -n "$run_id" ]]; then
  if ! required_job_success "$run_id"; then
    echo "$workflow run $run_id does not satisfy required job ${required_job:-<none>}" >&2
    exit 1
  fi
  for artifact in "${artifacts[@]}"; do
    if ! artifact_present "$run_id" "$artifact"; then
      echo "$workflow run $run_id is missing required artifact $artifact" >&2
      exit 1
    fi
  done
else
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    if ! required_job_success "$candidate"; then
      continue
    fi
    missing=0
    for artifact in "${artifacts[@]}"; do
      if ! artifact_present "$candidate" "$artifact"; then
        missing=1
        break
      fi
    done
    if [[ "$missing" -eq 0 ]]; then
      run_id="$candidate"
      break
    fi
  done < <(
    if [[ -n "$required_job" ]]; then
      gh run list \
        --workflow "$workflow" \
        --commit "$sha" \
        --limit 20 \
        --json databaseId,status,conclusion,event,createdAt \
        --jq '.[].databaseId'
    else
      gh run list \
        --workflow "$workflow" \
        --commit "$sha" \
        --limit 20 \
        --json databaseId,status,conclusion,event,createdAt \
        --jq '.[] | select(.status == "completed" and .conclusion == "success") | .databaseId'
    fi
  )
fi

if [[ -z "$run_id" ]]; then
  echo "no $workflow workflow run found for $sha with required job/artifacts: ${required_job:-<workflow-success>} / ${artifacts[*]}" >&2
  exit 1
fi

mkdir -p "$destination"
for artifact in "${artifacts[@]}"; do
  echo "Downloading $workflow artifact $artifact from run $run_id"
  gh run download "$run_id" \
    --name "$artifact" \
    --dir "$destination"
done
