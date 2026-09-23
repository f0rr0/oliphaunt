#!/usr/bin/env bash
set -euo pipefail
: "${GITHUB_SHA:?GITHUB_SHA is required}"
: "${GITHUB_REF:?GITHUB_REF is required}"
: "${RELEASE_OPERATION:?RELEASE_OPERATION is required}"
release_commit="${RELEASE_COMMIT:-}"
approval_run_id="${RELEASE_APPROVAL_RUN_ID:-}"
if [[ ! "$GITHUB_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo 'GITHUB_SHA must be a full 40-character commit SHA' >&2
  exit 2
fi
case "$RELEASE_OPERATION" in
  prepare-release-pr|publish) ;;
  *) echo "Unsupported release operation: $RELEASE_OPERATION" >&2; exit 2 ;;
esac
if [[ -n "$approval_run_id" ]]; then
  if [[ "$RELEASE_OPERATION" != publish || ! "$approval_run_id" =~ ^[1-9][0-9]*$ ]]; then
    echo 'approval_run_id is valid only for publication recovery and must be a positive integer' >&2
    exit 1
  fi
fi
if [[ -n "$release_commit" ]]; then
  if [[ ! "$release_commit" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo 'release_commit must be a full 40-character commit SHA' >&2
    exit 2
  fi
  workflow_sha="$(printf '%s' "$GITHUB_SHA" | LC_ALL=C tr '[:upper:]' '[:lower:]')"
  source_sha="$(printf '%s' "$release_commit" | LC_ALL=C tr '[:upper:]' '[:lower:]')"
  if [[ "$source_sha" != "$workflow_sha" && ( "$RELEASE_OPERATION" != publish || -z "$approval_run_id" ) ]]; then
    echo 'release_commit must equal the exact workflow SHA unless recovering a frozen approved candidate' >&2
    exit 2
  fi
fi
if [[ "$GITHUB_REF" != refs/heads/main ]]; then
  echo "release operations must execute from refs/heads/main; got: $GITHUB_REF" >&2
  exit 1
fi
