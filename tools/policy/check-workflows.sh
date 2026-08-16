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
# actionlint 1.7.12 predates GitHub's `concurrency.queue: max` schema addition.
run actionlint -ignore 'unexpected key "queue" for "concurrency" section'
run zizmor --config .github/zizmor.yml --min-severity medium --persona auditor .github/workflows .github/actions
run tools/dev/bun.sh test tools/policy/assertions/workflow-security.test.mjs
run tools/dev/bun.sh tools/policy/assertions/workflow-security.mjs
run node --test \
  .github/scripts/configure-macos-release-toolchains.test.mjs \
  .github/scripts/moon-task-capabilities.test.mjs \
  .github/scripts/write-affected-moon-target-matrices.test.mjs
run tools/dev/bun.sh test tools/policy/ci-plan-wasix-postmaster-release.test.mjs
run tools/dev/bun.sh test tools/release/toolchain-bootstrap.test.mjs
