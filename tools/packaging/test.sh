#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
tests=()
for test in tools/packaging/*.test.mts; do
  [[ -f "${test%.mts}.sh" ]] || tests+=("./$test")
done
bun test --timeout=30000 "${tests[@]}"
for test in tools/packaging/*.test.sh; do bash "$test"; done
