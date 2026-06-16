#!/usr/bin/env bash
set -euo pipefail

task="${1:-}"
if [[ -z "$task" ]]; then
  echo "usage: .github/scripts/run-affected-moon-task.sh <task-id>" >&2
  exit 2
fi

targets_file="$(mktemp)"
trap 'rm -f "$targets_file"' EXIT

bun .github/scripts/select-affected-moon-targets.mjs "$task" >"$targets_file"

targets=()
while IFS= read -r target; do
  target="${target%$'\r'}"
  [[ -n "$target" ]] && targets+=("$target")
done <"$targets_file"

if [[ "${#targets[@]}" -eq 0 ]]; then
  echo "No affected Moon '$task' targets selected"
  exit 0
fi

upstream="${OLIPHAUNT_MOON_UPSTREAM:-deep}"

printf 'Running %d affected Moon %s target(s) with upstream=%s:\n' "${#targets[@]}" "$task" "$upstream"
printf '  %s\n' "${targets[@]}"

exec .github/scripts/run-moon-targets.sh --upstream "$upstream" "${targets[@]}"
