#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -z "${OLIPHAUNT_RELEASE_PLEASE_STATE:-}" ]]; then
  exec bash "$root/tools/release/release-please-state.sh" "$root" HEAD \
    bash "$root/tools/release/verify-release-commit.test.sh"
fi
scratch="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-release-commit.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
fixture="$root/tools/release/verify-release-commit.test.mts"
commit() { git -C "$repo" add .; git -C "$repo" commit -qm "$1"; }
assert_history() {
  local head
  head="$(git -C "$repo" rev-parse HEAD)"
  bash "$root/tools/release/with-release-history.sh" "$repo" "$head" \
    bash "$root/tools/dev/bun.sh" "$fixture" assert "$repo" "$family" "$1" "$head" "${release:-}"
}
for family in bootstrap basic cargo wildcard wasix example; do
  repo="$scratch/$family"
  git init -q "$repo"
  git -C "$repo" config user.name 'Release Test'
  git -C "$repo" config user.email release@example.invalid
  bash "$root/tools/dev/bun.sh" "$fixture" write "$repo" "$family" base
  commit 'feat: introduce release fixture'
  base="$(git -C "$repo" rev-parse HEAD)"
  release=''
  case "$family" in
    bootstrap) assert_history base; scenarios=(clean mutated) ;;
    basic) scenarios=(clean later-fix downgrade tainted deletion rename hidden-version-config hidden-derived-config derived-version-only unrelated-derived-dependency) ;;
    cargo) scenarios=(exact unrelated-pin unrelated-package unrelated-lock) ;;
    wildcard) scenarios=(workspace-wildcard local-version wrong-version changed-path removed-path changed-features) ;;
    wasix) scenarios=(workspace-links) ;;
    example) scenarios=(exact wrong-registry-version wrong-runtime-version unrelated-registry-version missing-native-transition) ;;
  esac
  for scenario in "${scenarios[@]}"; do
    start="$base"
    if [[ "$scenario" == later-fix || "$scenario" == downgrade ]]; then start="$release"; fi
    git -C "$repo" switch -qc "$scenario" "$start"
    bash "$root/tools/dev/bun.sh" "$fixture" write "$repo" "$family" "$scenario"
    case "$scenario" in
      deletion) git -C "$repo" rm -q src/removable.rs ;;
      rename)
        git -C "$repo" rm -qf packages/alpha/VERSION
        git -C "$repo" mv src/future-version.txt packages/alpha/VERSION ;;
    esac
    if [[ "$scenario" == later-fix ]]; then commit 'fix(tools): repair publication';
    else commit 'chore(release): prepare product release'; fi
    if [[ "$scenario" == clean ]]; then release="$(git -C "$repo" rev-parse HEAD)"; fi
    assert_history "$scenario"
  done
done
