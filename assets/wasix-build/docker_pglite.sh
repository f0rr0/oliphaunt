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
  --cpus="$JOBS" \
  -e BUILD_DIR="$CONTAINER_BUILD_DIR" \
  -e PGSRC="$CONTAINER_PGSRC" \
  -e FORCE_RECONFIGURE="${FORCE_RECONFIGURE:-0}" \
  -e JOBS="$JOBS" \
  -e PGLITE_MODE=1 \
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
  -e PGLITE_OXIDE_WASIX_BACKEND_TIMING="${PGLITE_OXIDE_WASIX_BACKEND_TIMING:-0}" \
  -e WASIX_HOME=/opt/wasixcc-home/.wasixcc \
  -v "$REPO_ROOT:/work" \
  -w /work \
  "$IMAGE" \
  bash -lc '
    set -euo pipefail
    export PATH="$WASIX_HOME/bin:$PATH"
    . ./assets/wasix-build/profile_flags.sh
    pglite_oxide_apply_wasix_profile configure
    profile_signature="$(pglite_oxide_wasix_profile_signature)"

    needs_configure=0
    if [ "${FORCE_RECONFIGURE:-0}" = "1" ] || [ ! -f "$BUILD_DIR/config.status" ]; then
      needs_configure=1
    elif ! cmp -s "$PGSRC/.pglite-oxide-source-head" "$BUILD_DIR/.pglite-oxide-source-head"; then
      needs_configure=1
    elif ! cmp -s "$PGSRC/.pglite-oxide-patch-sha256" "$BUILD_DIR/.pglite-oxide-patch-sha256"; then
      needs_configure=1
    elif [ ! -f "$BUILD_DIR/.pglite-oxide-bridge-sha256" ]; then
      needs_configure=1
    elif ! sha256sum -c "$BUILD_DIR/.pglite-oxide-bridge-sha256" >/dev/null 2>&1; then
      needs_configure=1
    elif [ ! -f "$BUILD_DIR/.pglite-oxide-build-profile" ]; then
      needs_configure=1
    elif [ "$profile_signature" != "$(cat "$BUILD_DIR/.pglite-oxide-build-profile")" ]; then
      needs_configure=1
    fi

    if [ "$needs_configure" = "1" ]; then
      rm -rf "$BUILD_DIR"
      ./assets/wasix-build/configure_wasix_dl.sh
      cp "$PGSRC/.pglite-oxide-source-head" "$BUILD_DIR/.pglite-oxide-source-head"
      cp "$PGSRC/.pglite-oxide-patch-sha256" "$BUILD_DIR/.pglite-oxide-patch-sha256"
      sha256sum ./assets/wasix-build/wasix_shim/pglite_wasix_bridge.c \
        > "$BUILD_DIR/.pglite-oxide-bridge-sha256"
      printf "%s\n" "$profile_signature" > "$BUILD_DIR/.pglite-oxide-build-profile"
    else
      echo "reusing configured PGlite build at $BUILD_DIR"
    fi
    pglite_oxide_apply_wasix_profile build
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
    make -s -j"$JOBS" -C "$BUILD_DIR/src/backend" pglite
  '
