#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
tests=()
shell_tests=(src/native/runtime/tools/liboliphaunt-extension-guard.test.sh src/native/runtime/tools/package-liboliphaunt-mobile-assets.test.sh)
for file in src/native/runtime/tools/*.test.mts; do
  if [[ -f "${file%.mts}.sh" ]]; then
    shell_tests+=("${file%.mts}.sh")
  else
    tests+=("./$file")
  fi
done
bash tools/dev/bun.sh test "${tests[@]}"
for file in "${shell_tests[@]}"; do bash "$file"; done
