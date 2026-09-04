#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "verify-committed-assets.sh: must run inside the Oliphaunt checkout" >&2
  exit 1
}
cd "$root"

if [ "${CI:-}" = "true" ]; then
  cargo run -p xtask -- assets fetch
fi
src/runtimes/liboliphaunt/wasix/assets/build/prepare_postgres_source.sh >/dev/null
cargo run -p xtask -- assets verify-committed
