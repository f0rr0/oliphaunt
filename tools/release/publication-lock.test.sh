#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ "${1:-}" != --context ]]; then
  exec bash tools/release/release-please-state.sh "$PWD" HEAD \
    bash tools/release/with-source.sh HEAD bash tools/ci/with-projects.sh --exec \
    bash tools/release/publication-lock.test.sh --context
fi
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
bun test ./tools/release/publication-lock.test.mts
bun tools/release/publication-lock.test.mts prepare-handoff "$scratch"
bun tools/release/publication-lock.mts verify --lock "$scratch/publication-lock.json" --head-ref HEAD
for ref in HEAD HEAD^; do
  bash tools/release/with-source.sh "$ref" bun tools/release/publication-lock.test.mts assert-source
done
echo 'Publication lock verifies after payload handoff and binds actual Git source snapshots'
