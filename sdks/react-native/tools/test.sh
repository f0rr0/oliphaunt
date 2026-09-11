#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
tests=(./src/__tests__)
for test in ./tools/*.test.mts; do
  [[ -f "${test%.mts}.sh" ]] || tests+=("$test")
done
bun test --isolate --timeout=30000 "${tests[@]}"
for test in tools/stage-ios-app.test.sh tools/ios-app-transport.test.sh tools/expo-ios-runner.test.sh tools/mobile-extension-artifact-paths.test.sh; do
  bash "$test"
done
for test in tools/mobile-extension-selection.test.sh tools/verify-android-apk.test.sh tools/android-apk-resources.test.sh tools/expo-android-gradle-limits.test.sh tools/expo-runner-android-device.test.sh tools/expo-runner-ios-installed-app.test.sh tools/expo-runner-workspace.test.sh; do
  bash "$test"
done
