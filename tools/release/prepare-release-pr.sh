#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 ]] || {
  echo 'usage: prepare-release-pr.sh OUTPUT_DIRECTORY' >&2
  exit 2
}
[[ "${NATIVE_QUALIFICATION_RUN_ID:-}" =~ ^[1-9][0-9]*$ ]] || {
  echo 'native preparation requires an exact positive qualification run ID' >&2
  exit 1
}
root="$(git rev-parse --show-toplevel)"
cd "$root"
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || {
  echo 'release preparation requires a clean source checkout' >&2
  exit 1
}
export RELEASE_SOURCE_SHA RELEASE_SOURCE_DATE
RELEASE_SOURCE_SHA="$(git rev-parse HEAD)"
RELEASE_SOURCE_DATE="$(git show -s --format=%cs HEAD)"
bash tools/dev/bun.sh tools/release/release-please-pr-lifecycle.mts assert-clean --base main
OLIPHAUNT_CAPTURE_COMMIT_PATHS=1 bash tools/release/with-source.sh HEAD \
  bash tools/release/with-product-history.sh "$PWD" HEAD '' @workspace \
  bash tools/dev/bun.sh tools/release/prepare-release-candidate.mts "$1"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'required=%s\n' "$(cat "$1/required")" >>"$GITHUB_OUTPUT"
  native_inputs=false
  if [[ "$(cat "$1/required")" == true ]]; then
    [[ -f "$1/native-release-inputs/native-version-source.json" && -f "$1/native-release-inputs/native-publication-inputs.json" ]] || {
      echo 'native preparation did not retain its completed input packet' >&2
      exit 1
    }
    native_inputs=true
  fi
  printf 'native_inputs=%s\n' "$native_inputs" >>"$GITHUB_OUTPUT"
fi
