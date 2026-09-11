#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -z "${OLIPHAUNT_RELEASE_PLEASE_STATE:-}" ]]; then
  exec bash "$root/tools/release/release-please-state.sh" "$root" HEAD \
    bash "$root/tools/release/compatibility-version-policy.test.sh"
fi
scratch="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-compatibility-policy.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
fixture="$root/tools/release/compatibility-version-policy.test.mts"
commit() { git -C "$repo" add .; git -C "$repo" commit -qm "$1"; }
write() { bash "$root/tools/dev/bun.sh" "$fixture" write "$repo" "$scenario" "$1" "$scratch/graph.json"; }
assert_history() {
  bash "$root/tools/release/with-product-history.sh" "$repo" HEAD '' "$scratch/graph.json" \
    bash "$root/tools/dev/bun.sh" "$fixture" assert "$repo" "$scenario" "$1" "$scratch/graph.json" "$2"
}
for scenario in workspace first external-tag external-bump missing mismatch unrelated reused consumer-tags sdk-bump contrib; do
  repo="$scratch/$scenario"
  git init -q "$repo"
  git -C "$repo" config user.name 'Release Test'
  git -C "$repo" config user.email release-test@example.invalid
  printf 'legacy\n' > "$repo/legacy.txt"
  commit 'legacy history'
  case "$scenario" in first) write zero ;; mismatch) write mismatch ;; *) write v1 ;; esac
  commit 'release state'
  tagged="$(git -C "$repo" rev-parse HEAD)"
  case "$scenario" in
    workspace)
      bash "$root/tools/dev/bun.sh" "$fixture" workspace "$repo" "$scenario" ;;
    first) write released; commit 'chore(release): first release' ;;
    external-tag|external-bump|mismatch)
      git -C "$repo" tag oliphaunt-extension-vector-v1.0.0
      write released
      commit 'chore(release): product release' ;;
    unrelated)
      git -C "$repo" checkout -q --orphan collision
      git -C "$repo" rm -qrf .
      write v1
      commit 'unrelated vector identity'
      git -C "$repo" tag oliphaunt-extension-vector-v1.0.0
      git -C "$repo" checkout -q --detach "$tagged" ;;
    reused)
      git -C "$repo" tag oliphaunt-extension-vector-v1.0.0
      write mismatch
      commit 'regress vector identity'
      write v1
      commit 'chore(release): reuse vector 1.0.0' ;;
    consumer-tags)
      git -C "$repo" tag oliphaunt-js-v1.0.0
      git -C "$repo" tag oliphaunt-node-direct-v1.0.0
      write released
      commit 'chore(release): runtime release' ;;
    sdk-bump)
      git -C "$repo" tag oliphaunt-js-v1.0.0
      write released
      commit 'chore(release): JS SDK release' ;;
    contrib)
      git -C "$repo" tag oliphaunt-extension-amcheck-v1.0.0
      write released
      commit 'chore(release): runtime consumer release' ;;
  esac
  assert_history pending "$tagged"
  if [[ "$scenario" == contrib ]]; then
    tagged="$(git -C "$repo" rev-parse HEAD)"
    git -C "$repo" tag oliphaunt-extension-amcheck-v1.1.0
    printf 'ordinary change\n' > "$repo/ordinary-change.txt"
    commit 'docs: ordinary post-release commit'
    assert_history tagged "$tagged"
  fi
done
bash "$root/tools/dev/bun.sh" "$fixture" bindings
