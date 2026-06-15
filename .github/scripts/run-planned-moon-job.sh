#!/usr/bin/env bash
set -euo pipefail

job="${1:-}"
if [[ -z "$job" ]]; then
  echo "usage: .github/scripts/run-planned-moon-job.sh <job-id>" >&2
  exit 2
fi

targets_file="$(mktemp)"
trap 'rm -f "$targets_file"' EXIT

bun .github/scripts/select-planned-moon-targets.mjs "$job" >"$targets_file"

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
