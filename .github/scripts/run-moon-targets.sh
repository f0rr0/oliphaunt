#!/usr/bin/env bash
set -euo pipefail

unset MOON_BASE
unset MOON_HEAD

moon_bin="${MOON_BIN:-moon}"

if [ "${1:-}" = --matrix ]; then
  groups="$(bun .github/scripts/select-moon-target-groups.mts)"
  while IFS=$'\t' read -r upstream targets; do
    read -r -a target_args <<<"$targets"
    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
      printf '\nSelected Moon tasks:\n\n' >> "$GITHUB_STEP_SUMMARY"
      printf -- '- `%s`\n' "${target_args[@]}" >> "$GITHUB_STEP_SUMMARY"
    fi
    "$moon_bin" run --upstream "$upstream" "${target_args[@]}"
  done <<<"$groups"
else
  exec "$moon_bin" run "$@"
fi
