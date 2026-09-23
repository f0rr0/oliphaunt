#!/usr/bin/env bash
set -euo pipefail
fail() {
  echo "publish-release-pr.sh: $*" >&2
  exit 1
}
[[ $# == 1 ]] || fail 'expected candidate metadata directory'
metadata="$1"
branch=release-please--branches--main
source_sha="${GITHUB_SHA:?exact workflow source is required}"
[[ "${GITHUB_REPOSITORY:-}" == f0rr0/oliphaunt ]] || fail 'canonical repository is required'
[[ "$(cat "$metadata/required")" == true ]] || exit 0
title="$(cat "$metadata/title")"
[[ "$title" == 'chore(release): prepare main releases' ]] || fail 'unexpected release title'
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || fail 'candidate checkout is dirty'
[[ "$(git rev-parse HEAD^)" == "$source_sha" ]] || fail 'candidate parent is not the exact workflow source'
bash .github/scripts/require-current-main.sh "$source_sha"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
gh auth setup-git
gh pr list --base main --head "$branch" --state open --json number,headRefOid,headRepository,isCrossRepository,title,labels >"$scratch/pr.json"
count="$(jq length "$scratch/pr.json")"
[[ "$count" == 0 || "$count" == 1 ]] || fail 'ambiguous generated release PR'
if [[ "$count" == 1 ]]; then
  jq -e --arg title "$title" --arg repo "$GITHUB_REPOSITORY" '.[0] | .title == $title and .headRepository.nameWithOwner == $repo and .isCrossRepository == false and any(.labels[]; .name == "autorelease: pending")' "$scratch/pr.json" >/dev/null || fail 'existing PR is not the canonical generated candidate'
fi
git ls-remote --heads origin "refs/heads/$branch" >"$scratch/remote"
old_sha=''
if [[ -s "$scratch/remote" ]]; then
  [[ "$(wc -l <"$scratch/remote" | tr -d '[:space:]')" == 1 ]] || fail 'ambiguous generated branch'
  read -r old_sha _ <"$scratch/remote"
  [[ "$old_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'invalid remote branch SHA'
  git fetch --no-tags origin "$old_sha"
  base="$(git merge-base "$source_sha" "$old_sha")"
  [[ -z "$(git rev-list --merges "$base..$old_sha")" ]] || fail 'generated branch contains merge commits'
  git log --format=%s "$base..$old_sha" >"$scratch/subjects"
  while IFS= read -r subject; do [[ "$subject" == "$title" ]] || fail 'generated branch contains unrelated commits'; done <"$scratch/subjects"
fi
if [[ "$count" == 1 ]]; then
  [[ "$(jq -r '.[0].headRefOid' "$scratch/pr.json")" == "$old_sha" ]] || fail 'PR head changed during preparation'
fi
unchanged=false
if [[ -n "$old_sha" && "$(git rev-parse "$old_sha^{tree}")" == "$(git rev-parse 'HEAD^{tree}')" && "$(git rev-parse "$old_sha^")" == "$source_sha" ]]; then
  unchanged=true
  expected_sha="$old_sha"
else
  bash .github/scripts/require-current-main.sh "$source_sha"
  git push "--force-with-lease=refs/heads/$branch:$old_sha" origin "HEAD:refs/heads/$branch"
  expected_sha="$(git rev-parse HEAD)"
fi
bash .github/scripts/require-current-main.sh "$source_sha"
git ls-remote --heads origin "refs/heads/$branch" > "$scratch/published"
[[ "$(wc -l < "$scratch/published" | tr -d '[:space:]')" == 1 ]] || fail 'published branch is missing or ambiguous'
read -r published_sha _ < "$scratch/published"
[[ "$published_sha" == "$expected_sha" ]] || fail 'published branch changed before PR reconciliation'
if [[ "$count" == 0 ]]; then
  gh pr create --base main --head "$branch" --title "$title" --label 'autorelease: pending' --body-file "$metadata/body.md"
else
  number="$(jq -r '.[0].number' "$scratch/pr.json")"
  gh pr edit "$number" --title "$title" --body-file "$metadata/body.md"
fi
echo "Release PR prepared; unchanged candidate tree=$unchanged"
