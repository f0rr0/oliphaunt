#!/usr/bin/env sh
set -eu

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

run() {
  printf '\n==> %s\n' "$*"
  "$@"
}

# This is a local convenience aggregate. Stable CI owns the same checks as
# direct Moon task dependencies under sdk-contracts:check.
run node tools/policy/generate-sdk-api-surface.mjs --check
run node tools/policy/check-sdk-doc-examples.mjs
run tools/dev/bun.sh tools/policy/check-sdk-manifest.mjs
run tools/policy/check-native-boundaries.sh
run tools/dev/bun.sh tools/policy/check-sdk-header-copies.mjs
run tools/policy/check-sdk-mobile-extension-surface.sh

printf '\nSDK executable contract checks passed.\n'
