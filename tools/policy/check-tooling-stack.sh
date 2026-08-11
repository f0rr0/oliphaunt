#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

bun tools/policy/assertions/repository-semantics.mjs tooling
bun tools/policy/check-rust-helper-crates.mjs

echo "tooling stack checks passed"
