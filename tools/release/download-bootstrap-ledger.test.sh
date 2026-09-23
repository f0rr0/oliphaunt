#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
root="$PWD"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
bun tools/release/download-bootstrap-ledger.test.mts prepare "$scratch"
for directory in "$scratch"/*; do
  environment=()
  while IFS= read -r -d '' assignment; do environment+=("$assignment"); done < "$directory/environment"
  status=0
  env -i PATH="$PATH" BUN_OPTIONS="--preload=$root/tools/release/testdata/bootstrap-ledger-github.mts" \
    "${environment[@]}" bun .github/scripts/download-bootstrap-ledger.mts > "$directory/result" 2>&1 || status=$?
  printf '%s\n' "$status" > "$directory/status"
done
OLIPHAUNT_LEDGER_TEST_ROOT="$scratch" bun test ./tools/release/download-bootstrap-ledger.test.mts
