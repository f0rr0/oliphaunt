#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
tests=()
for test in tools/packaging/*.test.mts; do
  [[ -f "${test%.mts}.sh" ]] || tests+=("./$test")
done
bash tools/dev/bun.sh test "${tests[@]}"
for test in tools/packaging/*.test.sh; do bash "$test"; done
