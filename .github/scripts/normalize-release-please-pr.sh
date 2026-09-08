#!/usr/bin/env bash
set -euo pipefail
fail() { echo "normalize-release-please-pr.sh: $*" >&2; exit 1; }
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
bun "$script_dir/release-pr-identity.mts" "$@" > "$scratch/identity"
{
  IFS= read -r -d '' command
  IFS= read -r -d '' remote
  IFS= read -r -d '' main_sha
  IFS= read -r -d '' head_sha
  IFS= read -r -d '' pr_number
  IFS= read -r -d '' title
  IFS= read -r -d '' bot_name
  IFS= read -r -d '' bot_email
} < "$scratch/identity"
branch=release-please--branches--main

require_clean() {
  local status
  status="$(git status --porcelain --untracked-files=all)"
  [ -z "$status" ] || fail "working tree must be clean before release PR normalization or push: $status"
}
require_commit() {
  local actual
  actual="$(git rev-parse --verify "$1^{commit}")"
  [ "$actual" = "$2" ] || fail "$3 is $actual, expected $2"
}
release_range_shape() {
  local base="$1" head="$2" merges subject subjects=0 main_tree
  git merge-base --is-ancestor "$base" "$head" || fail "release PR head is not descended from exact main $base"
  shape_count="$(git rev-list --count "$base..$head")"
  [[ "$shape_count" =~ ^[1-9][0-9]*$ ]] || fail 'release PR must contain at least one commit above exact main'
  merges="$(git rev-list --merges "$base..$head")"
  [ -z "$merges" ] || fail 'release PR history must be linear and contain no merge commits'
  git log -z --format=%s "$base..$head" > "$scratch/subjects"
  while IFS= read -r -d '' subject; do
    [ "$subject" = "$title" ] || fail "every generated release PR chunk must use exact title $title"
    subjects=$((subjects + 1))
  done < "$scratch/subjects"
  [ "$subjects" = "$shape_count" ] || fail 'release PR commit subjects are incomplete'
  main_tree="$(git rev-parse "$base^{tree}")"
  shape_tree="$(git rev-parse "$head^{tree}")"
  [ "$main_tree" != "$shape_tree" ] || fail 'release PR tree must differ from exact main'
}
remote_ref_sha() {
  local ref="$1" observed_ref extra
  git ls-remote --heads "$remote" "$ref" > "$scratch/remote-ref"
  [ "$(wc -l < "$scratch/remote-ref" | tr -d '[:space:]')" = 1 ] || fail "expected exactly one remote ref $ref"
  read -r observed_sha observed_ref extra < "$scratch/remote-ref"
  [[ "$observed_sha" =~ ^[0-9a-f]{40}$ && "$observed_ref" = "$ref" && -z "$extra" ]] || fail "remote ref $ref returned malformed metadata"
}

require_clean
if [ "$command" = normalize ]; then
  main_remote_ref="refs/remotes/$remote/main"
  head_remote_ref="refs/remotes/$remote/$branch"
  git fetch --no-tags "$remote" "+refs/heads/main:$main_remote_ref" "+refs/heads/$branch:$head_remote_ref"
  require_commit "$main_remote_ref" "$main_sha" 'current remote main'
  require_commit "$head_remote_ref" "$head_sha" 'inspected release PR head'
  base_sha="$(git merge-base "$main_sha" "$head_remote_ref")" || fail 'release PR head does not share canonical main history'
  [[ "$base_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'release PR head does not share canonical main history'
  release_range_shape "$base_sha" "$head_remote_ref"
  git switch -C "$branch" "$head_remote_ref"
  normalized=false
  if [ "$base_sha" != "$main_sha" ]; then
    git -c "user.name=$bot_name" -c "user.email=$bot_email" rebase --onto "$main_sha" "$base_sha"
    normalized=true
  fi
  generated_tree="$(git rev-parse 'HEAD^{tree}')"
  direct_parent="$(git rev-parse 'HEAD^')"
  count="$(git rev-list --count "$main_sha..HEAD")"
  if [ "$count" != 1 ] || [ "$direct_parent" != "$main_sha" ]; then
    git reset --soft "$main_sha"
    if git diff --cached --quiet --exit-code; then
      fail 'release PR normalization produced no staged tree change'
    else
      status="$?"
      [ "$status" = 1 ] || exit "$status"
    fi
    git -c "user.name=$bot_name" -c "user.email=$bot_email" commit -m "$title"
    normalized=true
  fi
  release_range_shape "$main_sha" HEAD
  [ "$shape_count" = 1 ] || fail 'normalized release PR must be exactly one commit above exact main'
  require_commit 'HEAD^' "$main_sha" 'normalized release PR parent'
  [ "$shape_tree" = "$generated_tree" ] || fail 'normalization changed the generated release PR tree'
  require_clean
  local_head="$(git rev-parse HEAD)"
  echo "release PR #$pr_number checked out at $local_head; normalized=$normalized"
else
  local_branch="$(git branch --show-current)"
  [ "$local_branch" = "$branch" ] || fail "local branch must be $branch, got $local_branch"
  release_range_shape "$main_sha" HEAD
  [ "$shape_count" = 1 ] || fail 'release PR push requires exactly one local commit above exact main'
  require_commit 'HEAD^' "$main_sha" 'release PR parent'
  remote_ref_sha refs/heads/main
  [ "$observed_sha" = "$main_sha" ] || fail "main moved before release PR push: $observed_sha, expected $main_sha"
  local_head="$(git rev-parse HEAD)"
  git push "--force-with-lease=refs/heads/$branch:$head_sha" "$remote" "HEAD:refs/heads/$branch" || fail 'failed to push release PR'
  remote_ref_sha "refs/heads/$branch"
  [ "$observed_sha" = "$local_head" ] || fail "release PR push produced $observed_sha, expected $local_head"
  echo "release PR #$pr_number pushed as one exact release commit $local_head"
fi
