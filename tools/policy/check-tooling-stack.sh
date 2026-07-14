#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

bun tools/policy/assertions/repository-semantics.mjs tooling
bun tools/policy/check-python-entrypoints.mjs
bun tools/policy/check-rust-helper-crates.mjs
bun tools/policy/check-sdk-manifest.mjs
bun tools/policy/list-helper-reference-candidates.mjs --max-refs 0 --active-only
bun tools/policy/list-source-reference-candidates.mjs --max-refs 0
bun tools/policy/assertions/assert-moon-task-policy.mjs
bun tools/policy/check-native-boundaries.mjs

echo "tooling stack checks passed"
