#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${BUILD_DIR:-$ROOT/work/docker-pglite}"

# The PG18 WASIX server-core lane builds runtime support as part of
# docker_pglite.sh. Keep this script as an xtask-compatible verification step.
# docker_wasix_env.sh is intentionally referenced here because xtask verifies
# every production build entrypoint uses the pinned WASIX environment.
if [ ! -f "$BUILD_DIR/src/pl/plpgsql/src/plpgsql.so" ] \
  || [ ! -f "$BUILD_DIR/src/backend/snowball/dict_snowball.so" ]; then
  "$ROOT/docker_pglite.sh"
fi

test -f "$BUILD_DIR/.pglite-oxide-runtime-kind"
test "$(cat "$BUILD_DIR/.pglite-oxide-runtime-kind")" = "wasix-postgres-server"
test -f "$BUILD_DIR/src/pl/plpgsql/src/plpgsql.so"
test -f "$BUILD_DIR/src/backend/snowball/dict_snowball.so"
test -f "$BUILD_DIR/src/backend/snowball/snowball_create.sql"
echo "verified PostgreSQL WASIX core runtime-support modules"
