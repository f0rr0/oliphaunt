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
export PATH="$(dirname "$DOCKER"):$PATH"
DOCKER_USER_ARGS=()
if [ "${PGLITE_OXIDE_DOCKER_AS_ROOT:-0}" != "1" ]; then
  DOCKER_USER_ARGS=(--user "$(id -u):$(id -g)" -e HOME=/tmp)
fi

"$ROOT/prepare_patched_source.sh"

if [ "${FORCE_IMAGE_BUILD:-0}" = "1" ] || ! "$DOCKER" image inspect "$IMAGE" >/dev/null 2>&1; then
  "$DOCKER" build \
    -t "$IMAGE" \
    -f "$ROOT/docker/Dockerfile" \
    "$ROOT/docker"
else
  echo "reusing Docker image $IMAGE"
fi

"$DOCKER" run --rm \
  "${DOCKER_USER_ARGS[@]}" \
  --cpus="$JOBS" \
  -e CONTAINER_ROOT="$CONTAINER_ROOT" \
  -e BUILD_DIR="$CONTAINER_BUILD_DIR" \
  -e PGSRC="$CONTAINER_PGSRC" \
  -e JOBS="$JOBS" \
  -e PGLITE_OXIDE_BUILD_PROFILE="${PGLITE_OXIDE_BUILD_PROFILE:-release-o3}" \
  -e PGLITE_OXIDE_WASIX_COPT="${PGLITE_OXIDE_WASIX_COPT:-}" \
  -e PGLITE_OXIDE_WASIX_LOPT="${PGLITE_OXIDE_WASIX_LOPT:-}" \
  -e PGLITE_OXIDE_WASIX_CONFIGURE_WASM_OPT="${PGLITE_OXIDE_WASIX_CONFIGURE_WASM_OPT:-no}" \
  -e PGLITE_OXIDE_WASIX_BUILD_WASM_OPT="${PGLITE_OXIDE_WASIX_BUILD_WASM_OPT:-yes}" \
  -e PGLITE_OXIDE_WASM_OPT_FLAGS="${PGLITE_OXIDE_WASM_OPT_FLAGS-}" \
  -e PGLITE_OXIDE_WASM_OPT_SUPPRESS_DEFAULT="${PGLITE_OXIDE_WASM_OPT_SUPPRESS_DEFAULT-}" \
  -e PGLITE_OXIDE_WASM_OPT_PRESERVE_UNOPTIMIZED="${PGLITE_OXIDE_WASM_OPT_PRESERVE_UNOPTIMIZED-}" \
  -e PGLITE_OXIDE_WASIX_COMPILER_FLAGS="${PGLITE_OXIDE_WASIX_COMPILER_FLAGS:-}" \
  -e PGLITE_OXIDE_WASIX_LINKER_FLAGS="${PGLITE_OXIDE_WASIX_LINKER_FLAGS:-}" \
  -e WASIX_HOME=/opt/wasixcc-home/.wasixcc \
  -v "$REPO_ROOT:/work" \
  -w /work \
  "$IMAGE" \
  bash -lc '
    set -euo pipefail
    . ./assets/wasix-build/docker_wasix_env.sh
    . ./assets/wasix-build/profile_flags.sh
    pglite_oxide_apply_wasix_profile build
    export AR=wasixar
    export RANLIB=wasixranlib
    export NM=wasixnm
    export LLVM_NM=wasixnm

    test -f "$BUILD_DIR/config.status"
    cmp -s "$PGSRC/.pglite-oxide-source-head" "$BUILD_DIR/.pglite-oxide-source-head"
    cmp -s "$PGSRC/.pglite-oxide-patch-sha256" "$BUILD_DIR/.pglite-oxide-patch-sha256"
    sha256sum -c "$BUILD_DIR/.pglite-oxide-bridge-sha256" >/dev/null
    test "$(pglite_oxide_wasix_profile_signature)" = "$(cat "$BUILD_DIR/.pglite-oxide-build-profile")"

    COMMON_CPPFLAGS="-I$PGSRC/src/include/port/wasix-dl"
    COMMON_CFLAGS="$PGLITE_OXIDE_PROFILE_CFLAGS -sWASM_EXCEPTIONS=yes -sPIC=yes -Wno-unused-command-line-argument"
    COMMON_LDFLAGS="$PGLITE_OXIDE_PROFILE_LDFLAGS -sWASM_EXCEPTIONS=yes -sPIC=yes"
    MAIN_LDFLAGS="-sMODULE_KIND=dynamic-main -sSTACK_SIZE=8MB -sINITIAL_MEMORY=128MB -Wl,--wrap=system -Wl,--wrap=popen -Wl,--wrap=pclose"

    INITDB_BUILD_DIR="$CONTAINER_ROOT/build/wasix-initdb"
    mkdir -p "$INITDB_BUILD_DIR"
    GENERIC_SHIM="$INITDB_BUILD_DIR/pglite_wasix_shim.o"
    INITDB_SHIM="$INITDB_BUILD_DIR/pglite_wasix_initdb_shim.o"
    wasixcc $COMMON_CFLAGS $COMMON_CPPFLAGS \
      -I"$BUILD_DIR/src/include" \
      -I"$PGSRC/src/include/port/wasix-dl" \
      -c "$CONTAINER_ROOT/wasix_shim/pglite_wasix_shim.c" \
      -o "$GENERIC_SHIM"
    wasixcc $COMMON_CFLAGS $COMMON_CPPFLAGS \
      -I"$BUILD_DIR/src/include" \
      -I"$PGSRC/src/include/port/wasix-dl" \
      -c "$CONTAINER_ROOT/wasix_shim/pglite_wasix_initdb_shim.c" \
      -o "$INITDB_SHIM"

    make -s -C "$BUILD_DIR/src/bin/initdb" clean
	    make -s -j"$JOBS" -C "$BUILD_DIR/src/bin/initdb" initdb \
	      CFLAGS="$COMMON_CFLAGS -Dsystem=pgl_initdb_system -Dpopen=pgl_initdb_popen -Dpclose=pgl_initdb_pclose -Dgeteuid=pgl_geteuid -Dgetuid=pgl_getuid -Dgetpwuid=pgl_getpwuid -Wno-unused-function -Wno-missing-prototypes" \
	      LDFLAGS="$COMMON_LDFLAGS -L$BUILD_DIR/src/common -L$BUILD_DIR/src/port" \
	      LDFLAGS_EX="$MAIN_LDFLAGS $GENERIC_SHIM $INITDB_SHIM $BUILD_DIR/src/fe_utils/libpgfeutils.a $BUILD_DIR/src/interfaces/libpq/libpq.a $BUILD_DIR/src/common/libpgcommon.a $BUILD_DIR/src/port/libpgport.a"
    test -f "$BUILD_DIR/src/bin/initdb/initdb"
  '
