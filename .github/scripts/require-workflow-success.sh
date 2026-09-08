#!/usr/bin/env bash
set -euo pipefail

workflow="${1:?usage: require-workflow-success.sh <workflow> <sha> [timeout-seconds] [--job <name>...] [--artifact <name>...] [--gate-artifact <name>...] [--event <event>...]}"
sha="${2:?usage: require-workflow-success.sh <workflow> <sha> [timeout-seconds] [--job <name>...] [--artifact <name>...] [--gate-artifact <name>...] [--event <event>...]}"
timeout="${3:-7200}"
if [[ $# -ge 3 ]]; then
  shift 3
else
  shift "$#"
fi

required_artifacts=()
gate_artifacts=()
required_jobs=()
required_events=()
expected_run_id=""
release_candidate=false
selected_artifacts_json='[]'
selected_gate_artifacts_json='[]'
selected_run_attempt=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --release-candidate)
      release_candidate=true
      shift
      ;;
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
    --gate-artifact)
      gate_artifacts+=("${2:?--gate-artifact requires a name}")
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

if [[ "$release_candidate" == true ]]; then
  if [[ "$workflow" != Release || ! "$expected_run_id" =~ ^[1-9][0-9]*$ ]]; then
    echo "--release-candidate requires Release and an explicit positive --run-id" >&2
    exit 2
  fi
  required_events=(workflow_dispatch)
fi

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GH_REPO:?GH_REPO is required}"
if [[ ! "$sha" =~ ^[0-9A-Fa-f]{40}$ ]]; then
  echo "workflow gate SHA must be a full hexadecimal commit SHA" >&2
  exit 2
fi

github_read() {
  local label="${1:?GitHub read label is required}"
  local response
  response="$(node tools/release/github-read.mts --label "$label" -- "$2")" || return $?
  bun .github/scripts/workflow-run-metadata.mts "$3" <<<"$response"
}

github_paginated_json() {
  local label="${1:?GitHub paginated read label is required}"
  local field="${2:?GitHub paginated read field is required}"
  local endpoint="${3:?GitHub paginated read endpoint is required}"
  node tools/release/github-read.mts \
    --label "$label" \
    --paginate-field "$field" \
    -- "$endpoint"
}

normalize_sha() {
  LC_ALL=C tr '[:upper:]' '[:lower:]'
}

emit_run_id() {
  local run_id="$1"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    {
      echo "run_id=$run_id"
      echo "run_attempt=$selected_run_attempt"
      echo "artifact_metadata_json=$selected_artifacts_json"
      if [[ "$release_candidate" == true ]]; then
        ARTIFACTS_JSON="$selected_artifacts_json" bun .github/scripts/workflow-run-metadata.mts artifact-ids
      fi
      echo "gate_artifact_metadata_json=$selected_gate_artifacts_json"
    } >>"$GITHUB_OUTPUT"
  fi
  echo "selected $workflow run $run_id"
}

run_matches_request() {
  local run_id="$1"
  local row status
  row="$(
    github_read "$workflow run $run_id metadata" \
      "repos/$GH_REPO/actions/runs/$run_id" run-row
  )" || {
    status=$?
    echo "failed to inspect $workflow run $run_id" >&2
    return "$status"
  }

  local run_sha workflow_id run_event run_status run_conclusion run_attempt workflow_name
  IFS=$'\t' read -r run_sha workflow_id run_event run_status run_conclusion run_attempt <<<"$row"
  if [[ "$(printf '%s' "$run_sha" | normalize_sha)" != "$(printf '%s' "$sha" | normalize_sha)" ]]; then
    echo "$workflow run $run_id belongs to $run_sha, not $sha" >&2
    return 1
  fi
  workflow_name="$(
    github_read "workflow $workflow_id metadata" \
      "repos/$GH_REPO/actions/workflows/$workflow_id" workflow-name
  )" || {
    status=$?
    return "$status"
  }
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
  # Publication may fail after preparation. Recovery accepts that completed run
  # only when its frozen candidate producer succeeded; CI still needs success.
  if [[ "$release_candidate" == true && "$run_status" == completed && "$run_conclusion" == failure ]]; then
    required_jobs+=("Prepare frozen publication candidate")
  elif [[ "$run_status" != "completed" || "$run_conclusion" != "success" ]]; then
    echo "$workflow run $run_id is $run_status/${run_conclusion:-<none>}, not completed/success" >&2
    return 1
  fi
  if [[ ! "$run_attempt" =~ ^[1-9][0-9]*$ ]]; then
    echo "$workflow run $run_id has an invalid run attempt" >&2
    return 64
  fi
  selected_run_attempt="$run_attempt"
}

required_artifacts_present() {
  local run_id="$1"
  if [[ "${#required_artifacts[@]}" -eq 0 && "${#gate_artifacts[@]}" -eq 0 ]]; then
    selected_artifacts_json='[]'
    selected_gate_artifacts_json='[]'
    return 0
  fi

  local artifacts_json
  artifacts_json="$(
    github_paginated_json \
      "$workflow run $run_id artifact inventory" \
      artifacts \
      "repos/$GH_REPO/actions/runs/$run_id/artifacts"
  )" || {
    local status=$?
    echo "failed to list artifacts for $workflow run $run_id" >&2
    return "$status"
  }
  local required_json
  if [[ "${#required_artifacts[@]}" -eq 0 ]]; then
    required_json='[]'
  else
    required_json="$(printf '%s\n' "${required_artifacts[@]}" | bun .github/scripts/workflow-run-metadata.mts names)"
  fi
  local gate_json
  if [[ "${#gate_artifacts[@]}" -eq 0 ]]; then
    gate_json='[]'
  else
    gate_json="$(printf '%s\n' "${gate_artifacts[@]}" | bun .github/scripts/workflow-run-metadata.mts names)"
  fi
  local selection status
  # shellcheck disable=SC2016
  if selection="$(
    REQUIRED_ARTIFACTS_JSON="$required_json" \
      GATE_ARTIFACTS_JSON="$gate_json" \
      bun .github/scripts/workflow-run-metadata.mts select-artifacts <<<"$artifacts_json"
  )"; then
    selected_artifacts_json="$(
      SELECTION_JSON="$selection" bun .github/scripts/workflow-run-metadata.mts selected-artifacts
    )"
    selected_gate_artifacts_json="$(
      SELECTION_JSON="$selection" bun .github/scripts/workflow-run-metadata.mts selected-gates
    )"
  else
    status=$?
    selected_artifacts_json='[]'
    selected_gate_artifacts_json='[]'
    return "$status"
  fi
}

required_jobs_success() {
  local run_id="$1"
  if [[ "${#required_jobs[@]}" -eq 0 ]]; then
    return 0
  fi

  local jobs_file
  jobs_file="$(mktemp)"
  local status
  if github_paginated_json "$workflow run $run_id jobs" jobs \
    "repos/$GH_REPO/actions/runs/$run_id/jobs?filter=latest" >"$jobs_file"; then
    :
  else
    status=$?
    rm -f "$jobs_file"
    return "$status"
  fi

  local conclusion
  # shellcheck disable=SC2016
  if ! conclusion="$(
    bun .github/scripts/workflow-run-metadata.mts jobs "$jobs_file" "${required_jobs[@]}"
  )"; then
    rm -f "$jobs_file"
    return 1
  fi
  rm -f "$jobs_file"
  [[ -z "$conclusion" ]]
}

candidate_satisfies_gate() {
  local run_id="$1"
  local status
  if run_matches_request "$run_id"; then
    :
  else
    status=$?
    return "$status"
  fi
  if required_jobs_success "$run_id"; then
    :
  else
    status=$?
    return "$status"
  fi
  if required_artifacts_present "$run_id"; then
    :
  else
    status=$?
    return "$status"
  fi
}

resolve_workflow_id() {
  local workflows_json
  workflows_json="$(
    github_paginated_json \
      "$workflow workflow inventory" \
      workflows \
      "repos/$GH_REPO/actions/workflows"
  )" || return $?
  # Resolve the immutable workflow id from the exact display name. This avoids
  # gh run list's arbitrary latest-N truncation and refuses ambiguous names.
  # shellcheck disable=SC2016
  WORKFLOW_NAME="$workflow" bun .github/scripts/workflow-run-metadata.mts workflow-id <<<"$workflows_json" || return 64
}

exact_sha_workflow_runs() {
  local workflow_id="$1"
  local runs_json
  runs_json="$(
    github_paginated_json \
      "$workflow exact-SHA run inventory for $sha" \
      workflow_runs \
      "repos/$GH_REPO/actions/workflows/$workflow_id/runs?head_sha=$sha"
  )" || return $?
  # shellcheck disable=SC2016
  EXPECTED_SHA="$(printf '%s' "$sha" | normalize_sha)" bun .github/scripts/workflow-run-metadata.mts runs <<<"$runs_json" || return 64
}

if [[ -n "$expected_run_id" ]]; then
  if candidate_satisfies_gate "$expected_run_id"; then
    emit_run_id "$expected_run_id"
    exit 0
  else
    status=$?
  fi
  if [[ "$status" -eq 64 || "$status" -eq 75 ]]; then
    echo "$workflow run $expected_run_id could not be read within the bounded GitHub read policy" >&2
    exit "$status"
  fi
  echo "$workflow run $expected_run_id does not satisfy the required job/artifact gate" >&2
  exit 1
fi

deadline=$((SECONDS + timeout))
workflow_id=""
while true; do
  if [[ -z "$workflow_id" ]]; then
    if workflow_id="$(resolve_workflow_id)"; then
      :
    else
      status=$?
      if [[ "$status" -eq 64 ]]; then
        echo "permanent GitHub read failure while resolving $workflow" >&2
        exit 64
      fi
      echo "transient GitHub read budget exhausted while resolving $workflow; the waiter remains active" >&2
      workflow_id=""
    fi
  fi
  if [[ -n "$workflow_id" ]] && runs="$(exact_sha_workflow_runs "$workflow_id")"; then
    :
  else
    status=$?
    if [[ "$status" -eq 64 ]]; then
      echo "permanent GitHub read failure while searching for $workflow at $sha" >&2
      exit 64
    fi
    echo "transient GitHub read budget exhausted while searching for $workflow at $sha; the waiter remains active" >&2
    runs=""
  fi
  if [ -n "$runs" ]; then
    echo "$runs"
    candidate_run_ids="$(echo "$runs" | awk -F '\t' '$2 == "completed" && $3 == "success" { print $1 }')"
    for run_id in $candidate_run_ids; do
      if candidate_satisfies_gate "$run_id"; then
        emit_run_id "$run_id"
        exit 0
      else
        status=$?
      fi
      if [[ "$status" -eq 64 ]]; then
        echo "permanent GitHub read failure while inspecting $workflow run $run_id" >&2
        exit 64
      fi
      if [[ "$status" -eq 75 ]]; then
        echo "transient GitHub read budget exhausted while inspecting $workflow run $run_id; the waiter remains active"
        continue
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
