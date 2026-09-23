#!/usr/bin/env bash
set -euo pipefail
[[ "$#" -ge 3 ]] || {
  echo 'usage: release-please-state.sh ROOT HEAD_REF COMMAND [ARGS...]' >&2
  exit 2
}
cd -P "$1"
root="$PWD"
head_ref="$2"
shift 2
state="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-release-please.XXXXXX")"
trap 'rm -rf "$state"' EXIT
export OLIPHAUNT_RELEASE_PLEASE_STATE="$state"
worktree_ref="$head_ref"
printf '%s\0%s\0' "$root" "$worktree_ref" >"$state/context"
git rev-list --parents -n 1 "$worktree_ref" >"$state/ancestry"
read -r _ parent extra <"$state/ancestry"
if [[ -n "$parent" && -z "$extra" ]]; then
  git ls-tree --name-only -z "$parent" -- .release-please-manifest.json >"$state/prior-files"
  if [[ -s "$state/prior-files" ]]; then git show "$parent:.release-please-manifest.json" >"$state/manifest.json"; fi
  git ls-tree --name-only -z "$parent" -- release-please-config.json >"$state/prior-files"
  if [[ -s "$state/prior-files" ]]; then git show "$parent:release-please-config.json" >"$state/parent-config.json"; fi
fi
git ls-files -z --cached --others --exclude-standard -- Cargo.toml ':(glob)**/Cargo.toml' >"$state/cargo-files"
if [[ -n "$parent" && -z "$extra" ]]; then
  while IFS= read -r -d '' file; do
    git ls-tree --name-only -z "$parent" -- ":(literal)$file" >"$state/prior-files"
    if [[ -s "$state/prior-files" ]]; then
      mkdir -p "$state/prior-cargo/$(dirname "$file")"
      git show "$parent:$file" >"$state/prior-cargo/$file"
    fi
  done <"$state/cargo-files"
fi
"$@"
