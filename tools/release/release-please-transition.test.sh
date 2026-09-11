#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
source_root="$PWD"
bun test ./tools/release/release-please-transition.test.mts
repo="$(mktemp -d)"
trap 'rm -rf "$repo"' EXIT
cd "$repo"
git init -q
git config user.name Fixture
git config user.email fixture@example.invalid
printf 'legacy history\n' > legacy.txt
git add .
git commit -qm legacy
bun "$source_root/tools/release/release-please-transition.test.mts" write-fixture "$repo" 0.0.0
git add .
git commit -qm introduction
observe() {
  bash "$source_root/tools/release/release-please-state.sh" "$repo" HEAD \
    bun "$source_root/tools/release/release-please-transition.test.mts" history "$repo" "$1"
}
observe introduction
bun "$source_root/tools/release/release-please-transition.test.mts" write-fixture "$repo" 1.0.0
observe invalid-introduction
git checkout -- .release-please-manifest.json
bun "$source_root/tools/release/release-please-transition.test.mts" write-fixture "$repo" 0.1.0
git add .
git commit -qm 'first release'
observe first-release
echo 'Release transition: actual parent snapshots distinguish introduction and first release'
