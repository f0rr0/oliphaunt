#!/usr/bin/env bash
set -euo pipefail
owner="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ "$#" -ge 4 ]] || { echo 'usage: release-please-state.sh ROOT HEAD_REF GRAPH_FILE COMMAND [ARGS...]' >&2; exit 2; }
cd -P "$1"
root="$PWD"; head_ref="$2"; graph="$3"; shift 3
state="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-release-please.XXXXXX")"
trap 'rm -rf "$state"' EXIT
export OLIPHAUNT_RELEASE_PLEASE_STATE="$state"
worktree_ref="$head_ref"
[[ "$worktree_ref" != @sync ]] || worktree_ref=HEAD
printf '%s\0%s\0' "$root" "$worktree_ref" > "$state/context"
git rev-list --parents -n 1 "$worktree_ref" > "$state/ancestry"
read -r _ parent extra < "$state/ancestry"
if [[ -n "$parent" && -z "$extra" ]]; then
  git ls-tree --name-only -z "$parent" -- .release-please-manifest.json > "$state/prior-files"
  if [[ -s "$state/prior-files" ]]; then git show "$parent:.release-please-manifest.json" > "$state/manifest.json"; fi
fi
git ls-files -z --cached --others --exclude-standard -- Cargo.toml ':(glob)**/Cargo.toml' > "$state/cargo-files"
if [[ -n "$parent" && -z "$extra" ]]; then
  while IFS= read -r -d '' file; do
    git ls-tree --name-only -z "$parent" -- ":(literal)$file" > "$state/prior-files"
    if [[ -s "$state/prior-files" ]]; then
      mkdir -p "$state/prior-cargo/$(dirname "$file")"
      git show "$parent:$file" > "$state/prior-cargo/$file"
    fi
  done < "$state/cargo-files"
fi
if [[ -n "$graph" ]]; then
  bash "$owner/../dev/bun.sh" "$owner/release-please-transition.mts" --snapshot-inputs "$root" "$head_ref" "$graph"
  IFS= read -r shared_head < "$state/shared-head"
  inputs=()
  while IFS= read -r -d '' input; do inputs+=("$input"); done < "$state/inputs"
  for prefixes in "$state"/*.prefixes; do
    tag=''
    while IFS= read -r -d '' prefix; do
      tag="$(git describe --tags --abbrev=0 --match "${prefix}[0-9]*" "$shared_head" 2>/dev/null || true)"
      [[ -z "$tag" ]] || break
    done < "$prefixes"
    printf '%s\n' "$tag" > "${prefixes%.prefixes}.tag"
    if [[ -n "$tag" ]]; then
      git log --reverse -z --format='%H%x00%s%x00%b' "$tag..$shared_head" -- "${inputs[@]}" > "${prefixes%.prefixes}.commits"
    fi
  done
fi
"$@"
