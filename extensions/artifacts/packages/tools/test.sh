#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if [[ "${1:-}" != --context ]]; then
  exec bash tools/ci/with-projects.sh --exec bash extensions/artifacts/packages/tools/test.sh --context
fi
for test_file in extensions/artifacts/packages/tools/*.test.mts; do
  [[ -f "${test_file%.mts}.sh" ]] || bun test --timeout=120000 "./$test_file"
done
for test_file in extensions/artifacts/packages/tools/*.test.sh; do
  bash "$test_file"
done
