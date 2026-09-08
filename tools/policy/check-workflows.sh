#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"
PATH="$PATH:${CARGO_HOME:-$HOME/.cargo}/bin"
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
run tools/dev/bun.sh test ./tools/policy/assertions/workflow-security.test.mts
run tools/dev/bun.sh tools/policy/assertions/workflow-security.mts
run bash .github/scripts/run-moon-targets.test.sh
graph_file="$(mktemp)"
trap 'rm -f "$graph_file"' EXIT
"${MOON_BIN:-moon}" task-graph --json >"$graph_file"
export OLIPHAUNT_MOON_TASK_GRAPH_FILE="$graph_file"
run node --test \
  .github/scripts/configure-macos-release-toolchains.test.mts \
  .github/scripts/moon-task-capabilities.test.mts \
  .github/scripts/write-affected-moon-target-matrices.test.mts \
  .github/scripts/resolve-planned-moon-execution.test.mts
run bash tools/graph/with-projects.sh test \
  ./tools/policy/ci-plan-node-products.test.mts \
  ./tools/policy/ci-plan-wasix-postmaster-release.test.mts \
  ./tools/policy/workflow-moon-transfers.test.mts
