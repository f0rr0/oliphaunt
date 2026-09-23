#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bun test ./tools/release/npm-trusted-publishing.test.mts
output="$(mktemp)"
trap 'rm -f "$output"' EXIT
# This bootstrap/runtime probe intentionally runs with Node: npm uses Node before Bun setup.
node tools/release/npm-trusted-publishing-runtime.mts check-runtime --node v22.22.3 --npm 11.18.0 > "$output"
rg -q 'npm trusted-publishing runtime passed' "$output"
if node tools/release/npm-trusted-publishing-runtime.mts check-runtime --node v22.13.0 --npm 11.18.0 > "$output" 2>&1; then
  echo 'Unsupported npm host accepted' >&2; exit 1
fi
rg -q 'Node.js v22.13.0 is too old' "$output"
echo 'npm bootstrap probe: real Node execution accepts and rejects runtime bounds'
