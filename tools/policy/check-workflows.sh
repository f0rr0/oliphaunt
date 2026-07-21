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
if grep -R --line-number --fixed-strings 'python3 - <<' .github/workflows .github/actions; then
  echo "GitHub workflows and actions must not embed inline Python heredocs" >&2
  exit 1
fi
# actionlint 1.7.12 predates GitHub's `concurrency.queue: max` schema addition.
# Ignore only that parser diagnostic; the structured workflow contract below
# requires the field on the one serialized release dispatcher.
run actionlint -ignore 'unexpected key "queue" for "concurrency" section'
run zizmor --config .github/zizmor.yml --min-severity medium --persona auditor .github/workflows .github/actions
run node --test \
  .github/scripts/moon-task-capabilities.test.mjs \
  .github/scripts/setup-apple.test.mjs \
  .github/scripts/setup-msvc.test.mjs
run tools/dev/bun.sh test tools/release/toolchain-bootstrap.test.mjs
