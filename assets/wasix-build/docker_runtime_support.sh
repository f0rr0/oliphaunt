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
  -e PGLITE_OXIDE_WASIX_BACKEND_TIMING="${PGLITE_OXIDE_WASIX_BACKEND_TIMING:-0}" \
  -e WASIX_HOME=/opt/wasixcc-home/.wasixcc \
  -v "$REPO_ROOT:/work" \
  -w /work \
  "$IMAGE" \
  bash -lc '
    set -euo pipefail
    . ./assets/wasix-build/docker_wasix_env.sh
    . ./assets/wasix-build/profile_flags.sh
    pglite_oxide_apply_wasix_profile build

    test -f "$BUILD_DIR/config.status"
    test -f "$BUILD_DIR/src/backend/pglite"
    cmp -s "$PGSRC/.pglite-oxide-source-head" "$BUILD_DIR/.pglite-oxide-source-head"
    cmp -s "$PGSRC/.pglite-oxide-patch-sha256" "$BUILD_DIR/.pglite-oxide-patch-sha256"
    sha256sum -c "$BUILD_DIR/.pglite-oxide-bridge-sha256" >/dev/null
    test "$(pglite_oxide_wasix_profile_signature)" = "$(cat "$BUILD_DIR/.pglite-oxide-build-profile")"

    make -s -j"$JOBS" -C "$BUILD_DIR/src/pl/plpgsql/src" all
    make -s -j"$JOBS" -C "$BUILD_DIR/src/backend/snowball" all
    test -f "$BUILD_DIR/src/pl/plpgsql/src/plpgsql.so"
    test -f "$BUILD_DIR/src/backend/snowball/dict_snowball.so"
    test -f "$BUILD_DIR/src/backend/snowball/snowball_create.sql"
  '
