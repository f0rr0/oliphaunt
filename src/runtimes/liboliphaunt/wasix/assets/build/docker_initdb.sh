#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$ROOT/wasix_third_party.sh"
REPO_ROOT="$(oliphaunt_wasix_repo_root "$ROOT")"
. "$ROOT/source_lane.sh"
SOURCE_LANE="$(oliphaunt_wasix_source_lane)"

IMAGE="${IMAGE:-oliphaunt-wasix-wasix-build:local}"
JOBS="${JOBS:-4}"
CONTAINER_ROOT="${CONTAINER_ROOT:-/work/src/runtimes/liboliphaunt/wasix/assets/build}"
CONTAINER_GENERATED_ROOT="${CONTAINER_GENERATED_ROOT:-/work/target/oliphaunt-wasix/wasix-build}"
CONTAINER_BUILD_DIR="${CONTAINER_BUILD_DIR:-$(oliphaunt_wasix_default_build_dir "$SOURCE_LANE")}"
CONTAINER_PGSRC="${CONTAINER_PGSRC:-$(oliphaunt_wasix_prepare_source_for_docker "$SOURCE_LANE")}"
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
if [ "${OLIPHAUNT_WASM_DOCKER_AS_ROOT:-0}" != "1" ]; then
  DOCKER_USER_ARGS=(--user "$(id -u):$(id -g)" -e HOME=/tmp)
fi

if [ "${OLIPHAUNT_WASM_SKIP_IMAGE_BUILD:-0}" = "1" ]; then
  "$DOCKER" image inspect "$IMAGE" >/dev/null 2>&1 || {
    echo "WASIX build image is missing: $IMAGE" >&2
    exit 1
  }
  echo "reusing Docker image $IMAGE"
elif [ "${FORCE_IMAGE_BUILD:-0}" = "1" ] || ! "$DOCKER" image inspect "$IMAGE" >/dev/null 2>&1; then
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
  -e CONTAINER_GENERATED_ROOT="$CONTAINER_GENERATED_ROOT" \
  -e BUILD_DIR="$CONTAINER_BUILD_DIR" \
  -e PGSRC="$CONTAINER_PGSRC" \
  -e OLIPHAUNT_WASM_SOURCE_LANE="$SOURCE_LANE" \
  -e JOBS="$JOBS" \
  -e OLIPHAUNT_WASM_BUILD_PROFILE="${OLIPHAUNT_WASM_BUILD_PROFILE:-release}" \
  -e OLIPHAUNT_WASM_WASIX_COPT="${OLIPHAUNT_WASM_WASIX_COPT:-}" \
  -e OLIPHAUNT_WASM_WASIX_LOPT="${OLIPHAUNT_WASM_WASIX_LOPT:-}" \
  -e OLIPHAUNT_WASM_WASIX_CONFIGURE_WASM_OPT="${OLIPHAUNT_WASM_WASIX_CONFIGURE_WASM_OPT:-no}" \
  -e OLIPHAUNT_WASM_WASIX_BUILD_WASM_OPT="${OLIPHAUNT_WASM_WASIX_BUILD_WASM_OPT:-yes}" \
  -e OLIPHAUNT_WASM_WASM_OPT_FLAGS="${OLIPHAUNT_WASM_WASM_OPT_FLAGS-}" \
  -e OLIPHAUNT_WASM_WASM_OPT_SUPPRESS_DEFAULT="${OLIPHAUNT_WASM_WASM_OPT_SUPPRESS_DEFAULT-}" \
  -e OLIPHAUNT_WASM_WASM_OPT_PRESERVE_UNOPTIMIZED="${OLIPHAUNT_WASM_WASM_OPT_PRESERVE_UNOPTIMIZED-}" \
  -e OLIPHAUNT_WASM_WASIX_COMPILER_FLAGS="${OLIPHAUNT_WASM_WASIX_COMPILER_FLAGS:-}" \
  -e OLIPHAUNT_WASM_WASIX_LINKER_FLAGS="${OLIPHAUNT_WASM_WASIX_LINKER_FLAGS:-}" \
  -e OLIPHAUNT_WASM_WASIX_BACKEND_TIMING="${OLIPHAUNT_WASM_WASIX_BACKEND_TIMING:-0}" \
  -e WASIX_HOME=/opt/wasixcc-home/.wasixcc \
  -v "$REPO_ROOT:/work" \
  -w /work \
  "$IMAGE" \
  bash -lc '
    set -euo pipefail
    . ./src/runtimes/liboliphaunt/wasix/assets/build/docker_wasix_env.sh
    . ./src/runtimes/liboliphaunt/wasix/assets/build/profile_flags.sh
    . ./src/runtimes/liboliphaunt/wasix/assets/build/source_lane.sh
    . ./src/runtimes/liboliphaunt/wasix/assets/build/wasix_icu_link.sh
    oliphaunt_wasix_apply_wasix_profile build
    export AR=wasixar
    export RANLIB=wasixranlib
    export NM=wasixnm
    export LLVM_NM=wasixnm

    test -f "$BUILD_DIR/config.status"
    oliphaunt_wasix_check_source_markers
    sha256sum -c "$BUILD_DIR/.oliphaunt-wasix-bridge-sha256" >/dev/null
    test "$(oliphaunt_wasix_wasix_profile_signature)" = "$(cat "$BUILD_DIR/.oliphaunt-wasix-build-profile")"

    ICU_PREFIX="$(./src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_icu.sh)"
    ICU_CFLAGS="$(oliphaunt_wasix_icu_cflags "$ICU_PREFIX")"
    ICU_LIBS="$(oliphaunt_wasix_icu_libs "$ICU_PREFIX")"

    rebuild_generic_frontend_archives() {
      make -s -C "$BUILD_DIR/src/interfaces/libpq" clean
      make -s -C "$BUILD_DIR/src/fe_utils" clean
      make -s -C "$BUILD_DIR/src/port" clean
      make -s -C "$BUILD_DIR/src/common" clean
      make -s -C "$BUILD_DIR/src/port" all
      make -s -C "$BUILD_DIR/src/common" all
      make -s -C "$BUILD_DIR/src/interfaces/libpq" all
      make -s -C "$BUILD_DIR/src/fe_utils" all
    }

    COMMON_CPPFLAGS="-I$PGSRC/src/include/port/wasix-dl $ICU_CFLAGS"
    COMMON_CFLAGS="$OLIPHAUNT_WASM_PROFILE_CFLAGS -sWASM_EXCEPTIONS=yes -sPIC=yes -Wno-unused-command-line-argument"
    COMMON_LDFLAGS="$OLIPHAUNT_WASM_PROFILE_LDFLAGS -sWASM_EXCEPTIONS=yes -sPIC=yes -L$ICU_PREFIX/lib"
    MAIN_LDFLAGS="-sMODULE_KIND=dynamic-main -sSTACK_SIZE=8MB -sINITIAL_MEMORY=128MB -Wl,--wrap=system -Wl,--wrap=popen -Wl,--wrap=pclose"

    INITDB_BUILD_DIR="$(oliphaunt_wasix_scratch_build_dir "${OLIPHAUNT_WASM_SOURCE_LANE:-stable}" wasix-initdb)"
    mkdir -p "$INITDB_BUILD_DIR"
    GENERIC_SHIM="$INITDB_BUILD_DIR/oliphaunt_wasix_shim.o"
    INITDB_SHIM="$INITDB_BUILD_DIR/oliphaunt_wasix_initdb_shim.o"
    wasixcc $COMMON_CFLAGS $COMMON_CPPFLAGS \
      -I"$BUILD_DIR/src/include" \
      -I"$PGSRC/src/include/port/wasix-dl" \
      -c "$CONTAINER_ROOT/wasix_shim/oliphaunt_wasix_shim.c" \
      -o "$GENERIC_SHIM"
    wasixcc $COMMON_CFLAGS $COMMON_CPPFLAGS \
      -I"$BUILD_DIR/src/include" \
      -I"$PGSRC/src/include/port/wasix-dl" \
      -c "$CONTAINER_ROOT/wasix_shim/oliphaunt_wasix_initdb_shim.c" \
      -o "$INITDB_SHIM"

    make -s -C "$BUILD_DIR/src/bin/initdb" clean
    make -s -j"$JOBS" -C "$BUILD_DIR/src/bin/initdb" initdb \
      CFLAGS="$COMMON_CFLAGS -Dsystem=oliphaunt_wasix_initdb_system -Dpopen=oliphaunt_wasix_initdb_popen -Dpclose=oliphaunt_wasix_initdb_pclose -Dgeteuid=oliphaunt_wasix_geteuid -Dgetuid=oliphaunt_wasix_getuid -Dgetegid=oliphaunt_wasix_getegid -Dgetgid=oliphaunt_wasix_getgid -Dgetpwuid=oliphaunt_wasix_getpwuid -Dgetpwuid_r=oliphaunt_wasix_getpwuid_r -Wno-unused-function -Wno-missing-prototypes" \
      LDFLAGS="$COMMON_LDFLAGS -L$BUILD_DIR/src/common -L$BUILD_DIR/src/port" \
      LDFLAGS_EX="$MAIN_LDFLAGS $GENERIC_SHIM $INITDB_SHIM $BUILD_DIR/src/fe_utils/libpgfeutils.a $BUILD_DIR/src/interfaces/libpq/libpq.a $BUILD_DIR/src/common/libpgcommon.a $BUILD_DIR/src/port/libpgport.a $ICU_LIBS"
    test -f "$BUILD_DIR/src/bin/initdb/initdb"
    rebuild_generic_frontend_archives
  '
