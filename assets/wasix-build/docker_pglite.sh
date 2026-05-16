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

container_path_for() {
  local path="$1"
  case "$path" in
    "$REPO_ROOT")
      printf '/work\n'
      ;;
    "$REPO_ROOT"/*)
      printf '/work/%s\n' "${path#$REPO_ROOT/}"
      ;;
    *)
      printf '%s\n' "$path"
      ;;
  esac
}

DEFAULT_WASIXCC_SYSROOT_PREFIX="$ROOT/work/upstream/build/patched-wasixcc-sysroot"
if [ -z "${WASIXCC_SYSROOT_PREFIX:-}" ] && [ -f "$DEFAULT_WASIXCC_SYSROOT_PREFIX/.fresh-sysroot-signature" ]; then
  WASIXCC_SYSROOT_PREFIX="$DEFAULT_WASIXCC_SYSROOT_PREFIX"
fi
if [ -z "${WASIXCC_SYSROOT_PREFIX:-}" ] || [ ! -f "$WASIXCC_SYSROOT_PREFIX/.fresh-sysroot-signature" ]; then
  echo "patched WASIX libc sysroot is required for PostgreSQL 18 WASIX server-core artifacts" >&2
  echo "run: assets/wasix-build/experiments/fresh-wasix-postgres/upstream/bin/build-patched-wasix-libc-sysroot.sh" >&2
  exit 2
fi

DOCKER_WASIX_SYSROOT_ARGS=(
  -e "WASIXCC_SYSROOT_PREFIX=$(container_path_for "$WASIXCC_SYSROOT_PREFIX")"
)
if [ -n "${WASIXCC_SYSROOT:-}" ]; then
  DOCKER_WASIX_SYSROOT_ARGS+=(
    -e "WASIXCC_SYSROOT=$(container_path_for "$WASIXCC_SYSROOT")"
  )
fi

"$ROOT/prepare_patched_source.sh"

if [ "${PGLITE_OXIDE_SKIP_IMAGE_BUILD:-0}" = "1" ]; then
  if ! "$DOCKER" image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "Docker image $IMAGE is missing and PGLITE_OXIDE_SKIP_IMAGE_BUILD=1 was set" >&2
    exit 2
  fi
  echo "skipping Docker image build; reusing $IMAGE"
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
  -e BUILD_DIR="$CONTAINER_BUILD_DIR" \
  -e PGSRC="$CONTAINER_PGSRC" \
  -e FORCE_RECONFIGURE="${FORCE_RECONFIGURE:-0}" \
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
  "${DOCKER_WASIX_SYSROOT_ARGS[@]}" \
  -v "$REPO_ROOT:/work" \
  -w /work \
  "$IMAGE" \
  bash -lc '
    set -euo pipefail
    . ./assets/wasix-build/docker_wasix_env.sh
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
    elif [ ! -f "$BUILD_DIR/.pglite-oxide-build-profile" ]; then
      needs_configure=1
    elif [ "$profile_signature" != "$(cat "$BUILD_DIR/.pglite-oxide-build-profile")" ]; then
      needs_configure=1
    elif [ ! -f "$BUILD_DIR/.pglite-oxide-runtime-kind" ]; then
      needs_configure=1
    elif [ "$(cat "$BUILD_DIR/.pglite-oxide-runtime-kind")" != "wasix-postgres-server" ]; then
      needs_configure=1
    fi

    if [ "$needs_configure" = "1" ]; then
      rm -rf "$BUILD_DIR"
      mkdir -p "$BUILD_DIR"
      cd "$BUILD_DIR"
      CC=wasixcc \
      AR=wasixar \
      RANLIB=wasixranlib \
      NM=wasixnm \
      CPPFLAGS="-D_GNU_SOURCE" \
      CFLAGS="$PGLITE_OXIDE_PROFILE_CFLAGS -fPIC -pthread -sWASM_EXCEPTIONS=yes -Wno-unused-command-line-argument" \
      LDFLAGS="$PGLITE_OXIDE_PROFILE_LDFLAGS -fPIC -pthread -sWASM_EXCEPTIONS=yes" \
      "$PGSRC/configure" \
        --prefix=/ \
        --libdir=/lib \
        --datadir=/share/postgresql \
        --bindir=/bin \
        --host=wasm32-wasix \
        --with-template=wasix-core \
        --without-readline \
        --without-icu \
        --without-zlib \
        --without-llvm \
        --without-pam \
        --with-openssl=no
      cp "$PGSRC/.pglite-oxide-source-head" "$BUILD_DIR/.pglite-oxide-source-head"
      cp "$PGSRC/.pglite-oxide-patch-sha256" "$BUILD_DIR/.pglite-oxide-patch-sha256"
      printf "%s\n" "$profile_signature" > "$BUILD_DIR/.pglite-oxide-build-profile"
      printf "wasix-postgres-server\n" > "$BUILD_DIR/.pglite-oxide-runtime-kind"
    else
      echo "reusing configured PostgreSQL WASIX core build at $BUILD_DIR"
    fi

    pglite_oxide_apply_wasix_profile build
    export AR=wasixar
    export RANLIB=wasixranlib
    export NM=wasixnm
    export LLVM_NM=wasixnm

    core_dirs=(
      src/port
      src/common
      src/include
      src/interfaces/libpq
      src/backend
      src/backend/snowball
      src/backend/utils/mb/conversion_procs
      src/pl/plpgsql/src
      src/bin/initdb
      src/bin/pg_ctl
      src/bin/psql
      src/bin/pg_dump
      src/bin/pg_config
      src/timezone
    )

    rm -rf "$BUILD_DIR/src/timezone/compiled"
    mkdir -p "$BUILD_DIR/src/timezone/compiled"
    /usr/sbin/zic \
      -d "$BUILD_DIR/src/timezone/compiled" \
      "$PGSRC/src/timezone/data/tzdata.zi"
    test -f "$BUILD_DIR/src/timezone/compiled/UTC"
    test -f "$BUILD_DIR/src/timezone/compiled/GMT"
    test -f "$BUILD_DIR/src/timezone/compiled/Etc/UTC"
    test -f "$BUILD_DIR/src/timezone/compiled/America/New_York"

    rm -f \
      "$BUILD_DIR/src/backend/postgres" \
      "$BUILD_DIR/src/bin/initdb/initdb" \
      "$BUILD_DIR/src/bin/pg_ctl/pg_ctl" \
      "$BUILD_DIR/src/bin/psql/psql" \
      "$BUILD_DIR/src/bin/pg_dump/pg_dump" \
      "$BUILD_DIR/src/bin/pg_dump/pg_restore" \
      "$BUILD_DIR/src/bin/pg_dump/pg_dumpall" \
      "$BUILD_DIR/src/bin/pg_config/pg_config"
    for dir in "${core_dirs[@]}"; do
      make -s -j"$JOBS" -C "$BUILD_DIR/$dir" all
    done
    test -f "$BUILD_DIR/src/backend/postgres"
    test -f "$BUILD_DIR/src/bin/initdb/initdb"
    test -f "$BUILD_DIR/src/bin/pg_dump/pg_dump"
    test -f "$BUILD_DIR/src/pl/plpgsql/src/plpgsql.so"
    test -f "$BUILD_DIR/src/backend/snowball/dict_snowball.so"
  '
