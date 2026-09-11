#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${OLIPHAUNT_MOON_TASK_GRAPH_FILE:?run through tools/ci/check-workflows.sh}"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
bash tools/dev/bun.sh test ./.github/scripts/resolve-planned-moon-execution.test.mts
resolver=.github/scripts/resolve-planned-moon-execution.mts
export OLIPHAUNT_CI_JOB_TARGETS_JSON='{"wasix-ts-sdk-package":["oliphaunt-wasix-ts:package","oliphaunt-wasix-ts:test-consumer","oliphaunt-wasix-ts:test-browser"]}'
export OLIPHAUNT_MOON_TRANSFERRED_DEPS_JSON='["liboliphaunt-wasix:runtime-portable","oliphaunt-wasix-napi:build-release-assets","extension-artifacts-wasix:compiler-output","database-resources:build-wasix-standard","database-resources:build-wasix-icu","database-resources:package-icu"]'
bash tools/dev/bun.sh "$resolver" wasix-ts-sdk-package >"$scratch/output"
for task in package test-consumer test-browser; do grep -Fx "$(printf 'target\toliphaunt-wasix-ts:%s' "$task")" "$scratch/output"; done
grep -Fx $'local\tdatabase-resources:package-wasix' "$scratch/output"
if grep -E $'^(local|target)\tdatabase-resources:build-wasix-' "$scratch/output"; then exit 1; fi
grep -Fx $'transferred\tliboliphaunt-wasix:runtime-portable' "$scratch/output"
for platform in android ios; do
  job="liboliphaunt-native-$platform-abi"
  root="database-resources:build-native-$platform-standard"
  targets=(ios-xcframework)
  [[ "$platform" != android ]] || targets=(android-arm64-v8a android-x86_64)
  export OLIPHAUNT_CI_JOB_TARGETS_JSON="{\"$job\":[\"$root\"]}"
  transfers='['
  printf 'target\t%s\n' "$root" >"$scratch/expected"
  for target in "${targets[@]}"; do
    transfers+="\"liboliphaunt-native:package-runtime-$target\",\"liboliphaunt-native:build-runtime-$target\","
    printf 'transferred\tliboliphaunt-native:build-runtime-%s\n' "$target" >>"$scratch/expected"
  done
  export OLIPHAUNT_MOON_TRANSFERRED_DEPS_JSON="${transfers%,}]"
  bash tools/dev/bun.sh "$resolver" "$job" >"$scratch/output"
  cmp "$scratch/expected" "$scratch/output"
done
export OLIPHAUNT_CI_JOB_TARGETS_JSON='{"react-native-sdk-package":["oliphaunt-react-native:test-consumer","oliphaunt-react-native:package"]}'
export OLIPHAUNT_MOON_TRANSFERRED_DEPS_JSON='["liboliphaunt-native:finalize-runtime-ios-abi"]'
bash tools/dev/bun.sh "$resolver" react-native-sdk-package >"$scratch/output"
grep $'^target\t' "$scratch/output" >"$scratch/targets"
printf 'target\toliphaunt-react-native:package\ntarget\toliphaunt-react-native:test-consumer\n' >"$scratch/expected"
cmp "$scratch/expected" "$scratch/targets"
if grep -E $'^local\t(oliphaunt-react-native:package|liboliphaunt-native:finalize-runtime-ios-abi)$' "$scratch/output"; then exit 1; fi
unset OLIPHAUNT_MOON_TRANSFERRED_DEPS_JSON
export OLIPHAUNT_CI_JOB_TARGETS_JSON='{"liboliphaunt-native-android":["liboliphaunt-native:package-runtime-android-arm64-v8a","liboliphaunt-native:package-runtime-android-x86_64"]}'
bash tools/dev/bun.sh "$resolver" liboliphaunt-native-android liboliphaunt-native:package-runtime-android-x86_64 >"$scratch/output"
printf 'target\tliboliphaunt-native:package-runtime-android-x86_64\n' >"$scratch/expected"
cmp "$scratch/expected" "$scratch/output"
if bash tools/dev/bun.sh "$resolver" liboliphaunt-native-android liboliphaunt-native:package-runtime-ios-xcframework >"$scratch/output" 2>"$scratch/error"; then
  echo 'accepted a target outside the job plan' >&2; exit 1
fi
grep -q 'is not planned' "$scratch/error"
