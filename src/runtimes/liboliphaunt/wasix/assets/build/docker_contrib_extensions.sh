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
CONTAINER_PGSRC="${CONTAINER_PGSRC:-$(oliphaunt_wasix_prepare_source_for_docker "$SOURCE_LANE")}"
CONTAINER_PLAN="${CONTAINER_PLAN:-/work/src/extensions/generated/contrib-build.tsv}"
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
  -e PLAN="$CONTAINER_PLAN" \
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
    oliphaunt_wasix_apply_wasix_profile build

    test -f "$BUILD_DIR/config.status"
    test -f "$BUILD_DIR/src/backend/oliphaunt"
    oliphaunt_wasix_check_source_markers
    sha256sum -c "$BUILD_DIR/.oliphaunt-wasix-bridge-sha256" >/dev/null
    test "$(oliphaunt_wasix_wasix_profile_signature)" = "$(cat "$BUILD_DIR/.oliphaunt-wasix-build-profile")"

    if [ ! -f "$PLAN" ]; then
      echo "generated contrib build plan missing: $PLAN" >&2
      exit 1
    fi

    OPENSSL_PREFIX=
    UUID_PREFIX=
    build_portable_uuid() {
      local prefix="$CONTAINER_GENERATED_ROOT/dependencies/uuid"
      local source_dir="/work/src/runtimes/liboliphaunt/native/portable-uuid"
      local object="$prefix/portable_uuid.o"
      local archive="$prefix/lib/libuuid.a"
      if [ -f "$archive" ] && [ -d "$prefix/include/uuid" ]; then
        printf "%s\n" "$prefix"
        return 0
      fi
      test -f "$source_dir/portable_uuid.c"
      rm -rf "$prefix"
      mkdir -p "$prefix/include" "$prefix/lib"
      cp -R "$source_dir/include/uuid" "$prefix/include/"
      wasixcc $OLIPHAUNT_WASM_PROFILE_CFLAGS -fPIC \
        -I"$source_dir/include" \
        -I"$BUILD_DIR/src/include" \
        -I"$BUILD_DIR/src/include/port" \
        -I"$PGSRC/src/include" \
        -I"$PGSRC/src/include/port" \
        -c "$source_dir/portable_uuid.c" \
        -o "$object"
      wasixar crs "$archive" "$object"
      wasixranlib "$archive"
      test -s "$archive"
      printf "%s\n" "$prefix"
    }
    while IFS=$'\''\t'\'' read -r id sql_name contrib_dir module_file archive stable; do
      case "$id" in ""|"#"*) continue ;; esac
      test -n "$sql_name"
      test -n "$contrib_dir"
      echo "building contrib extension $id from contrib/$contrib_dir"
      test -d "$BUILD_DIR/contrib/$contrib_dir"
      extra_make_args=()
      if [ "$id" = "pgcrypto" ]; then
        if [ -z "$OPENSSL_PREFIX" ]; then
          OPENSSL_PREFIX="$("$CONTAINER_ROOT/build_wasix_openssl.sh")"
        fi
        extra_make_args+=("PG_CPPFLAGS=-I$OPENSSL_PREFIX/include")
        extra_make_args+=("SHLIB_LINK=$OPENSSL_PREFIX/lib/libcrypto.a")
        make -s -C "$BUILD_DIR/contrib/$contrib_dir" "${extra_make_args[@]}" clean >/dev/null 2>&1 || true
      fi
      if [ "$id" = "uuid_ossp" ]; then
        if [ -z "$UUID_PREFIX" ]; then
          UUID_PREFIX="$(build_portable_uuid)"
        fi
        extra_make_args+=("PG_CPPFLAGS=-I$UUID_PREFIX/include -DHAVE_UUID_E2FS=1 -DHAVE_UUID_UUID_H=1")
        extra_make_args+=("UUID_LIBS=$UUID_PREFIX/lib/libuuid.a")
        make -s -C "$BUILD_DIR/contrib/$contrib_dir" "${extra_make_args[@]}" clean >/dev/null 2>&1 || true
      fi
      make -s -j"$JOBS" -C "$BUILD_DIR/contrib/$contrib_dir" "${extra_make_args[@]}" all
      if [ "$module_file" = "-" ]; then
        continue
      fi
      if [ ! -f "$BUILD_DIR/contrib/$contrib_dir/$module_file" ]; then
        echo "expected WASIX side module missing: $BUILD_DIR/contrib/$contrib_dir/$module_file" >&2
        find "$BUILD_DIR/contrib/$contrib_dir" -maxdepth 1 -type f -name "*.so" -print >&2
        exit 1
      fi
    done < "$PLAN"
  '
