#!/usr/bin/env bash
set -euo pipefail
tools="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$tools/../../.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
bun test "$tools/mobile-extension-artifact-paths.test.mts"
mkdir "$scratch/artifacts"
arguments=(--root "$root" --artifact-root "$scratch/artifacts" --materialize-root "$scratch/cache" --extensions vector --asset-kind runtime --asset-target android-arm64-v8a)
for required in 0 1; do
  status=0
  bun "$tools/mobile-extension-artifact-paths.mts" "${arguments[@]}" --required "$required" > "$scratch/output" 2> "$scratch/error" || status=$?
  if [[ "$required" == 0 ]]; then expected=3; else expected=1; fi
  [[ "$status" == "$expected" && ! -s "$scratch/output" ]]
  grep -q 'missing exact-extension artifact(s): vector: package' "$scratch/error"
done
status=0
bun "$tools/mobile-extension-artifact-paths.mts" "${arguments[@]}" --required 0 --required 1 > "$scratch/output" 2> "$scratch/error" || status=$?
[[ "$status" == 2 ]]
grep -q 'duplicate option: --required' "$scratch/error"
