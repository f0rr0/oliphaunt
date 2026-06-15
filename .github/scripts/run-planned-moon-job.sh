#!/usr/bin/env bash
set -euo pipefail

job="${1:-}"
if [[ -z "$job" ]]; then
  echo "usage: .github/scripts/run-planned-moon-job.sh <job-id>" >&2
  exit 2
fi

job_targets_json="${OLIPHAUNT_CI_JOB_TARGETS_JSON:-}"
if [[ -z "$job_targets_json" && -f target/graph/ci-plan.json ]]; then
  job_targets_json="$(python3 -c 'import json; print(json.dumps(json.load(open("target/graph/ci-plan.json")).get("job_targets", {})))')"
fi
if [[ -z "$job_targets_json" ]]; then
  echo "missing OLIPHAUNT_CI_JOB_TARGETS_JSON or target/graph/ci-plan.json" >&2
  exit 2
fi

targets_file="$(mktemp)"
trap 'rm -f "$targets_file"' EXIT

OLIPHAUNT_CI_JOB_TARGETS_JSON="$job_targets_json" python3 - "$job" >"$targets_file" <<'PY'
import json
import os
import sys

job = sys.argv[1]
try:
    mapping = json.loads(os.environ["OLIPHAUNT_CI_JOB_TARGETS_JSON"])
except json.JSONDecodeError as error:
    raise SystemExit(f"invalid CI job target JSON: {error}")
targets = mapping.get(job, [])
if not isinstance(targets, list) or not all(isinstance(target, str) for target in targets):
    raise SystemExit(f"CI job {job!r} has invalid target list")
for target in targets:
    print(target)
PY

targets=()
while IFS= read -r target; do
  target="${target%$'\r'}"
  targets+=("$target")
done <"$targets_file"

if [[ "${#targets[@]}" -eq 0 ]]; then
  echo "CI job '$job' has no planned Moon targets" >&2
  exit 2
fi

moon_args=()
if [[ -n "${OLIPHAUNT_MOON_UPSTREAM:-}" ]]; then
  moon_args+=(--upstream "$OLIPHAUNT_MOON_UPSTREAM")
fi

exec .github/scripts/run-moon-targets.sh "${moon_args[@]}" "${targets[@]}"
