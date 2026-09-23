#!/usr/bin/env bash
set -euo pipefail
verifier="$(git rev-parse --show-toplevel)/tools/release/qualified-release-replay.sh"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
prepare() {
  mkdir "$scratch/$1"
  cd "$scratch/$1"
  git init --quiet
  git config user.name Fixture
  git config user.email fixture@example.invalid
  printf 'clean\n' > tracked.txt
  git add tracked.txt
  git commit --quiet -m fixture
  sha="$(git rev-parse HEAD)"
}
reject() {
  local message="$1"; shift
  if bash "$verifier" "$@" > "$scratch/result" 2>&1; then echo 'Unqualified source accepted' >&2; exit 1; fi
  rg -i -q "$message" "$scratch/result"
}
prepare clean
bash "$verifier" HEAD "$sha"
reject 'head mismatch' HEAD 0000000000000000000000000000000000000000
reject 'exact 40-character' HEAD abc
for mode in tracked staged untracked newline; do
  prepare "$mode"
  case "$mode" in
    tracked) printf 'modified\n' > tracked.txt ;;
    staged) printf 'staged\n' > tracked.txt; git add tracked.txt ;;
    untracked) printf 'untracked\n' > untracked.txt ;;
    newline) printf 'untracked\n' > $'untracked\nrecord.txt' ;;
  esac
  reject 'clean source checkout' HEAD "$sha"
  if [[ "$mode" == newline ]]; then rg -U -q $'untracked\nrecord.txt' "$scratch/result"; fi
done
prepare moved-head
printf 'second commit\n' > tracked.txt
git add tracked.txt
git commit --quiet -m next
reject 'checkout HEAD mismatch' "$sha" "$sha"
for flag in assume-unchanged skip-worktree; do
  prepare "$flag"
  git update-index "--$flag" tracked.txt
  printf '%s\n' "$flag" > tracked.txt
  [[ -z "$(git status --porcelain=v1 --untracked-files=all)" ]]
  reject 'index suppression flags' HEAD "$sha"
done
echo 'Qualified replay: exact clean commit, dirty records and index suppression checks passed'
