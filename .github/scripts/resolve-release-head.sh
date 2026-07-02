#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_SHA:?GITHUB_SHA is required}"
: "${GITHUB_REF:?GITHUB_REF is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${GITHUB_ENV:?GITHUB_ENV is required}"

input="${INPUT_RELEASE_COMMIT:-}"
workflow_sha="$(git rev-parse "${GITHUB_SHA}^{commit}")"

if [[ -z "$input" ]]; then
  release_sha="$workflow_sha"
else
  if [[ ! "$input" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "release_commit must be a full 40-character commit SHA, got: $input" >&2
    exit 2
  fi
  release_sha="$(git rev-parse "${input}^{commit}")"
  release_sha_lower="$(printf '%s' "$release_sha" | tr '[:upper:]' '[:lower:]')"
  input_lower="$(printf '%s' "$input" | tr '[:upper:]' '[:lower:]')"
  if [[ "$release_sha_lower" != "$input_lower" ]]; then
    echo "release_commit resolved to $release_sha, not $input" >&2
    exit 2
  fi
fi

if [[ "$GITHUB_REF" != "refs/heads/main" ]]; then
  echo "Releases must be run from main; got $GITHUB_REF" >&2
  exit 2
fi

uses_temporary_target_branch=false
target_branch="main"
if [[ "$release_sha" != "$workflow_sha" ]]; then
  if ! git merge-base --is-ancestor "$release_sha" "$workflow_sha"; then
    echo "release_commit $release_sha must be an ancestor of workflow commit $workflow_sha" >&2
    exit 2
  fi

  disallowed=()
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    case "$path" in
      .github/actions/*|.github/scripts/*|.github/workflows/*|tools/dev/*|tools/policy/*|tools/release/*|tools/xtask/*|docs/maintainers/release-setup.md)
        ;;
      *)
        disallowed+=("$path")
        ;;
    esac
  done < <(git diff --name-only "$release_sha" "$workflow_sha" --)

  if [[ "${#disallowed[@]}" -gt 0 ]]; then
    echo "release_commit can lag the workflow commit only across release-tooling changes." >&2
    echo "These intervening paths are not release tooling:" >&2
    printf '  %s\n' "${disallowed[@]}" >&2
    exit 2
  fi

  uses_temporary_target_branch=true
  target_branch="release-target/${release_sha:0:12}-${GITHUB_RUN_ID}"
fi

{
  echo "sha=$release_sha"
  echo "workflow_sha=$workflow_sha"
  echo "target_branch=$target_branch"
  echo "uses_temporary_target_branch=$uses_temporary_target_branch"
} >> "$GITHUB_OUTPUT"
echo "RELEASE_HEAD_SHA=$release_sha" >> "$GITHUB_ENV"

echo "workflow commit: $workflow_sha"
echo "release commit:  $release_sha"
echo "release-please target branch: $target_branch"
