#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
[[ $# == 1 ]] || {
  echo 'usage: prepare-release-pr.sh OUTPUT_DIRECTORY' >&2
  exit 2
}
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || {
  echo 'release preparation requires a clean source checkout' >&2
  exit 1
}
export RELEASE_SOURCE_SHA RELEASE_SOURCE_DATE
RELEASE_SOURCE_SHA="$(git rev-parse HEAD)"
RELEASE_SOURCE_DATE="$(git show -s --format=%cs HEAD)"
bash tools/dev/bun.sh tools/release/release-please-pr-lifecycle.mts assert-clean --base main
if [[ -n "${NATIVE_QUALIFICATION_RUN_ID:-}" ]]; then
  OLIPHAUNT_CAPTURE_COMMIT_PATHS=1 bash tools/release/with-source.sh HEAD \
    bash tools/release/with-product-history.sh "$PWD" HEAD '' @workspace \
    bash tools/dev/bun.sh tools/release/prepare-release-candidate.mts "$1"
else
  OLIPHAUNT_CAPTURE_COMMIT_PATHS=1 bash tools/ci/with-projects.sh --exec \
    bash tools/release/with-product-history.sh "$PWD" HEAD '' @workspace \
    bash tools/dev/bun.sh tools/release/prepare-release-candidate.mts "$1"
fi
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'required=%s\n' "$(cat "$1/required")" >>"$GITHUB_OUTPUT"
  native_inputs=false
  if [[ -n "${NATIVE_QUALIFICATION_RUN_ID:-}" && "$(cat "$1/required")" == true ]]; then
    [[ -f "$1/native-release-inputs/native-version-source.json" && -f "$1/native-release-inputs/native-publication-inputs.json" ]] || {
      echo 'native preparation did not retain its completed input packet' >&2
      exit 1
    }
    native_inputs=true
  fi
  printf 'native_inputs=%s\n' "$native_inputs" >>"$GITHUB_OUTPUT"
fi
