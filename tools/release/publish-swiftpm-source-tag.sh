#!/usr/bin/env bash
set -euo pipefail
tool_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
repo="$(git rev-parse --show-toplevel)"
cd "$repo"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
data() { bash "$tool_root/tools/dev/bun.sh" --cwd "$repo" "$tool_root/tools/release/publish_swiftpm_source_tag.mts" "$1" "$scratch" "${@:2}"; }
fail() { echo "$*" >&2; exit 1; }
data --prepare "$@"
[[ -f "$scratch/context.json" ]] || exit 0
export GIT_ASKPASS='' GIT_TERMINAL_PROMPT=0 SSH_ASKPASS=''
version="$(jq -r .version "$scratch/context.json")"
product="$(jq -r .product "$scratch/context.json")"
remote="$(jq -r .remote "$scratch/context.json")"
source_only="$(jq -r .projectSourceOnly "$scratch/context.json")"
ref="refs/tags/$version"
local_ref="$ref"
if [[ "$source_only" == true ]]; then local_ref="refs/oliphaunt-swiftpm/$product/$version"; fi
target="$(jq -r .target "$scratch/context.json")"
source_commit="$(git rev-parse --verify --end-of-options "$target^{commit}")"
source_tree="$(git rev-parse "$source_commit^{tree}")"
if jq -e '.source != null' "$scratch/context.json" >/dev/null; then
  [[ "$source_commit" == "$(jq -r .source.commit "$scratch/context.json")" &&
     "$source_tree" == "$(jq -r .source.tree "$scratch/context.json")" ]] || fail 'SwiftPM source commit/tree differs from the frozen lock'
fi
tag_target="$source_commit"
expected_tree="$source_tree"
if jq -e '.manifest != null' "$scratch/context.json" >/dev/null; then
  expected_tree="$(
    export GIT_INDEX_FILE="$scratch/index"
    if [[ "$source_only" == true ]]; then git read-tree --empty; else git read-tree "$source_tree"; fi
    while IFS= read -r -d '' file && IFS= read -r -d '' git_path; do
      blob="$(git hash-object -w --stdin < "$file")"
      git update-index --add --cacheinfo "100644,$blob,$git_path"
    done < "$scratch/files"
    if [[ "$source_only" == true ]]; then
      jq -n --arg product "$product" --arg version "$version" --arg commit "$source_commit" --arg tree "$source_tree" '{product:$product,version:$version,source:{commit:$commit,tree:$tree}}' > "$scratch/provenance.json"
      blob="$(git hash-object -w --stdin < "$scratch/provenance.json")"
      git update-index --add --cacheinfo "100644,$blob,oliphaunt-source.json"
    fi
    git write-tree
  )"
  timestamp="$(git show -s --format=%ct "$source_commit")"
  [[ "$timestamp" =~ ^[0-9]+$ ]] || fail 'invalid source timestamp'
  identity_path='tools/release/release-bot.json'
  identity="$(git ls-tree --name-only "$source_commit" -- "$identity_path")"
  if [[ -n "$identity" ]]; then git show "$source_commit:$identity_path" > "$scratch/identity"; else : > "$scratch/identity"; fi
  data --identity
  export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_AUTHOR_DATE GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL GIT_COMMITTER_DATE
  GIT_AUTHOR_NAME="$(jq -r .name "$scratch/identity.json")"
  GIT_AUTHOR_EMAIL="$(jq -r .email "$scratch/identity.json")"
  GIT_AUTHOR_DATE="$timestamp +0000"
  GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
  GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
  GIT_COMMITTER_DATE="$GIT_AUTHOR_DATE"
  parents=(-p "$source_commit")
  commit_message="Release Oliphaunt Swift $version SwiftPM manifest"
  if [[ "$source_only" == true ]]; then parents=(); commit_message="Release $product $version SwiftPM source"; fi
  tag_target="$(git commit-tree "$expected_tree" "${parents[@]}" -m "$commit_message")"
fi
if jq -e '.preflight or .push' "$scratch/context.json" >/dev/null; then
  transport_timeout="$(command -v timeout || command -v gtimeout)" || fail 'GNU timeout is required for bounded Git transport'
fi
if jq -e .preflight "$scratch/context.json" >/dev/null; then
  "$transport_timeout" --kill-after=5s 60s git ls-remote --refs --tags "$remote" "$ref" > "$scratch/remote"
  data --remote "$tag_target"
  exit 0
fi
if existing="$(git rev-parse --verify --quiet "$local_ref^{commit}")"; then
  if jq -e '.manifest != null' "$scratch/context.json" >/dev/null; then
    expected_parent="$source_commit"
    if [[ "$source_only" == true ]]; then expected_parent=''; fi
    [[ "$(git show -s --format=%P "$existing")" == "$expected_parent" &&
       "$(git rev-parse "$existing^{tree}")" == "$expected_tree" ]] || fail 'existing SwiftPM tag has a different source or release tree'
    tag_target="$existing"
  else
    [[ "$existing" == "$tag_target" ]] || fail 'existing SwiftPM tag has a different source'
  fi
else
  if [[ "$source_only" == true ]]; then git update-ref "$local_ref" "$tag_target" ''; else git tag "$version" "$tag_target"; fi
fi
if jq -e .push "$scratch/context.json" >/dev/null; then
  data --admit
  push_status=0
  "$transport_timeout" --kill-after=5s 60s git push --porcelain "$remote" "$local_ref:$ref" || push_status=$?
  data --reconcile-ready
  "$transport_timeout" --kill-after=5s 60s git ls-remote --refs --tags "$remote" "$ref" > "$scratch/remote"
  data --remote "$tag_target"
  if [[ "$push_status" != 0 ]]; then echo 'SwiftPM push failure reconciled to the exact remote tag'; fi
fi
