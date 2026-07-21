#!/usr/bin/env sh
set -eu

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

# Extension availability, carrier identity, platform support, and every
# generated SDK catalog are derived from the extension model. SDK package and
# installed-app behavior remains owned by each product's Moon tasks.
tools/dev/bun.sh src/extensions/tools/check-extension-model.mjs --check

printf '\nSDK mobile extension model checks passed.\n'
