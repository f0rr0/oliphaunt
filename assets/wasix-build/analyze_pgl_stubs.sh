#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$ROOT/../.." && pwd)"

IMAGE="${IMAGE:-pglite-oxide-wasix-build:local}"
JOBS="${JOBS:-4}"
CONTAINER_ROOT="${CONTAINER_ROOT:-/work/assets/wasix-build}"
CONTAINER_BUILD_DIR="${CONTAINER_BUILD_DIR:-$CONTAINER_ROOT/work/docker-pglite}"
CONTAINER_PGSRC="${CONTAINER_PGSRC:-$CONTAINER_ROOT/work/postgres-pglite-wasix-src}"
DOCKER="${DOCKER:-$(command -v docker 2>/dev/null || true)}"
if [ -z "$DOCKER" ] && [ -x /usr/local/bin/docker ]; then
  DOCKER=/usr/local/bin/docker
fi
if [ -z "$DOCKER" ] && [ -x /opt/homebrew/bin/docker ]; then
  DOCKER=/opt/homebrew/bin/docker
fi
if [ -z "$DOCKER" ]; then
  echo "docker CLI not found; set DOCKER=/path/to/docker" >&2
  exit 127
fi
DOCKER_USER_ARGS=()
if [ "${PGLITE_OXIDE_DOCKER_AS_ROOT:-0}" != "1" ]; then
  DOCKER_USER_ARGS=(--user "$(id -u):$(id -g)" -e HOME=/tmp)
fi

"$DOCKER" run --rm \
  "${DOCKER_USER_ARGS[@]}" \
  --cpus="$JOBS" \
  -e BUILD_DIR="$CONTAINER_BUILD_DIR" \
  -e PGSRC="$CONTAINER_PGSRC" \
  -e WASIX_HOME=/opt/wasixcc-home/.wasixcc \
  -v "$REPO_ROOT:/work" \
  -w /work \
  "$IMAGE" \
  bash -lc '
    set -euo pipefail
    . ./assets/wasix-build/docker_wasix_env.sh
    test -f "$BUILD_DIR/src/backend/pglite"

    mkdir -p /work/assets/wasix-build/build/link-analysis
    out=/work/assets/wasix-build/build/link-analysis/wasix-host-abi-used.txt
    stubs="pgl_system pgl_popen pgl_pclose pgl_geteuid pgl_getuid pgl_getpwuid pgl_exit pgl_atexit pgl_longjmp pgl_siglongjmp pgl_recv pgl_send pgl_shmget pgl_shmat pgl_shmdt pgl_shmctl ProcessStartupPacket"

    runtime_inputs=(
      "$BUILD_DIR/libpgcore.a"
      "$BUILD_DIR/libpgcore.o"
      "$BUILD_DIR/src/common/libpgcommon_srv.a"
      "$BUILD_DIR/src/port/libpgport_srv.a"
      "$BUILD_DIR/src/backend/snowball/libdict_snowball.a"
      "$BUILD_DIR/src/pl/plpgsql/src/libplpgsql.a"
    )
    frontend_tool_inputs=(
      "$BUILD_DIR/src/bin/pg_dump/"*.o
      "$BUILD_DIR/src/interfaces/libpq/libpq.a"
      "$BUILD_DIR/src/common/libpgcommon.a"
      "$BUILD_DIR/src/common/libpgcommon_shlib.a"
      "$BUILD_DIR/src/port/libpgport.a"
      "$BUILD_DIR/src/port/libpgport_shlib.a"
      "$BUILD_DIR/src/fe_utils/libpgfeutils.a"
    )
    compiled_sources=(
      "$PGSRC/pglite/src/pglitec"
      "$PGSRC/src/bin/initdb/initdb.c"
      "$PGSRC/src/bin/initdb/findtimezone.c"
      "$PGSRC/src/fe_utils/option_utils.c"
    )

    print_undefined_refs() {
      for obj in "$@"; do
        [ -e "$obj" ] || continue
        undef=$(wasixnm -u "$obj" 2>/dev/null || true)
        for sym in $stubs; do
          if printf "%s\n" "$undef" | grep -Eq "(^| )U $sym$"; then
            echo "$sym $obj"
          fi
        done
      done | sort -u
    }

    symbol_defined_in() {
      obj="$1"
      sym="$2"
      wasixnm "$obj" 2>/dev/null | awk -v sym="$sym" \
        '\''$2 ~ /^[TtWw]$/ && $3 == sym { found = 1 } END { exit(found ? 0 : 1) }'\''
    }

    {
      echo "# WASIX host ABI link-symbol analysis"
      echo
      echo "Generated from $BUILD_DIR with wasixnm."
      echo "Source tree: $PGSRC"
      echo
      echo "## Definitions compiled into final pglite"
      for sym in $stubs; do
        printf "%-30s" "$sym"
        if symbol_defined_in "$BUILD_DIR/src/backend/pglite" "$sym"; then
          printf " final"
        fi
        printf "\n"
      done
      echo
      echo "## Runtime link inputs requiring WASIX host ABI ownership"
      print_undefined_refs "${runtime_inputs[@]}"
      echo
      echo "## Frontend tool inputs requiring frontend/common ownership"
      echo "These references are reported for pg_dump and future tool packaging."
      echo "They do not by themselves justify adding symbols to the production WASIX bridge."
      print_undefined_refs "${frontend_tool_inputs[@]}"
      echo
      echo "## Runtime compiled-source call sites"
      echo "This includes upstream pglitec plus initdb/frontend source files when present."
      for sym in $stubs; do
        matches=$(grep -R --line-number -E "\\b${sym}\\s*\\(" "${compiled_sources[@]}" 2>/dev/null || true)
        if [ -n "$matches" ]; then
          printf "%s\n%s\n" "$sym" "$matches"
        fi
      done
    } > "$out"

    cat "$out"
  '
