#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$root"

host="$(rustc -vV | awk '/^host:/{print $2}')"
if [ -f "target/pglite-oxide/assets/manifest.json" ] &&
  { [ -f "target/pglite-oxide/aot/$host/manifest.json" ] ||
    [ -f "crates/aot/$host/artifacts/manifest.json" ]; }; then
  exec scripts/validate.sh runtime
fi

cat >&2 <<MSG
host runtime artifacts are not installed for $host; skipping pre-push runtime tests.

Install or build them with one of:
  cargo run -p xtask -- assets fetch && cargo run -p xtask --features aot-serializer -- assets build-host
  cargo run -p xtask -- assets download --latest-compatible --target-triple $host
MSG
