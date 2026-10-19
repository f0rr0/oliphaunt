#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
bash stage-release-artifacts.sh
bun check-package.mts
