#!/usr/bin/env bash
set -euo pipefail
owner="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ "$#" -ge 3 ]] || { echo 'usage: with-release-history.sh REPO REF COMMAND [ARGS...]' >&2; exit 2; }
repo="$(cd -P "$1" && pwd)"; ref="$2"; shift 2
state="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-release-history.XXXXXX")"
trap 'rm -rf "$state"' EXIT
export OLIPHAUNT_RELEASE_HISTORY="$state"
head="$(git -C "$repo" rev-parse --verify "$ref^{commit}")"
release="$(git -C "$repo" log -1 --format=%H '--grep=^chore(release): ' "$head" -- .release-please-manifest.json)"
printf '%s\0%s\0%s\0%s\0' "$repo" "$ref" "$head" "$release" > "$state/context"
for commit in "$head" "$release"; do
  [[ -n "$commit" && ! -f "$state/$commit/ancestry" ]] || continue
  mkdir -p "$state/$commit"
  git -C "$repo" rev-list --parents -n 1 "$commit" > "$state/$commit/ancestry"
  git -C "$repo" show -s --format=%s "$commit" > "$state/$commit/subject"
  read -r _ parent extra < "$state/$commit/ancestry"
  if [[ -n "$parent" && -z "$extra" ]]; then
    mkdir -p "$state/$parent"
    git -C "$repo" diff --no-renames --name-only --diff-filter=ACDMRT -z "$parent" "$commit" -- > "$state/$commit/changed"
  fi
done
for directory in "$state"/*/; do
  commit="$(basename "$directory")"
  git -C "$repo" ls-tree -r -z --name-only "$commit" > "$directory/files"
  if git -C "$repo" cat-file -e "$commit:release-please-config.json" 2>/dev/null; then
    git -C "$repo" show "$commit:release-please-config.json" > "$directory/config.json"
  fi
done
bash "$owner/../dev/bun.sh" "$owner/verify-release-commit.mts" --snapshot-paths
for directory in "$state"/*/; do
  commit="$(basename "$directory")"
  while IFS= read -r -d '' file; do
    mkdir -p "$directory/blobs/$(dirname "$file")"
    git -C "$repo" show "$commit:$file" > "$directory/blobs/$file"
  done < "$directory/paths"
done
"$@"
