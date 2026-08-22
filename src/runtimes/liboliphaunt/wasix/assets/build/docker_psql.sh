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
    export AR=wasixar
    export RANLIB=wasixranlib
    export NM=wasixnm
    export LLVM_NM=wasixnm

    test -f "$BUILD_DIR/config.status"
    oliphaunt_wasix_check_source_markers
    sha256sum -c "$BUILD_DIR/.oliphaunt-wasix-bridge-sha256" >/dev/null
    test "$(oliphaunt_wasix_wasix_profile_signature)" = "$(cat "$BUILD_DIR/.oliphaunt-wasix-build-profile")"

    runtime_build_dir="$BUILD_DIR"

    # The runtime was already sealed with the selected release profile. Build
    # the separate psql closure without ThinLTO: WASIX LLVM can segfault when
    # its large frontend, libpq, and ICU archive closure is linked as one.
    . ./src/runtimes/liboliphaunt/wasix/assets/build/wasix_icu_link.sh
    tool_icu_native_build_dir="$CONTAINER_GENERATED_ROOT/work/icu-native-tools"
    tool_icu_prefix="$CONTAINER_GENERATED_ROOT/work/icu-wasix-tools"
    tool_icu_build_dir="$CONTAINER_GENERATED_ROOT/work/icu-wasix-tools-build"
    icu_prefix="$(
      env -u AR -u RANLIB -u NM -u LLVM_NM \
        ICU_PREFIX="$tool_icu_prefix" \
        ICU_NATIVE_BUILD_DIR="$tool_icu_native_build_dir" \
        ICU_BUILD_DIR="$tool_icu_build_dir" \
        OLIPHAUNT_WASM_BUILD_PROFILE=release-os \
        OLIPHAUNT_WASM_WASIX_COPT="-O2 -g0" \
        ./src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_icu.sh
    )"
    ICU_CFLAGS="$(oliphaunt_wasix_icu_cflags "$icu_prefix")"
    ICU_LIBS="$(oliphaunt_wasix_icu_libs "$icu_prefix")"

    tool_build_dir="$CONTAINER_GENERATED_ROOT/work/docker-psql"
    tool_shim="$CONTAINER_GENERATED_ROOT/build/wasix-psql/oliphaunt_wasix_bridge.o"
    tool_stamp="$tool_build_dir/.oliphaunt-wasix-psql-build"
    expected_tool_stamp="$(
      printf "%s\n" "schema=oliphaunt-wasix-psql-v1"
      sha256sum \
        "$PGSRC/.oliphaunt-wasix-source-fingerprint" \
        "$PGSRC/.oliphaunt-wasix-postgres-version" \
        ./src/runtimes/liboliphaunt/wasix/assets/build/configure_wasix_dl.sh \
        ./src/runtimes/liboliphaunt/wasix/assets/build/profile_flags.sh \
        ./src/runtimes/liboliphaunt/wasix/assets/build/docker_psql.sh \
        "$icu_prefix/.oliphaunt-wasix-icu-build"
    )"
    if [ ! -f "$tool_build_dir/config.status" ] ||
       [ ! -f "$tool_stamp" ] ||
       [ "$(cat "$tool_stamp")" != "$expected_tool_stamp" ]; then
      rm -rf "$tool_build_dir"
      BUILD_DIR="$tool_build_dir" \
      ICU_PREFIX="$icu_prefix" \
      OLIPHAUNT_WASM_SHIM_OBJECT="$tool_shim" \
      OLIPHAUNT_WASM_BUILD_PROFILE=release-os \
      OLIPHAUNT_WASM_WASIX_COPT="-O2 -g0" \
      OLIPHAUNT_WASM_WASIX_LOPT="-Wl,--threads=1" \
        ./src/runtimes/liboliphaunt/wasix/assets/build/configure_wasix_dl.sh
      printf "%s\n" "$expected_tool_stamp" > "$tool_stamp"
    fi

    # initdb uses tool-specific symbol rewrites. The isolated build keeps the
    # generic psql closure independent from both initdb and the hot backend.
    make -s -C "$tool_build_dir/src/port" all
    make -s -C "$tool_build_dir/src/common" all
    make -s -C "$tool_build_dir/src/interfaces/libpq" all
    make -s -C "$tool_build_dir/src/fe_utils" all
    make -s -C "$tool_build_dir/src/bin/psql" psql \
      libpq="$tool_build_dir/src/interfaces/libpq/libpq.a" \
      LIBS="$tool_build_dir/src/common/libpgcommon_shlib.a $tool_build_dir/src/common/libpgcommon_excluded_shlib.a $tool_build_dir/src/port/libpgport_shlib.a $ICU_LIBS -lm"
    install -m 0755 \
      "$tool_build_dir/src/bin/psql/psql" \
      "$runtime_build_dir/src/bin/psql/psql"
    if wasixnm -u "$runtime_build_dir/src/bin/psql/psql" | grep -E " PQ[A-Za-z0-9_]+$"; then
      echo "psql still imports libpq symbols; expected standalone WASIX psql" >&2
      exit 1
    fi
  '
