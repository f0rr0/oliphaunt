#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
for test_file in extensions/artifacts/native/tools/*.test.mts; do
  [[ -f "${test_file%.mts}.sh" ]] || bun test --timeout=30000 "./$test_file"
done
for test_file in extensions/artifacts/native/tools/*.test.sh; do
  bash "$test_file"
done
