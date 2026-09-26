#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
OLIPHAUNT_EXTENSION_SOURCE_CHECKOUT_ROOT="$scratch/missing-checkouts" \
  bash tools/dev/bun.sh test ./src/extensions/tools/extension-upstream-licenses.test.mts \
    ./src/extensions/tools/android-extension-legal-catalog.test.mts
