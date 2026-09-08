#!/usr/bin/env bash
set -euo pipefail
sha="${RELEASE_ARTIFACT_SHA:-${RELEASE_HEAD_SHA:-${GITHUB_SHA:-}}}"
: "${sha:?RELEASE_ARTIFACT_SHA, RELEASE_HEAD_SHA, or GITHUB_SHA is required}"
args=(--sha "$sha" --required-job Builds --all-targets)
[ -z "${CI_RUN_ID:-}" ] || args+=(--run-id "$CI_RUN_ID")
exec bash src/runtimes/liboliphaunt/wasix/tools/download-assets.sh "${args[@]}"
