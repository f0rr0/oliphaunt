#!/usr/bin/env bash
set -euo pipefail
[[ "$#" -gt 0 ]] || { echo 'usage: with-release-tags.sh COMMAND [ARGS...]' >&2; exit 2; }
scratch="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-release-tags.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
RELEASE_TAG_REFS="$scratch/refs"
RELEASE_TAG_COMMITS="$scratch/commits"
RELEASE_TAG_CONTRIB="$scratch/contrib"
export RELEASE_TAG_REFS RELEASE_TAG_COMMITS RELEASE_TAG_CONTRIB
git show-ref --tags --dereference > "$RELEASE_TAG_REFS" || {
  status=$?; [[ "$status" == 1 ]] || exit "$status";
}
git log --no-walk --tags --format='%H %P' > "$RELEASE_TAG_COMMITS"
: > "$RELEASE_TAG_CONTRIB"
while read -r _ ref; do
  case "$ref" in
    *'^{}') continue ;;
    refs/tags/liboliphaunt-native-v*|refs/tags/liboliphaunt-wasix-v*)
      git ls-tree --name-only -z "$ref" -- src/extensions/contrib/carriers.toml > "$scratch/entry"
      present=false
      [[ ! -s "$scratch/entry" ]] || present=true
      printf '%s\0%s\0' "${ref#refs/tags/}" "$present" >> "$RELEASE_TAG_CONTRIB" ;;
  esac
done < "$RELEASE_TAG_REFS"
"$@"
