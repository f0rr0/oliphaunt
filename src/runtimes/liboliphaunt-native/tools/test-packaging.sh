#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
tests=()
shell_tests=(src/runtimes/liboliphaunt-native/tools/liboliphaunt-extension-guard.test.sh src/runtimes/liboliphaunt-native/tools/package-liboliphaunt-mobile-assets.test.sh)
for file in src/runtimes/liboliphaunt-native/tools/*.test.mts; do
  if [[ -f "${file%.mts}.sh" ]]; then
    shell_tests+=("${file%.mts}.sh")
  else
    tests+=("./$file")
  fi
done
bash tools/dev/bun.sh test "${tests[@]}"
for file in "${shell_tests[@]}"; do bash "$file"; done
