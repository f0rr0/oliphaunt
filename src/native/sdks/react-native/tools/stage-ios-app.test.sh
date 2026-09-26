#!/usr/bin/env bash
set -euo pipefail
tools="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
OLIPHAUNT_TEST_IOS_STAGE_ROOT="$scratch" bun "$tools/stage-ios-app.test.mts"
bun "$tools/verify-ios-package.mts" --payload-dir "$scratch/consumer/ios/oliphaunt"
if bun "$tools/verify-ios-package.mts" --payload-dir "$scratch/tampered-legal-notice-output" > "$scratch/cli.log" 2>&1; then
  echo 'tampered legal notice unexpectedly verified' >&2
  exit 1
fi
grep -q 'does not exactly index the frozen legal selection' "$scratch/cli.log"
