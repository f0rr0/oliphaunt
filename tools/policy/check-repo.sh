#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"
PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"
export PATH

run() {
  printf '\n==> %s\n' "$*"
  "$@"
}

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    echo "run tools/dev/bootstrap-tools.sh to install pinned maintainer tools" >&2
    exit 1
  fi
}

run tools/policy/check-repo-structure.sh
run tools/policy/check-tooling-stack.sh
run tools/policy/check-docs.sh
run tools/policy/check-release-policy.py
run tools/release/check_release_metadata.py
run tools/policy/check-moon-product-graph.mjs
run tools/policy/check-prek.sh
