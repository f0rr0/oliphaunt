#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

bun tools/policy/assertions/repository-semantics.mjs structure
tools/dev/bun.sh test tools/policy/assertions/assert-ambient-js-tools.test.mjs
bun tools/policy/assertions/assert-ambient-js-tools.mjs
tools/dev/bun.sh test tools/policy/assertions/assert-ordinal-release-ordering.test.mjs
bun tools/policy/assertions/assert-ordinal-release-ordering.mjs

echo "repository structure checks passed"
