#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bun test ./tools/release/github-read.test.mts
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
printf '%s\n' 'globalThis.fetch = async () => Response.json([{id: 42}]);' > "$scratch/fetch.mts"
env -i PATH="$PATH" HOME="$HOME" bun --preload "$scratch/fetch.mts" \
  tools/release/github-read.mts -- repos/f0rr0/oliphaunt/actions/runs/42 > "$scratch/result"
[[ "$(cat "$scratch/result")" == '[{"id":42}]' ]]
echo 'GitHub read CLI: isolated Bun transport passed'
