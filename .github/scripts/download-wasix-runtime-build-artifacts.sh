#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
release_sha="${RELEASE_HEAD_SHA:-${GITHUB_SHA:-}}"
if [[ -z "$release_sha" ]]; then
  echo "RELEASE_HEAD_SHA or GITHUB_SHA is required" >&2
  exit 2
fi

# Installs the portable and AOT WASIX runtime outputs from the selected release
# CI workflow whose artifact builder gate passed. This is a release artifact
# handoff, not a release-time runtime rebuild.
if [[ -n "${CI_RUN_ID:-}" ]]; then
  cargo run -p xtask -- assets download --run-id "$CI_RUN_ID" --required-job Builds --all-targets
else
  cargo run -p xtask -- assets download --sha "$release_sha" --required-job Builds --all-targets
fi
