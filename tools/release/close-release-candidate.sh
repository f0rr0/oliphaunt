#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 ]] || {
  echo 'usage: close-release-candidate.sh OUTPUT_DIRECTORY' >&2
  exit 2
}
[[ "${NATIVE_QUALIFICATION_RUN_ID:-}" =~ ^[1-9][0-9]*$ ]] || {
  echo 'native close requires an exact positive qualification run ID' >&2
  exit 1
}
cd "$(git rev-parse --show-toplevel)"
[[ "$(cat "$1/required")" == true ]] || exit 0
for check in check_release_please_config check_artifact_targets; do
  bash tools/dev/bun.sh "tools/release/$check.mts"
done
bash tools/release/with-source.sh HEAD bash tools/release/release-please-state.sh "$PWD" HEAD bash tools/release/with-release-history.sh "$PWD" HEAD bash tools/release/with-product-history.sh "$PWD" HEAD '' @workspace bash tools/dev/bun.sh tools/release/native-close-release-candidate.mts "$1"
