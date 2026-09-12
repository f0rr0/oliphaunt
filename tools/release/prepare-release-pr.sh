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
bash tools/ci/with-projects.sh tools/release/prepare-release-candidate.mts "$1"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'required=%s\n' "$(cat "$1/required")" >>"$GITHUB_OUTPUT"
fi
