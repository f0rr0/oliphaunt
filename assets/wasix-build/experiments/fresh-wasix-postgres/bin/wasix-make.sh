#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

fresh_ensure_dirs
fresh_require_command git

jobs="${JOBS:-$(fresh_jobs)}"
docker_bin="$(fresh_docker_bin)"
fresh_resolve_wasix_core_profile

"$FRESH_ROOT/bin/apply-wasix-core-overlay.sh" >/dev/null

if [ ! -f "$WASIX_BUILD_DIR/config.status" ]; then
  "$FRESH_ROOT/bin/build-wasix-core.sh" --configure-only
fi

if ! "$docker_bin" info >/dev/null 2>&1; then
  echo "blocked: Docker daemon is not reachable" >&2
  exit 2
fi
fresh_ensure_docker_image >/dev/null

make_lock_dir="$FRESH_WORK_ROOT/.wasix-make.lock"
make_lock_waits=0
until mkdir "$make_lock_dir" 2>/dev/null; do
  make_lock_waits=$((make_lock_waits + 1))
  if [ "$make_lock_waits" -gt 600 ]; then
    echo "timed out waiting for WASIX make lock: $make_lock_dir" >&2
    exit 2
  fi
  sleep 0.2
done
trap 'rmdir "$make_lock_dir" 2>/dev/null || true' EXIT

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
  "${docker_env[@]}" \
  "$FRESH_WASIX_DOCKER_IMAGE" \
  bash -lc "
    set -euo pipefail
    source ./assets/wasix-build/docker_wasix_env.sh
    if [ ! -e \"\$BUILD_DIR/src/include/utils/errcodes.h\" ]; then
      make -C \"\$BUILD_DIR/src/backend\" generated-headers
    fi
    make -C \"\$BUILD_DIR\" $make_args
  " 2>&1 | tee -a "$log"
