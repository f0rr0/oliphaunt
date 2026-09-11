#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
if [[ $# != 2 || "$1" != --products-json ]]; then
  echo 'usage: package-release-carriers.sh --products-json JSON' >&2
  exit 2
fi
bash tools/ci/with-projects.sh tools/release/package-release-carriers.mts "$@"
