#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
if [ "${1:-}" != --context ]; then
  for name in "${!GITHUB_@}" "${!GH_@}" "${!ACTIONS_@}" "${!OLIPHAUNT_GITHUB_@}" "${!OLIPHAUNT_RELEASE_@}" "${!RELEASE_@}"; do
    [ -z "$name" ] || unset "$name"
  done
  unset CI_RUN_ID BOOTSTRAP_LEDGER_PATH OLIPHAUNT_REQUIRE_GITHUB_CORE_REQUEST_JOURNAL
  exec bash tools/release/release-please-state.sh "$PWD" HEAD \
    bash tools/release/with-source.sh HEAD bash tools/ci/with-projects.sh --exec \
    bash tools/release/bootstrap-publication-capsule.test.sh --context
fi
bun test --timeout=30000 ./tools/release/bootstrap-publication-capsule.test.mts
scratch=$(bun tools/release/bootstrap-publication-capsule.test.mts prepare)
trap 'rm -rf "$scratch"' EXIT
export BUN_OPTIONS="--preload $scratch/registry-fixture.mts"
export PRODUCTS_JSON='["oliphaunt-rust","oliphaunt-js"]'
RELEASE_HEAD_SHA=$(git rev-parse HEAD)
export RELEASE_HEAD_SHA
export PUBLICATION_LOCK_PATH="$scratch/publication-lock.json" BOOTSTRAP_LEDGER_PATH="$scratch/ledger"
export REGISTRY_MUTATION_DEADLINE_EPOCH="$(($(date +%s) + 60))"
export REGISTRY_JOB_HARD_DEADLINE_EPOCH="$(($(date +%s) + 600))"
export CARGO_REGISTRY_TOKEN=fixture-not-a-credential NPM_CONFIG_USERCONFIG="$scratch/npmrc"
export OLIPHAUNT_BOOTSTRAP_EXECUTION_RESULT="$scratch/execution.json"
bash .github/scripts/bootstrap-registry-identities.sh
bun tools/release/bootstrap-publication-capsule.test.mts verify "$scratch"
