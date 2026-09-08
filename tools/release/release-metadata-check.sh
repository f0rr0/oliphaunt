#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if [ "$#" -gt 0 ]; then
  echo 'usage: release-metadata-check.sh' >&2
  exit 2
fi
for check in check_release_please_config check_artifact_targets; do
  bash tools/dev/bun.sh "tools/release/$check.mts"
done
bash tools/release/release-please-state.sh "$PWD" HEAD '' bash tools/release/with-release-history.sh "$PWD" HEAD bash src/shared/product-metadata/with-product-history.sh "$PWD" HEAD '' @workspace bash tools/dev/bun.sh tools/release/check-release-metadata.mts
bash tools/release/check-release-pr.sh
bash tools/release/sync-release-pr.sh --check
bash tools/dev/bun.sh tools/release/example-cargo-policy.mts --check
