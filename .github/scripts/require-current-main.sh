#!/usr/bin/env bash
set -euo pipefail

expected_sha="${1:-${GITHUB_SHA:-}}"

if [[ -z "$expected_sha" ]]; then
  echo "usage: require-current-main.sh <full-commit-sha>" >&2
  exit 2
fi
if [[ ! "$expected_sha" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "expected a full 40-character commit SHA, got: $expected_sha" >&2
  exit 2
fi
if [[ "${GITHUB_REF:-}" != "refs/heads/main" ]]; then
  echo "release operations must be dispatched from main; got ${GITHUB_REF:-<unset>}" >&2
  exit 2
fi

expected_sha="$(git rev-parse "${expected_sha}^{commit}")"
git fetch --no-tags origin "+refs/heads/main:refs/remotes/origin/main"
remote_main_sha="$(git rev-parse "refs/remotes/origin/main^{commit}")"

if [[ "$expected_sha" != "$remote_main_sha" ]]; then
  echo "main moved after this workflow was dispatched." >&2
  echo "workflow commit: $expected_sha" >&2
  echo "current main:    $remote_main_sha" >&2
  echo "dispatch a new release workflow for the current main commit." >&2
  exit 1
fi

echo "validated current main commit: $expected_sha"
