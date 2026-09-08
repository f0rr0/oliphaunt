#!/usr/bin/env bash
set -euo pipefail

unset MOON_BASE
unset MOON_HEAD

moon_bin="${MOON_BIN:-moon}"

if [ "${1:-}" = --matrix ]; then
  groups="$(bun .github/scripts/select-moon-target-groups.mts)"
  while IFS=$'\t' read -r upstream targets; do
    read -r -a target_args <<<"$targets"
    "$moon_bin" run --upstream "$upstream" "${target_args[@]}"
  done <<<"$groups"
else
  exec "$moon_bin" run "$@"
fi
