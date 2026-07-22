#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_SHA:?GITHUB_SHA is required}"
: "${GITHUB_REF:?GITHUB_REF is required}"
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

if [[ "$release_sha" != "$workflow_sha" ]]; then
  echo "release_commit must equal the workflow commit exactly." >&2
  echo "workflow commit: $workflow_sha" >&2
  echo "release commit:  $release_sha" >&2
  echo "Tooling-lag publication is intentionally unsupported; dispatch from the exact release commit." >&2
  exit 2
fi

{
  echo "sha=$release_sha"
  echo "workflow_sha=$workflow_sha"
} >> "$GITHUB_OUTPUT"
echo "RELEASE_HEAD_SHA=$release_sha" >> "$GITHUB_ENV"

echo "workflow commit: $workflow_sha"
echo "release commit:  $release_sha"
