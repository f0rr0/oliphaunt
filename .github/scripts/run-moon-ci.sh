#!/usr/bin/env bash
set -euo pipefail

moon_bin="${MOON_BIN:-}"
if [[ -z "$moon_bin" ]]; then
  for candidate in "$HOME/.proto/shims/moon" "$HOME/.proto/bin/moon"; do
    if [[ -x "$candidate" ]]; then
      moon_bin="$candidate"
      break
    fi
  done
fi
if [[ -z "$moon_bin" ]]; then
  moon_bin="moon"
fi

exec "$moon_bin" ci "$@"
