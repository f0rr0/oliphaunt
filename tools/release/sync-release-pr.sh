#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
OLIPHAUNT_EVIDENCE_COMMIT="$(git rev-parse 'HEAD^{commit}')"
OLIPHAUNT_EVIDENCE_TREE="$(git rev-parse 'HEAD^{tree}')"
export OLIPHAUNT_EVIDENCE_COMMIT OLIPHAUNT_EVIDENCE_TREE
bash tools/ci/with-projects.sh --exec bash tools/release/release-please-state.sh "$PWD" HEAD \
  bash tools/dev/bun.sh tools/release/sync-release-pr.mts "$@"

# Bun owns its lock format and workspace dependency resolution.
for argument in "$@"; do
  if [[ "$argument" == "--check" || "$argument" == "--check-generated-release" ]]; then
    test -f bun.lock
    exec bash tools/dev/bun.sh install --frozen-lockfile --dry-run --ignore-scripts
  fi
done
exec bash tools/dev/bun.sh install --lockfile-only --ignore-scripts
