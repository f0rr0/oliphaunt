#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null || (cd "$ROOT/../../../../../.." && pwd))"
. "$ROOT/source_lane.sh"
SOURCE_LANE="$(oliphaunt_wasix_source_lane)"

IMAGE="${IMAGE:-oliphaunt-wasix-wasix-build:local}"
JOBS="${JOBS:-4}"
CONTAINER_ROOT="${CONTAINER_ROOT:-/work/src/runtimes/liboliphaunt/wasix/assets/build}"
CONTAINER_GENERATED_ROOT="${CONTAINER_GENERATED_ROOT:-/work/target/oliphaunt-wasix/wasix-build}"
CONTAINER_BUILD_DIR="${CONTAINER_BUILD_DIR:-$(oliphaunt_wasix_default_build_dir "$SOURCE_LANE")}"
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

CONTAINER_PGSRC="${CONTAINER_PGSRC:-$(oliphaunt_wasix_prepare_source_for_docker "$SOURCE_LANE")}"

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
  -e FORCE_RECONFIGURE="${FORCE_RECONFIGURE:-0}" \
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
  -e OLIPHAUNT_WASM_PG18_DISABLE_SPINLOCKS="${OLIPHAUNT_WASM_PG18_DISABLE_SPINLOCKS:-0}" \
  -e WASIX_HOME=/opt/wasixcc-home/.wasixcc \
  -v "$REPO_ROOT:/work" \
  -w /work \
  "$IMAGE" \
  bash -lc '
    set -euo pipefail
    . ./src/runtimes/liboliphaunt/wasix/assets/build/docker_wasix_env.sh
    . ./src/runtimes/liboliphaunt/wasix/assets/build/profile_flags.sh
    oliphaunt_wasix_apply_wasix_profile configure
    profile_signature="$(oliphaunt_wasix_wasix_profile_signature)"
    configure_script=./src/runtimes/liboliphaunt/wasix/assets/build/configure_wasix_dl.sh
    icu_prefix="$(./src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_icu.sh)"
    export ICU_PREFIX="$icu_prefix"
    icu_stamp="$icu_prefix/.oliphaunt-wasix-icu-build"

    needs_configure=0
    if [ "${FORCE_RECONFIGURE:-0}" = "1" ] || [ ! -f "$BUILD_DIR/config.status" ]; then
      needs_configure=1
    elif ! cmp -s "$PGSRC/.oliphaunt-wasix-source-fingerprint" "$BUILD_DIR/.oliphaunt-wasix-source-fingerprint"; then
      needs_configure=1
    elif ! cmp -s "$PGSRC/.oliphaunt-wasix-postgres-version" "$BUILD_DIR/.oliphaunt-wasix-postgres-version"; then
      needs_configure=1
    elif [ ! -f "$BUILD_DIR/.oliphaunt-wasix-bridge-sha256" ]; then
      needs_configure=1
    elif ! sha256sum -c "$BUILD_DIR/.oliphaunt-wasix-bridge-sha256" >/dev/null 2>&1; then
      needs_configure=1
    elif [ ! -f "$BUILD_DIR/.oliphaunt-wasix-configure-sha256" ]; then
      needs_configure=1
    elif ! sha256sum -c "$BUILD_DIR/.oliphaunt-wasix-configure-sha256" >/dev/null 2>&1; then
      needs_configure=1
    elif [ ! -f "$BUILD_DIR/.oliphaunt-wasix-icu-build" ]; then
      needs_configure=1
    elif ! cmp -s "$icu_stamp" "$BUILD_DIR/.oliphaunt-wasix-icu-build"; then
      needs_configure=1
    elif [ ! -f "$BUILD_DIR/.oliphaunt-wasix-build-profile" ]; then
      needs_configure=1
    elif [ "$profile_signature" != "$(cat "$BUILD_DIR/.oliphaunt-wasix-build-profile")" ]; then
      needs_configure=1
    elif [ ! -f "$BUILD_DIR/.oliphaunt-wasix-configure-experiment" ]; then
      needs_configure=1
    elif [ "${OLIPHAUNT_WASM_PG18_DISABLE_SPINLOCKS:-0}" != "$(cat "$BUILD_DIR/.oliphaunt-wasix-configure-experiment")" ]; then
      needs_configure=1
    fi

    if [ "$needs_configure" = "1" ]; then
      rm -rf "$BUILD_DIR"
      "$configure_script"
      cp "$PGSRC/.oliphaunt-wasix-source-fingerprint" "$BUILD_DIR/.oliphaunt-wasix-source-fingerprint"
      cp "$PGSRC/.oliphaunt-wasix-postgres-version" "$BUILD_DIR/.oliphaunt-wasix-postgres-version"
      sha256sum ./src/runtimes/liboliphaunt/wasix/assets/build/wasix_shim/oliphaunt_wasix_bridge.c \
        > "$BUILD_DIR/.oliphaunt-wasix-bridge-sha256"
      sha256sum "$configure_script" > "$BUILD_DIR/.oliphaunt-wasix-configure-sha256"
      cp "$icu_stamp" "$BUILD_DIR/.oliphaunt-wasix-icu-build"
      printf "%s\n" "$profile_signature" > "$BUILD_DIR/.oliphaunt-wasix-build-profile"
      printf "%s\n" "${OLIPHAUNT_WASM_PG18_DISABLE_SPINLOCKS:-0}" > "$BUILD_DIR/.oliphaunt-wasix-configure-experiment"
    else
      echo "reusing configured PG18 Oliphaunt build at $BUILD_DIR"
    fi
    oliphaunt_wasix_apply_wasix_profile build
    rm -rf "$BUILD_DIR/src/timezone/compiled"
    mkdir -p "$BUILD_DIR/src/timezone/compiled"
    /usr/sbin/zic \
      -d "$BUILD_DIR/src/timezone/compiled" \
      "$PGSRC/src/timezone/data/tzdata.zi"
    test -f "$BUILD_DIR/src/timezone/compiled/UTC"
    test -f "$BUILD_DIR/src/timezone/compiled/GMT"
    test -f "$BUILD_DIR/src/timezone/compiled/Etc/UTC"
    test -f "$BUILD_DIR/src/timezone/compiled/America/New_York"
    make -s -C "$BUILD_DIR/src/backend" generated-headers
    make -s -C "$BUILD_DIR/src/backend" submake-libpgport
    make -s -j"$JOBS" -C "$BUILD_DIR/src/backend" oliphaunt
  '
