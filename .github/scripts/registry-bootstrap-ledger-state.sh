#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
RELEASE_HEAD_COMMIT="$(git rev-parse --verify --end-of-options "${RELEASE_HEAD_SHA:-HEAD}^{commit}")"
export RELEASE_HEAD_COMMIT
refs="$(mktemp)"
trap 'rm -f "$refs"' EXIT
if git show-ref --tags --dereference > "$refs"; then
  :
else
  status=$?
  [[ "$status" == 1 ]] || exit "$status"
fi
bun .github/scripts/registry-bootstrap-ledger-state.mts "$refs"
