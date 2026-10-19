#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -z "${OLIPHAUNT_RELEASE_PLEASE_STATE:-}" ]]; then
  exec bash "$root/tools/release/release-please-state.sh" "$root" HEAD \
    bash "$root/tools/release/release-version-transition.test.sh"
fi
scratch="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-release-transition.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
fixture="$root/tools/release/release-version-transition.test.mts"
commit() { git -C "$repo" add .; git -C "$repo" commit -qm "$1"; }
write() { bash "$root/tools/dev/bun.sh" "$fixture" write "$repo" "$scenario" "$1" "$scratch/graph.json"; }
tag_v1() {
  for product in liboliphaunt-native liboliphaunt-wasix oliphaunt-extension-vector; do
    git -C "$repo" tag "$product-v1.0.0"
  done
}
for scenario in compatible inline-source source invalid-pin native production external first zero rerun tooling regressed canonical detached unrelated; do
  repo="$scratch/$scenario"
  git init -q "$repo"
  git -C "$repo" config user.name 'Release Test'
  git -C "$repo" config user.email release-test@example.invalid
  write base
  commit 'initial products'
  candidate="$(git -C "$repo" rev-parse HEAD)"
  case "$scenario" in
    first|zero) ;;
    canonical)
      printf '9.9.9\n' > "$repo/packages/vector/VERSION"
      commit 'corrupt tagged canonical version'
      tag_v1 ;;
    detached)
      mkdir -p "$repo/metadata"
      printf '1.0.0\n' > "$repo/metadata/vector-version"
      commit 'add detached version metadata'
      tag_v1
      write release
      commit 'detached vector version bump' ;;
    unrelated)
      git -C "$repo" checkout -q --orphan collision
      git -C "$repo" rm -qrf .
      write different
      commit 'conflicting vector identity'
      git -C "$repo" tag oliphaunt-extension-vector-v1.0.0
      git -C "$repo" checkout -q --detach "$candidate" ;;
    *)
      tag_v1
      case "$scenario" in
        rerun) ;;
        tooling)
          mkdir -p "$repo/tools/release"
          printf 'release tooling repair\n' > "$repo/tools/release/rerun-note.txt"
          commit 'repair release tooling' ;;
        external|regressed)
          write runtime
          commit 'release runtimes v2'
          git -C "$repo" tag liboliphaunt-native-v2.0.0
          git -C "$repo" tag liboliphaunt-wasix-v2.0.0
          write release
          commit 'advance release state' ;;
        *)
          write release
          if [[ "$scenario" == source ]]; then printf 'rev = "v2"\n' > "$repo/packages/vector/source.toml"; fi
          commit 'release runtimes' ;;
      esac ;;
  esac
  bash "$root/tools/release/with-product-history.sh" "$repo" HEAD '' "$scratch/graph.json" \
    bash "$root/tools/dev/bun.sh" "$fixture" assert "$repo" "$scenario"
done
bash "$root/tools/dev/bun.sh" "$fixture" pins
