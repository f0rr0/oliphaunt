#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != --publication ]; }; then
  echo 'usage: release-metadata-check.sh [--publication]' >&2
  exit 2
fi
for check in check_release_please_config check_artifact_targets; do
  bash tools/dev/bun.sh "tools/release/$check.mts"
done
if [ "${1:-}" = --publication ]; then
  bash tools/release/release-please-state.sh "$PWD" HEAD bash tools/release/with-release-history.sh "$PWD" HEAD bash tools/release/with-product-history.sh "$PWD" HEAD '' @workspace bash tools/dev/bun.sh tools/release/check-release-metadata.mts --publication
else
  bash tools/dev/bun.sh tools/release/check-release-metadata.mts
fi
bash tools/release/sync-release-pr.sh --check
