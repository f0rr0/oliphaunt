#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${BUILD_DIR:-$ROOT/work/docker-pglite}"

# PG18 server-core promotion starts without PG17 contrib extension promotion.
# Core plpgsql/snowball are still built and packaged. docker_wasix_env.sh
# remains the pinned toolchain entrypoint for the follow-up extension rebuild.
if [ ! -f "$BUILD_DIR/.pglite-oxide-runtime-kind" ]; then
  "$ROOT/docker_pglite.sh"
fi

if [ "$(cat "$BUILD_DIR/.pglite-oxide-runtime-kind")" = "wasix-postgres-server" ]; then
  echo "skipping contrib extension build for PG18 WASIX server-core lane"
  exit 0
fi

echo "unsupported non-PG18 runtime kind in $BUILD_DIR" >&2
exit 2
