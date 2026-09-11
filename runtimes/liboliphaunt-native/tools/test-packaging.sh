#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
tests=()
shell_tests=(runtimes/liboliphaunt-native/tools/liboliphaunt-extension-guard.test.sh)
for file in runtimes/liboliphaunt-native/tools/*.test.mts; do
  if [[ -f "${file%.mts}.sh" ]]; then
    shell_tests+=("${file%.mts}.sh")
  else
    tests+=("./$file")
  fi
done
bun test --timeout=30000 "${tests[@]}"
for file in "${shell_tests[@]}"; do bash "$file"; done
