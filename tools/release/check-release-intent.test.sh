#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
objects="$(git rev-parse --path-format=absolute --git-path objects)"
mkdir "$scratch/objects"
export GIT_OBJECT_DIRECTORY="$scratch/objects"
export GIT_ALTERNATE_OBJECT_DIRECTORIES="$objects${GIT_ALTERNATE_OBJECT_DIRECTORIES:+:$GIT_ALTERNATE_OBJECT_DIRECTORIES}"
export GIT_AUTHOR_NAME='Release Intent Test' GIT_COMMITTER_NAME='Release Intent Test'
export GIT_AUTHOR_EMAIL=release-intent@example.invalid GIT_COMMITTER_EMAIL=release-intent@example.invalid
tree="$(git rev-parse 'HEAD^{tree}')"
first="$(printf 'fix: validate release intent\n' | git commit-tree "$tree" -p HEAD)"
sibling="$(printf 'fix: sibling change\n' | git commit-tree "$tree" -p HEAD)"
script=.github/scripts/check-release-intent.sh
bash "$script" 'fix: validate release intent' HEAD "$first" main workflow_dispatch refs/heads/main

reject() {
  local expected="$1"
  shift
  if bash "$script" 'fix: validate release intent' "$@" > "$scratch/rejected.log" 2>&1; then
    echo "Release intent accepted invalid comparison: $*" >&2
    exit 1
  fi
  grep -Fq "$expected" "$scratch/rejected.log"
}
reject 'base must resolve to the exact commit parent' HEAD^ "$first" main workflow_dispatch refs/heads/main
reject 'is not an ancestor' "$first" "$sibling" feature push refs/heads/feature
reject 'requires matching main branch and full ref' HEAD "$first" main workflow_dispatch refs/heads/diagnostic
echo 'Release intent exact-parent and ancestry checks passed'
