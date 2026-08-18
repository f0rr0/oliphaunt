#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
source "$FRESH_ROOT/lib/wasix-build-lock.sh"

fresh_ensure_dirs
fresh_require_command git

jobs="${JOBS:-$(fresh_jobs)}"
docker_bin="$(fresh_docker_bin)"
fresh_resolve_wasix_core_profile
fresh_lock_wasix_core_build "$WASIX_INSTALL_DIR"

"$FRESH_ROOT/bin/apply-wasix-core-overlay.sh" >/dev/null

if [ ! -f "$WASIX_BUILD_DIR/config.status" ]; then
  "$FRESH_ROOT/bin/build-wasix-core.sh" --configure-only
fi

if ! "$docker_bin" info >/dev/null 2>&1; then
  echo "blocked: Docker daemon is not reachable" >&2
  exit 2
fi
fresh_ensure_docker_image >/dev/null
docker_image_id="$(fresh_wasix_builder_image_id)" || exit 2

if [ "$#" -eq 0 ]; then
  set -- -j "$jobs"
fi

quoted_args=()
for arg in "$@"; do
  quoted_args+=("$(printf '%q' "$arg")")
done
make_args="${quoted_args[*]}"

log="$REPORT_DIR/wasix-make.log"
{
  printf '\n## %s\n\n' "$(fresh_timestamp)"
  printf 'make -C %q %s\n\n' "$WASIX_BUILD_DIR" "$make_args"
} >>"$log"

docker_env=()
if [ -n "${WASIXCC_SYSROOT_PREFIX:-}" ]; then
  docker_env+=(-e "WASIXCC_SYSROOT_PREFIX=$(fresh_docker_path_for "$WASIXCC_SYSROOT_PREFIX")")
fi
if [ -n "${WASIXCC_SYSROOT:-}" ]; then
  docker_env+=(-e "WASIXCC_SYSROOT=$(fresh_docker_path_for "$WASIXCC_SYSROOT")")
fi

"$docker_bin" run --rm \
  -v "$REPO_ROOT:/work" \
  -w /work \
  -e BUILD_DIR="${WASIX_BUILD_DIR#$REPO_ROOT/}" \
  -e WASIXCC_RUN_WASM_OPT="$FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT" \
  -e WASIXCC_WASM_OPT_FLAGS="$FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT_FLAGS" \
  -e WASIXCC_WASM_OPT_SUPPRESS_DEFAULT="$FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT_SUPPRESS_DEFAULT" \
  "${docker_env[@]}" \
  "$docker_image_id" \
  bash -lc "
    set -euo pipefail
    source ./src/runtimes/liboliphaunt/wasix/assets/build/docker_wasix_env.sh
    if [ ! -e \"\$BUILD_DIR/src/include/utils/errcodes.h\" ]; then
      make -C \"\$BUILD_DIR/src/backend\" generated-headers
    fi
    make -C \"\$BUILD_DIR\" $make_args
  " 2>&1 | tee -a "$log"
