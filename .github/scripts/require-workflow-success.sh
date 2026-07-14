#!/usr/bin/env bash
set -euo pipefail

workflow="${1:?usage: require-workflow-success.sh <workflow> <sha> [timeout-seconds] [--job <name>...] [--artifact <name>...] [--event <event>...]}"
sha="${2:?usage: require-workflow-success.sh <workflow> <sha> [timeout-seconds] [--job <name>...] [--artifact <name>...] [--event <event>...]}"
timeout="${3:-7200}"
if [[ $# -ge 3 ]]; then
  shift 3
else
  shift "$#"
fi

required_artifacts=()
required_jobs=()
required_events=()
expected_run_id=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id)
      expected_run_id="${2:?--run-id requires a run id}"
      shift 2
      ;;
    --job)
      required_jobs+=("${2:?--job requires a name}")
      shift 2
      ;;
    --artifact)
      required_artifacts+=("${2:?--artifact requires a name}")
      shift 2
      ;;
    --event)
      required_events+=("${2:?--event requires an event name}")
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

run_matches_request() {
  local run_id="$1"
  local row
  row="$(
    gh api "repos/$GH_REPO/actions/runs/$run_id" \
      --jq '[.head_sha, .workflow_id, .event, .status, (.conclusion // "")] | @tsv'
  )" || {
    echo "failed to inspect $workflow run $run_id" >&2
    return 1
  }

  local run_sha workflow_id run_event run_status run_conclusion workflow_name
  IFS=$'\t' read -r run_sha workflow_id run_event run_status run_conclusion <<< "$row"
  if [[ "${run_sha,,}" != "${sha,,}" ]]; then
    echo "$workflow run $run_id belongs to $run_sha, not $sha" >&2
    return 1
  fi
  workflow_name="$(gh api "repos/$GH_REPO/actions/workflows/$workflow_id" --jq .name)" || return 1
  if [[ "$workflow_name" != "$workflow" ]]; then
    echo "run $run_id is workflow $workflow_name, not $workflow" >&2
    return 1
  fi
  if [[ "${#required_events[@]}" -gt 0 ]]; then
    local expected_event matched_event=false
    for expected_event in "${required_events[@]}"; do
      if [[ "$run_event" == "$expected_event" ]]; then
        matched_event=true
        break
      fi
    done
    if [[ "$matched_event" != true ]]; then
      echo "$workflow run $run_id has event $run_event; expected one of: ${required_events[*]}" >&2
      return 1
    fi
  fi
  if [[ "${#required_jobs[@]}" -eq 0 ]] &&
    { [[ "$run_status" != "completed" ]] || [[ "$run_conclusion" != "success" ]]; }; then
    return 1
  fi
}

required_artifacts_present() {
  local run_id="$1"
  if [[ "${#required_artifacts[@]}" -eq 0 ]]; then
    return 0
  fi

  local artifacts
  artifacts="$(
    gh api "repos/$GH_REPO/actions/runs/$run_id/artifacts?per_page=100" \
      --paginate \
      --jq '.artifacts[].name'
  )" || {
    echo "failed to list artifacts for $workflow run $run_id" >&2
    return 1
  }
  local expected
  for expected in "${required_artifacts[@]}"; do
    if ! printf '%s\n' "$artifacts" | grep -Fxq -- "$expected"; then
      return 1
    fi
  done
}

required_jobs_success() {
  local run_id="$1"
  if [[ "${#required_jobs[@]}" -eq 0 ]]; then
    return 0
  fi

  local jobs_file
  jobs_file="$(mktemp)"
  if ! gh run view "$run_id" --repo "$GH_REPO" --json jobs > "$jobs_file"; then
    rm -f "$jobs_file"
    return 1
  fi

  local conclusion
  # shellcheck disable=SC2016
  if ! conclusion="$(
    bun -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(Bun.argv[1], "utf8"));
const required = Bun.argv.slice(2);
const jobs = new Map((data.jobs ?? []).map((job) => [job?.name, job?.conclusion ?? ""]));
const failures = required
  .map((name) => [name, jobs.get(name) ?? "missing"])
  .filter(([, conclusion]) => conclusion !== "success");
if (failures.length > 0) {
  console.error(failures.map(([name, conclusion]) => `${name}=${conclusion}`).join(", "));
  process.exit(1);
}
' "$jobs_file" "${required_jobs[@]}"
  )"; then
    rm -f "$jobs_file"
    return 1
  fi
  rm -f "$jobs_file"
  [[ -z "$conclusion" ]]
}

if [[ -n "$expected_run_id" ]]; then
  if run_matches_request "$expected_run_id" &&
    required_jobs_success "$expected_run_id" &&
    required_artifacts_present "$expected_run_id"; then
    emit_run_id "$expected_run_id"
    exit 0
  fi
  echo "$workflow run $expected_run_id does not satisfy the required job/artifact gate" >&2
  exit 1
fi

deadline=$((SECONDS + timeout))
while true; do
  runs="$(gh run list \
    --repo "$GH_REPO" \
    --workflow "$workflow" \
    --commit "$sha" \
    --limit 10 \
    --json databaseId,status,conclusion,url,event \
    --jq '.[] | [.databaseId, .status, (.conclusion // ""), .url, .event] | @tsv')"
  if [ -n "$runs" ]; then
    echo "$runs"
    if [[ "${#required_jobs[@]}" -gt 0 ]]; then
      candidate_run_ids="$(echo "$runs" | awk -F '\t' '{ print $1 }')"
    else
      candidate_run_ids="$(echo "$runs" | awk -F '\t' '$2 == "completed" && $3 == "success" { print $1 }')"
    fi
    for run_id in $candidate_run_ids; do
      if run_matches_request "$run_id" &&
        required_jobs_success "$run_id" &&
        required_artifacts_present "$run_id"; then
        emit_run_id "$run_id"
        exit 0
      fi
      echo "$workflow run $run_id does not satisfy the required job/artifact gate"
    done
    if echo "$runs" | awk -F '\t' '$2 != "completed" { active=1 } END { exit active ? 0 : 1 }'; then
      echo "$workflow is still running for $sha"
    elif [[ "${#required_jobs[@]}" -eq 0 ]] && echo "$runs" | awk -F '\t' '$2 == "completed" && $3 != "success" { failed=1 } END { exit failed ? 0 : 1 }'; then
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
