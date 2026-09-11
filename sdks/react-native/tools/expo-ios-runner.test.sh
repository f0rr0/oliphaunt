#!/usr/bin/env bash
set -euo pipefail
tool="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/expo-ios-runner.mts"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
valid='EXTERNAL SOURCES:
  OliphauntReactNativePayload:
    :path: oliphaunt'
printf '%s\n' "$valid" > "$scratch/Podfile.lock"
bun "$tool" validate-pod-source "$scratch/Podfile.lock" "$scratch/oliphaunt" 1
for value in \
  "${valid/:path: oliphaunt/:path: ../elsewhere}" \
  "$valid"$'\n    :git: https://example.invalid/payload.git' \
  "$valid"$'\nPODS:\n  - OliphauntICU (1.0)' \
  "$valid"$'\nSPEC CHECKSUMS:\n  OliphauntICU: abc'; do
  printf '%s\n' "$value" > "$scratch/Podfile.lock"
  if bun "$tool" validate-pod-source "$scratch/Podfile.lock" "$scratch/oliphaunt" 1 > "$scratch/failure.log" 2>&1; then
    echo 'invalid CocoaPods source unexpectedly accepted' >&2
    exit 1
  fi
done
mkdir "$scratch/nested"
printf '%s\n' 'weak let first: Object?' 'nonisolated(unsafe) weak var second: Object?' 'let third: Object?' > "$scratch/nested/Refs.swift"
printf '%s\n' 'nonisolated(unsafe) weak var first: Object?' 'nonisolated(unsafe) weak var second: Object?' 'let third: Object?' > "$scratch/expected"
bun "$tool" patch-weak-references "$scratch"
cmp "$scratch/expected" "$scratch/nested/Refs.swift"
bun "$tool" patch-weak-references "$scratch"
cmp "$scratch/expected" "$scratch/nested/Refs.swift"
