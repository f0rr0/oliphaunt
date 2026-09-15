#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
bash tools/release/with-release-tags.sh bash tools/dev/bun.sh tools/release/check_github_release_assets.mts "$@"
