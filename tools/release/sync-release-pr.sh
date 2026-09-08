#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
OLIPHAUNT_EVIDENCE_COMMIT="$(git rev-parse 'HEAD^{commit}')"
OLIPHAUNT_EVIDENCE_TREE="$(git rev-parse 'HEAD^{tree}')"
export OLIPHAUNT_EVIDENCE_COMMIT OLIPHAUNT_EVIDENCE_TREE
exec bash tools/graph/with-projects.sh --exec bash tools/release/release-please-state.sh "$PWD" @sync @workspace \
  bash tools/dev/bun.sh tools/release/sync-release-pr.mts "$@"
