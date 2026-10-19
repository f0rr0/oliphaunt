#!/usr/bin/env bash
set -euo pipefail
helper="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/product-tags.mts"
allow_missing=false
target="${GITHUB_SHA:-HEAD}"
products=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --allow-missing) allow_missing=true; shift ;;
    --target) target="${2:?--target requires a commit}"; shift 2 ;;
    --products-json)
      # JSON remains data, including whitespace and shell metacharacters.
      products_json="${2:?--products-json requires an array}"
      shift 2
      ;;
    --*) echo "unknown argument: $1" >&2; exit 2 ;;
    *) products+=("$1"); shift ;;
  esac
done
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
if [ -n "${products_json:-}" ]; then
  [ "${#products[@]}" -eq 0 ] || { echo 'select products by name or JSON, not both' >&2; exit 2; }
  bun "$helper" --products-json "$products_json" > "$scratch/tags"
else
  bun "$helper" "${products[@]}" > "$scratch/tags"
fi
target_commit="$(git rev-parse --verify --end-of-options "$target^{commit}")"
remote=false
refs=()
while IFS= read -r tag; do refs+=("refs/tags/$tag"); done < "$scratch/tags"
if git remote get-url origin >/dev/null 2>&1; then
  remote=true
  git ls-remote --refs --tags origin "${refs[@]}" > "$scratch/remote"
  awk '{print $2}' "$scratch/remote" > "$scratch/remote-refs"
  fetch_refs=()
  for ref in "${refs[@]}"; do
    if grep -Fxq "$ref" "$scratch/remote-refs"; then fetch_refs+=("$ref:$ref"); fi
  done
  if [ "${#fetch_refs[@]}" -gt 0 ]; then git fetch --force --no-tags origin "${fetch_refs[@]}"; fi
fi
for ref in "${refs[@]}"; do
  if { [ "$remote" = true ] && ! grep -Fxq "$ref" "$scratch/remote-refs"; } ||
     { [ "$remote" = false ] && ! git show-ref --verify --quiet "$ref"; }; then
    [ "$allow_missing" = true ] || { echo "$ref does not exist; stage the exact-SHA draft release before publication" >&2; exit 1; }
    echo "$ref is absent and available for exact-SHA release creation"
    continue
  fi
  existing="$(git rev-parse --verify "$ref^{commit}")"
  if [ "$existing" != "$target_commit" ]; then
    echo "$ref points at $existing, not exact release commit $target_commit" >&2
    exit 1
  else
    echo "$ref points at $target_commit"
  fi
done
