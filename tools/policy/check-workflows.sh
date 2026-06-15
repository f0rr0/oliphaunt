#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"
PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"
export PATH

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    echo "run tools/dev/bootstrap-tools.sh to install pinned maintainer tools" >&2
    exit 1
  fi
}

run() {
  printf '\n==> %s\n' "$*"
  "$@"
}

require actionlint
require zizmor
if grep -R --line-number --fixed-strings 'pnpm moon run' .github/workflows; then
  echo "GitHub workflows must invoke Moon through .github/scripts/run-moon-targets.sh" >&2
  exit 1
fi
run actionlint
run zizmor --config .github/zizmor.yml --min-severity medium --persona auditor .github/workflows .github/actions
