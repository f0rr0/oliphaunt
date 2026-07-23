#!/usr/bin/env bash
set -euo pipefail

: "${WASIX_HOME:=/opt/wasixcc-home/.wasixcc}"

if [ "${HOME:-}" != "${WASIX_HOME%/.wasixcc}" ] &&
   [ ! -e "$HOME/.wasixcc" ] &&
   [ ! -L "$HOME/.wasixcc" ]; then
  ln -s "$WASIX_HOME" "$HOME/.wasixcc"
fi

export PATH="$WASIX_HOME/bin:$PATH"
