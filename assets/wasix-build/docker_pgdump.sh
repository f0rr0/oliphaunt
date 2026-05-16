#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${BUILD_DIR:-$ROOT/work/docker-pglite}"

# PG18 server-core pg_dump is built by docker_pglite.sh with the pinned
# docker_wasix_env.sh toolchain and upstream PostgreSQL libpq linkage.
if [ ! -f "$BUILD_DIR/src/bin/pg_dump/pg_dump" ]; then
  "$ROOT/docker_pglite.sh"
fi

test -f "$BUILD_DIR/.pglite-oxide-runtime-kind"
test "$(cat "$BUILD_DIR/.pglite-oxide-runtime-kind")" = "wasix-postgres-server"
test -f "$BUILD_DIR/src/bin/pg_dump/pg_dump"
echo "verified PostgreSQL WASIX core pg_dump"
