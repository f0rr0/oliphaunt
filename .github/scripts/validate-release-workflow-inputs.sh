#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_SHA:?GITHUB_SHA is required}"
: "${GITHUB_REF:?GITHUB_REF is required}"
: "${RELEASE_OPERATION:?RELEASE_OPERATION is required}"

release_commit="${RELEASE_COMMIT:-}"
continuation_pointer="${RELEASE_CONTINUATION_POINTER:-}"

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

if (( ${#continuation_pointer} > 32768 )); then
  echo "continuation_pointer exceeds the 32 KiB transport bound" >&2
  exit 1
fi
if [[ -n "${continuation_pointer}" ]]; then
  if [[ "${RELEASE_OPERATION}" != "publish" && "${RELEASE_OPERATION}" != "publish-bootstrap" ]]; then
    echo "continuation_pointer is not valid for ${RELEASE_OPERATION}" >&2
    exit 1
  fi
  if [[ -z "${release_commit}" ]]; then
    echo "automatic continuation requires release_commit to equal the exact workflow SHA" >&2
    exit 1
  fi
  expected_ref="refs/tags/oliphaunt-release-transport/${normalized_github_sha}"
  if [[ "${GITHUB_REF}" != "${expected_ref}" ]]; then
    echo "automatic continuation must execute from its exact immutable transport ref" >&2
    echo "expected ref: ${expected_ref}" >&2
    echo "workflow ref: ${GITHUB_REF}" >&2
    exit 1
  fi
elif [[ "${GITHUB_REF}" != "refs/heads/main" ]]; then
  echo "root release operations must execute from refs/heads/main; got: ${GITHUB_REF}" >&2
  exit 1
fi
