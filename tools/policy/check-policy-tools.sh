#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

run() {
  printf '\n==> %s\n' "$*"
  "$@"
}

run tools/policy/check-tooling-stack.sh
run python3 tools/policy/check-final-source-architecture.py --self-test
run python3 tools/policy/check-release-policy.py
run python3 tools/release/check_release_please_config.py
run python3 src/shared/contracts/tools/check-test-matrix.py --fixtures
run tools/release/check_release_metadata.py
run tools/release/release.py consumer-shape --format json --require-ready
run tools/release/release.py consumer-shape --format json --require-ready --products-json '["oliphaunt-react-native"]'
run tools/graph/graph.py check
run tools/policy/check-moon-product-graph.mjs
run tools/policy/check-test-strategy.mjs
