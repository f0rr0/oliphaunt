#!/usr/bin/env bash
set -euo pipefail
owner="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ "$#" -ge 5 ]] || { echo 'usage: with-product-history.sh REPO HEAD BASE GRAPH COMMAND [ARGS...]' >&2; exit 2; }
repo="$(cd -P "$1" && pwd)"; head_ref="$2"; base_ref="$3"; graph="$4"; shift 4
state="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-product-history.XXXXXX")"
trap 'rm -rf "$state"' EXIT
export OLIPHAUNT_PRODUCT_HISTORY="$state"
reader="$owner/release-history.mts"
bash "$owner/../dev/bun.sh" "$owner/release-graph.mts" --history-inputs "$repo" "$graph"
head="$(git -C "$repo" rev-parse --verify "$head_ref^{commit}")"
empty=4b825dc642cb6eb9a060e54bf8d69288fbee4904
printf '%s\0%s\0%s\0' "$repo" "$head_ref" "$head" > "$state/context"
printf '%s\0%s\0%s\0%s\0%s\0%s\0' "$head_ref" "$head" "$head" "$head" "$empty" "$empty" > "$state/refs"
mkdir -p "$state/trees/$head" "$state/changes"
: > "$state/ancestors"
: > "$state/latest"
record_ref() {
  local ref="$1" commit
  commit="$(git -C "$repo" rev-parse --verify --quiet "$ref^{commit}" || true)"
  printf '%s\0%s\0' "$ref" "$commit" >> "$state/refs"
  if [[ -n "$commit" ]]; then
    printf '%s\0%s\0' "$commit" "$commit" >> "$state/refs"
    mkdir -p "$state/trees/$commit"
    if git -C "$repo" merge-base --is-ancestor "$commit" "$head"; then printf '%s\n' "$commit" >> "$state/ancestors"; fi
  fi
}
record_diff() {
  local base="$1" commit="$1"
  if [[ "$base" != "$empty" ]]; then commit="$(git -C "$repo" rev-parse --verify "$base^{commit}")"; fi
  [[ ! -f "$state/changes/$commit" ]] || return 0
  if [[ "$base" == "$empty" ]]; then
    git -C "$repo" diff --name-only -z "$empty" "$head" -- > "$state/changes/$commit"
  else
    git -C "$repo" diff --name-only -z "$commit...$head" -- > "$state/changes/$commit"
  fi
}
record_diff "$empty"
if [[ -n "$base_ref" && "$base_ref" != "$empty" ]]; then record_ref "$base_ref"; record_diff "$base_ref"; fi
while IFS= read -r -d '' prefix; do
  tag="$(git -C "$repo" describe --tags --abbrev=0 --match "${prefix}[0-9]*" "$head" 2>/dev/null || true)"
  printf '%s\0%s\0' "$prefix" "$tag" >> "$state/latest"
  if [[ -n "$tag" ]]; then record_ref "$tag"; record_diff "$tag"; fi
done < "$state/prefixes"
while IFS= read -r -d '' ref; do record_ref "$ref"; done < "$state/current-tags"
release="$(git -C "$repo" log -1 --format=%H '--grep=^chore(release): ' "$head" -- .release-please-manifest.json)"
if [[ -n "$release" ]]; then record_ref "$release"; fi
for directory in "$state"/trees/*; do
  git -C "$repo" ls-tree -r -z --name-only "$(basename "$directory")" > "$directory/files"
  if git -C "$repo" cat-file -e "$(basename "$directory"):release-please-config.json" 2>/dev/null; then
    mkdir -p "$directory/blobs"
    git -C "$repo" show "$(basename "$directory"):release-please-config.json" > "$directory/blobs/release-please-config.json"
  fi
done
bash "$owner/../dev/bun.sh" "$reader" files
for directory in "$state"/trees/*; do
  commit="$(basename "$directory")"
  while IFS= read -r -d '' file; do
    mkdir -p "$directory/blobs/$(dirname "$file")"
    git -C "$repo" show "$commit:$file" > "$directory/blobs/$file"
  done < "$directory/selected"
done
"$@"
