#!/usr/bin/env bash
set -euo pipefail

[[ "$#" == 3 ]] || {
  echo 'usage: snapshot-commit-paths.sh REPOSITORY HEAD NEW_DIRECTORY' >&2
  exit 2
}
repo="$1"; head_ref="$2"; destination="$3"
[[ "$(git -C "$repo" rev-parse --is-shallow-repository)" == false ]] || {
  echo 'commit path capture requires complete Git history' >&2
  exit 1
}
head="$(git -C "$repo" rev-parse --verify "$head_ref^{commit}")"
mkdir "$destination"
complete=false
trap 'if [[ "$complete" != true ]]; then rm -rf "$destination"; fi' EXIT
printf 'head %s\n' "$head" > "$destination/.parents"

# One Git traversal captures every reachable commit. --no-renames reports both
# the old deletion and new addition; merge commits compare with their first
# parent, and --root supplies the initial creation. An empty NUL field begins
# each commit frame and cannot be confused with a legal Git filename.
git --no-replace-objects -C "$repo" log '--format=%x00%H %P' --no-show-signature --name-only -z --root --no-renames \
  --diff-merges=first-parent --no-ext-diff --no-textconv --ignore-submodules=none \
  "$head" -- > "$destination/.capture"
expect_sha=false
first_path=false
current=''
commit_frame='^[0-9a-f]{40}( [0-9a-f]{40})*$'
while IFS= read -r -d '' field; do
  if [[ -z "$field" ]]; then
    expect_sha=true
  elif [[ "$expect_sha" == true ]]; then
    metadata="${field% }"
    current="${metadata%% *}"
    [[ "$metadata" =~ $commit_frame && ! -e "$destination/$current" ]] || {
      echo 'malformed or duplicate commit frame in Git path capture' >&2
      exit 1
    }
    printf '%s\n' "$metadata" >> "$destination/.parents"
    : > "$destination/$current"
    expect_sha=false
    first_path=true
  else
    [[ -n "$current" ]] || { echo 'missing commit frame in Git path capture' >&2; exit 1; }
    # Git inserts exactly one LF between its commit header and the first path.
    # Remove that separator, preserving any LF belonging to the filename.
    if [[ "$first_path" == true ]]; then
      [[ "$field" == $'\n'* ]] || { echo 'missing Git path separator' >&2; exit 1; }
      field="${field#$'\n'}"
      first_path=false
    fi
    [[ -n "$field" ]] || { echo 'empty path in Git capture' >&2; exit 1; }
    printf '%s\0' "$field" >> "$destination/$current"
  fi
done < "$destination/.capture"
[[ -f "$destination/$head" && "$expect_sha" == false ]] || {
  echo 'incomplete Git commit path capture' >&2
  exit 1
}
rm "$destination/.capture"
complete=true
