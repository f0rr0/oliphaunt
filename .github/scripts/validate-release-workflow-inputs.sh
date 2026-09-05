#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_SHA:?GITHUB_SHA is required}"
: "${GITHUB_REF:?GITHUB_REF is required}"
: "${RELEASE_OPERATION:?RELEASE_OPERATION is required}"

release_commit="${RELEASE_COMMIT:-}"
approval_run_id="${RELEASE_APPROVAL_RUN_ID:-}"

if [[ ! "${GITHUB_SHA}" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "GITHUB_SHA must be a full 40-character commit SHA, got: ${GITHUB_SHA}" >&2
  exit 2
fi
normalized_github_sha="$(printf '%s' "${GITHUB_SHA}" | LC_ALL=C tr '[:upper:]' '[:lower:]')"

case "${RELEASE_OPERATION}" in
  prepare-release-pr|publish-dry-run|publish-bootstrap|publish) ;;
  *)
    echo "Unsupported release operation: ${RELEASE_OPERATION}" >&2
    exit 2
    ;;
esac

# release_commit is an assertion about this workflow run, never a selector for
# historical code. Validate it before operation-specific jobs are evaluated so
# every operation, including prepare-release-pr, fails closed on a stale input.
if [[ -n "${release_commit}" ]]; then
  if [[ ! "${release_commit}" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "release_commit must be a full 40-character commit SHA, got: ${release_commit}" >&2
    exit 2
  fi
  normalized_release_commit="$(printf '%s' "${release_commit}" | LC_ALL=C tr '[:upper:]' '[:lower:]')"
  if [[ "${normalized_release_commit}" != "${normalized_github_sha}" ]]; then
    echo "release_commit must equal the exact workflow SHA" >&2
    echo "workflow commit: ${GITHUB_SHA}" >&2
    echo "release commit:  ${release_commit}" >&2
    exit 2
  fi
fi

if [[ "${RELEASE_OPERATION}" == "publish" || "${RELEASE_OPERATION}" == "publish-bootstrap" ]]; then
  if [[ ! "${approval_run_id}" =~ ^[1-9][0-9]*$ ]]; then
    echo "${RELEASE_OPERATION} requires approval_run_id from the exact successful publish-dry-run" >&2
    exit 1
  fi
elif [[ -n "${approval_run_id}" ]]; then
  echo "approval_run_id is not valid for ${RELEASE_OPERATION}" >&2
  exit 1
fi

if [[ "${GITHUB_REF}" != "refs/heads/main" ]]; then
  echo "release operations must execute from refs/heads/main; got: ${GITHUB_REF}" >&2
  exit 1
fi
