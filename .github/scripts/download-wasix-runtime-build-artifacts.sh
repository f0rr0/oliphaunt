#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"

# Installs the portable and AOT WASIX runtime outputs from the selected same-SHA
# CI workflow whose artifact builder gate passed. This is a release artifact
# handoff, not a release-time runtime rebuild.
if [[ -n "${CI_RUN_ID:-}" ]]; then
  cargo run -p xtask -- assets download --run-id "$CI_RUN_ID" --required-job builds --all-targets
else
  cargo run -p xtask -- assets download --sha "$GITHUB_SHA" --required-job builds --all-targets
fi
