#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -z "${OLIPHAUNT_RELEASE_PLEASE_STATE:-}" ]]; then
  exec bash "$root/tools/release/release-please-state.sh" "$root" HEAD \
    bash "$root/tools/release/release-product-version-coverage.test.sh"
fi
scratch="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-release-coverage.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
git init -q "$scratch"
git -C "$scratch" config user.name 'Release Coverage Test'
git -C "$scratch" config user.email release-coverage@example.invalid
bash "$root/tools/dev/bun.sh" "$root/tools/release/release-product-version-coverage.test.mts" base "$scratch"
git -C "$scratch" add .
git -C "$scratch" commit -qm 'feat: introduce release coverage fixture'
base="$(git -C "$scratch" rev-parse HEAD)"
git -C "$scratch" update-ref refs/remotes/origin/main "$base"
for scenario in compatible source config; do
  git -C "$scratch" switch -qc "$scenario" "$base"
  bash "$root/tools/dev/bun.sh" "$root/tools/release/release-product-version-coverage.test.mts" release "$scratch" "$scenario"
  git -C "$scratch" add .
  git -C "$scratch" commit -qm 'chore(release): prepare runtime release'
  head="$(git -C "$scratch" rev-parse HEAD)"
  bash "$root/tools/release/with-release-history.sh" "$scratch" "$head" \
    bash "$root/tools/dev/bun.sh" "$root/tools/release/release-product-version-coverage.test.mts" \
    assert "$scratch" "$scenario" "$head"
done
