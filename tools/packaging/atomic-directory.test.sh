#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
bun test ./tools/packaging/atomic-directory.test.mts
scratch=$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-atomic-exit-XXXXXX")
trap 'rm -rf "$scratch"' EXIT
bun tools/packaging/atomic-directory.test.mts exit-fixture "$scratch/live"
test -z "$(ls -A "$scratch")"
