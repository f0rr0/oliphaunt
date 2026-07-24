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
selected_artifacts_json='[]'
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
if [[ ! "$sha" =~ ^[0-9A-Fa-f]{40}$ ]]; then
  echo "workflow gate SHA must be a full hexadecimal commit SHA" >&2
  exit 2
fi

github_read() {
  local label="${1:?GitHub read label is required}"
  shift
  node tools/release/github-read.mjs --label "$label" -- "$@"
}

github_paginated_json() {
  local label="${1:?GitHub paginated read label is required}"
  local field="${2:?GitHub paginated read field is required}"
  local endpoint="${3:?GitHub paginated read endpoint is required}"
  node tools/release/github-read.mjs \
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
      echo "artifact_metadata_json=$selected_artifacts_json"
    } >> "$GITHUB_OUTPUT"
  fi
  echo "selected $workflow run $run_id"
}

run_matches_request() {
  local run_id="$1"
  local row status
  row="$(
    github_read "$workflow run $run_id metadata" \
      api "repos/$GH_REPO/actions/runs/$run_id" \
      --jq '[.head_sha, .workflow_id, .event, .status, (.conclusion // "")] | @tsv'
  )" || {
    status=$?
    echo "failed to inspect $workflow run $run_id" >&2
    return "$status"
  }

  local run_sha workflow_id run_event run_status run_conclusion workflow_name
  IFS=$'\t' read -r run_sha workflow_id run_event run_status run_conclusion <<< "$row"
  if [[ "$(printf '%s' "$run_sha" | normalize_sha)" != "$(printf '%s' "$sha" | normalize_sha)" ]]; then
    echo "$workflow run $run_id belongs to $run_sha, not $sha" >&2
    return 1
  fi
  workflow_name="$(
    github_read "workflow $workflow_id metadata" \
      api "repos/$GH_REPO/actions/workflows/$workflow_id" --jq .name
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
  # A successful named job is not sufficient release evidence while the
  # enclosing run is still mutable or has an unsuccessful final conclusion.
  # This also keeps the waiter aligned with the documented non-cancelled,
  # exact-SHA qualification contract.
  if [[ "$run_status" != "completed" || "$run_conclusion" != "success" ]]; then
    echo "$workflow run $run_id is $run_status/${run_conclusion:-<none>}, not completed/success" >&2
    return 1
  fi
}

required_artifacts_present() {
  local run_id="$1"
  if [[ "${#required_artifacts[@]}" -eq 0 ]]; then
    selected_artifacts_json='[]'
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
  required_json="$(printf '%s\n' "${required_artifacts[@]}" | bun -e '
const names = (await Bun.stdin.text()).split(/\r?\n/u).filter(Boolean);
process.stdout.write(JSON.stringify(names));
')"
  local selected status
  # shellcheck disable=SC2016
  if selected="$(REQUIRED_ARTIFACTS_JSON="$required_json" bun -e '
const expected = JSON.parse(process.env.REQUIRED_ARTIFACTS_JSON);
let records;
try {
  records = JSON.parse(await Bun.stdin.text());
} catch (cause) {
  console.error(`artifact inventory is not valid JSON: ${cause.message}`);
  process.exit(64);
}
if (!Array.isArray(expected) || expected.length === 0 || new Set(expected).size !== expected.length) {
  console.error("required artifact identity list is malformed");
  process.exit(64);
}
if (!Array.isArray(records) || records.some((entry) =>
  entry === null || Array.isArray(entry) || typeof entry !== "object" ||
  typeof entry.name !== "string" || typeof entry.expired !== "boolean" ||
  !Number.isSafeInteger(entry.id) || entry.id < 1 ||
  !Number.isSafeInteger(entry.size_in_bytes) || entry.size_in_bytes < 1 ||
  typeof entry.digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(entry.digest)
)) {
  console.error("artifact inventory contains malformed metadata");
  process.exit(64);
}
const selected = [];
for (const name of expected) {
  const matches = records.filter((entry) => entry.name === name && entry.expired === false);
  if (matches.length !== 1) {
    console.error(`expected exactly one non-expired artifact named ${name}; found ${matches.length}`);
    process.exit(1);
  }
  const [entry] = matches;
  selected.push({ digest: entry.digest, id: entry.id, name: entry.name, size: entry.size_in_bytes });
}
selected.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
process.stdout.write(JSON.stringify(selected));
' <<< "$artifacts_json")"; then
    selected_artifacts_json="$selected"
  else
    status=$?
    selected_artifacts_json='[]'
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
  if github_read "$workflow run $run_id jobs" \
    run view "$run_id" --repo "$GH_REPO" --json jobs > "$jobs_file"; then
    :
  else
    status=$?
    rm -f "$jobs_file"
    return "$status"
  fi

  local conclusion
  # shellcheck disable=SC2016
  if ! conclusion="$(
    bun -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(Bun.argv[1], "utf8"));
const required = Bun.argv.slice(2);
if (!Array.isArray(data.jobs)) {
  console.error("workflow job inventory must be a list");
  process.exit(1);
}
const failures = required
  .map((name) => {
    const matches = data.jobs.filter((job) => job?.name === name);
    if (matches.length !== 1) return [name, `count-${matches.length}`];
    return [name, matches[0]?.conclusion ?? "missing"];
  })
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
  WORKFLOW_NAME="$workflow" bun -e '
const expected = process.env.WORKFLOW_NAME;
let rows;
try {
  rows = JSON.parse(await Bun.stdin.text());
} catch (cause) {
  console.error(`workflow inventory is not valid JSON: ${cause.message}`);
  process.exit(1);
}
if (!Array.isArray(rows)) {
  console.error("workflow inventory must be a list");
  process.exit(1);
}
const matches = rows.filter((row) => row?.name === expected);
if (matches.length !== 1 || !Number.isSafeInteger(matches[0]?.id) || matches[0].id < 1) {
  console.error(`expected exactly one workflow named ${expected}; found ${matches.length}`);
  process.exit(1);
}
process.stdout.write(String(matches[0].id));
' <<< "$workflows_json" || return 64
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
  EXPECTED_SHA="$(printf '%s' "$sha" | normalize_sha)" bun -e '
const expectedSha = process.env.EXPECTED_SHA;
let rows;
try {
  rows = JSON.parse(await Bun.stdin.text());
} catch (cause) {
  console.error(`workflow run inventory is not valid JSON: ${cause.message}`);
  process.exit(1);
}
if (!Array.isArray(rows)) {
  console.error("workflow run inventory must be a list");
  process.exit(1);
}
const ids = new Set();
const rendered = [];
for (const row of rows) {
  const conclusion = row?.conclusion ?? "";
  if (
    row === null || Array.isArray(row) || typeof row !== "object" ||
    !Number.isSafeInteger(row.id) || row.id < 1 || ids.has(row.id) ||
    typeof row.head_sha !== "string" || row.head_sha.toLowerCase() !== expectedSha ||
    typeof row.status !== "string" || typeof conclusion !== "string" ||
    typeof row.html_url !== "string" || /[\t\r\n]/u.test(row.html_url) ||
    typeof row.event !== "string" || /[\t\r\n]/u.test(row.event)
  ) {
    console.error("workflow run inventory contains malformed, duplicate, or non-exact-SHA metadata");
    process.exit(1);
  }
  ids.add(row.id);
  rendered.push([row.id, row.status, conclusion, row.html_url, row.event].join("\t"));
}
process.stdout.write(rendered.join("\n"));
' <<< "$runs_json" || return 64
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
