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
run tools/dev/bun.sh test ./tools/ci/workflow-security.test.mts
run tools/dev/bun.sh tools/ci/workflow-security.mts
run bash .github/scripts/check-ci-gate.test.sh
run tools/dev/bun.sh test ./.github/scripts/resolve-mobile-e2e.test.mts
run bash .github/scripts/run-moon-targets.test.sh
graph_file="$(mktemp)"
observations="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-ci-observations.XXXXXX")"
trap 'rm -f "$graph_file"; rm -rf "$observations"' EXIT
"${MOON_BIN:-moon}" task-graph --json >"$graph_file"
export OLIPHAUNT_MOON_TASK_GRAPH_FILE="$graph_file"
export OLIPHAUNT_CI_TEST_OBSERVATIONS="$observations"
run tools/dev/bun.sh test ./.github/scripts/moon-task-capabilities.test.mts
run bash .github/scripts/write-affected-moon-target-matrices.test.sh
run bash .github/scripts/resolve-planned-moon-execution.test.sh
run bash tools/ci/with-projects.sh --exec bash tools/ci/capture-ci-test-observations.sh "$observations"
run bash tools/ci/ci-release-scope.test.sh
run bash tools/ci/with-projects.sh test \
  ./tools/ci/ci-plan-node-products.test.mts \
  ./tools/ci/ci-plan-wasix-postmaster-release.test.mts
run bash tools/ci/with-projects.sh --exec bash tools/ci/workflow-moon-transfers.test.sh
