#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

need_cmd curl
need_cmd java

export MAESTRO_CLI_NO_ANALYTICS=true
export MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
maestro_bin="$HOME/.maestro/bin/maestro"

version="$(sed -n 's/^[[:space:]]*maestro[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' src/sources/toolchains/maestro.toml | head -n 1)"
[ -n "$version" ] || {
  echo "missing maestro version in src/sources/toolchains/maestro.toml" >&2
  exit 1
}

if command -v maestro >/dev/null 2>&1 || [ -x "$maestro_bin" ]; then
  if command -v maestro >/dev/null 2>&1; then
    current="$(maestro --version 2>/dev/null | awk '{print $NF}' | sed 's/^cli-//')"
  else
    current="$("$maestro_bin" --version 2>/dev/null | awk '{print $NF}' | sed 's/^cli-//')"
  fi
  if [ "$current" = "$version" ] || [ "cli-$current" = "$version" ]; then
    if command -v maestro >/dev/null 2>&1; then
      maestro --version
    else
      "$maestro_bin" --version
    fi
    if [ -n "${GITHUB_PATH:-}" ]; then
      printf '%s\n' "$HOME/.maestro/bin" >>"$GITHUB_PATH"
    fi
    exit 0
  fi
fi

export MAESTRO_VERSION="$version"
curl -fsSL "https://get.maestro.mobile.dev" | bash

[ -x "$maestro_bin" ] || {
  echo "maestro install did not produce $maestro_bin" >&2
  exit 1
}

if [ -n "${GITHUB_PATH:-}" ]; then
  printf '%s\n' "$HOME/.maestro/bin" >>"$GITHUB_PATH"
fi

"$maestro_bin" --version
