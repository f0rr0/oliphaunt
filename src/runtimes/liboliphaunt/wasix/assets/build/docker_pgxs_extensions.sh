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
CONTAINER_PLAN="${CONTAINER_PLAN:-/work/src/extensions/generated/pgxs-build.tsv}"
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
      echo "generated PGXS build plan missing: $PLAN" >&2
      exit 1
    fi

    mkdir -p "$BUILD_DIR/src/makefiles" "$BUILD_DIR/install/lib"
    ln -sf "$PGSRC/src/makefiles/pgxs.mk" "$BUILD_DIR/src/makefiles/pgxs.mk"
    ln -sf "$PGSRC/src/Makefile.shlib" "$BUILD_DIR/src/Makefile.shlib"

	    while IFS=$'\''\t'\'' read -r id sql_name source_dir module_file archive stable make_args; do
	      case "$id" in ""|"#"*) continue ;; esac
	      test -n "$sql_name"
	      test -n "$source_dir"
	      extension_source="/work/$source_dir"
	      test -d "$extension_source"
	      extension_dir="$BUILD_DIR/pgxs/$id"
	      rm -rf "$extension_dir"
	      mkdir -p "$(dirname "$extension_dir")"
	      cp -a "$extension_source" "$extension_dir"
	      rm -rf "$extension_dir/.git"
	      extra_make_args=()
	      if [ "${make_args:-"-"}" != "-" ]; then
	        read -r -a extra_make_args <<< "$make_args"
	      fi
	      make -s -C "$extension_dir" \
	        PG_CONFIG="$CONTAINER_ROOT/pg_config_wasix.sh" \
	        clean >/dev/null 2>&1 || true
	      make -s -j"$JOBS" -C "$extension_dir" \
	        PG_CONFIG="$CONTAINER_ROOT/pg_config_wasix.sh" \
	        CPPFLAGS="-I$BUILD_DIR/src/include -I$PGSRC/src/include -I$PGSRC/src/include/port/wasix-dl" \
	        OPTFLAGS="" \
	        "${extra_make_args[@]}" \
	        all
	      if [ "$id" = "age" ] && grep -q "^  PASSEDBYVALUE,$" "$extension_dir/age--1.7.0.sql"; then
	        echo "AGE generated SQL still declares graphid PASSEDBYVALUE on wasm32" >&2
	        exit 1
	      fi
	      if [ "$module_file" = "-" ]; then
	        continue
	      fi
      if [ ! -f "$extension_dir/$module_file" ]; then
        echo "expected WASIX side module missing: $extension_dir/$module_file" >&2
        find "$extension_dir" -maxdepth 1 -type f -name "*.so" -print >&2
        exit 1
      fi
    done < "$PLAN"
  '
