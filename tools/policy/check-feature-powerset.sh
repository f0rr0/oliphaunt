#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

cargo hack check --workspace --feature-powerset --no-dev-deps --exclude-features aot-serializer,template-runner
