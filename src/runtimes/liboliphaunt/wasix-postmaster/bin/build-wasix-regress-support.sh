#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

force=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --force)
      force=1
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

fresh_ensure_dirs
fresh_require_patched_wasixcc_sysroot

jobs="${JOBS:-$(fresh_jobs)}"
docker_bin="$(fresh_docker_bin)"
fresh_resolve_wasix_core_profile

if [ ! -f "$WASIX_BUILD_DIR/config.status" ] || [ ! -x "$WASIX_INSTALL_DIR/bin/postgres" ]; then
  "$FRESH_ROOT/bin/build-wasix-core.sh" >/dev/null
fi

report="$REPORT_DIR/wasix-regress-support-build.md"
log="$REPORT_DIR/wasix-regress-support-build.log"
signature_file="$WASIX_BUILD_DIR/.fresh-wasix-regress-support-signature"
regress_so="$WASIX_INSTALL_DIR/lib/postgresql/regress.so"
regress_host_dlsuffix_alias="$WASIX_INSTALL_DIR/lib/postgresql/regress.dylib"

source_signature="$(
  {
    printf 'support-script='
    shasum -a 256 "$0"
    printf 'wasix-make='
    shasum -a 256 "$FRESH_ROOT/bin/wasix-make.sh"
    printf 'WASIX_CORE_PROFILE=%s\n' "$WASIX_CORE_PROFILE"
    printf 'WASIXCC_RUN_WASM_OPT=%s\n' "$FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT"
    printf 'WASIXCC_WASM_OPT_FLAGS=%s\n' "$FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT_FLAGS"
    printf 'WASIXCC_WASM_OPT_SUPPRESS_DEFAULT=%s\n' "$FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT_SUPPRESS_DEFAULT"
    printf 'WASIXCC_SYSROOT_PREFIX=%s\n' "${WASIXCC_SYSROOT_PREFIX:-}"
    printf 'WASIXCC_SYSROOT=%s\n' "${WASIXCC_SYSROOT:-}"
    if [ -n "${WASIXCC_SYSROOT_PREFIX:-}" ] && [ -f "$WASIXCC_SYSROOT_PREFIX/.fresh-sysroot-signature" ]; then
      printf 'WASIXCC_SYSROOT_PREFIX_SIGNATURE='
      cat "$WASIXCC_SYSROOT_PREFIX/.fresh-sysroot-signature"
    fi
    if [ -n "${WASIXCC_SYSROOT:-}" ] && [ -f "$WASIXCC_SYSROOT/.fresh-sysroot-signature" ]; then
      printf 'WASIXCC_SYSROOT_SIGNATURE='
      cat "$WASIXCC_SYSROOT/.fresh-sysroot-signature"
    fi
    git -C "$WASIX_SRC_DIR" rev-parse HEAD 2>/dev/null || true
    git -C "$WASIX_SRC_DIR" diff -- \
      src/test/regress \
      src/include \
      src/Makefile.shlib \
      src/makefiles/Makefile.wasix-core \
      src/template/wasix-core
  } | shasum -a 256 | awk '{print $1}'
)"

fresh_write_report_header "$report" "WASIX Regression Support Build"
{
  printf '## Scope\n\n'
  printf -- '- Target: `src/test/regress` loadable support module `regress.so`.\n'
  printf -- '- WASIX core profile: `%s`.\n' "$WASIX_CORE_PROFILE"
  printf -- '- Install path: `%s`.\n' "$regress_so"
  printf -- '- wasixcc sysroot prefix: `%s`.\n' "${WASIXCC_SYSROOT_PREFIX:-}"
  printf -- '- wasixcc sysroot: `%s`.\n\n' "${WASIXCC_SYSROOT:-}"
  printf '## Build Log\n\n'
  printf 'See `%s`.\n' "$log"
} >>"$report"

if [ "$force" -eq 0 ] &&
   [ -f "$signature_file" ] &&
   [ "$(cat "$signature_file")" = "$source_signature" ] &&
   [ -f "$regress_so" ] &&
   [ -f "$regress_host_dlsuffix_alias" ]; then
  {
    printf '\n## Result\n\n'
    printf -- '- Status: `pass`\n'
    printf -- '- Cached: `true`\n'
  } >>"$report"
  printf 'WASIX regress support is current at %s\n' "$regress_so"
  exit 0
fi

: >"$log"
if ! "$docker_bin" info >>"$log" 2>&1; then
  {
    printf '\n## Result\n\n'
    printf -- '- Status: `blocked`\n'
    printf -- '- Blocker: Docker daemon is not reachable.\n'
  } >>"$report"
  printf 'blocked: Docker daemon is not reachable; see %s\n' "$log" >&2
  exit 2
fi

set +e
fresh_ensure_docker_image >>"$log" 2>&1
image_status=$?
set -e
if [ "$image_status" -ne 0 ]; then
  {
    printf '\n## Result\n\n'
    printf -- '- Status: `fail`\n'
    printf -- '- Exit code: `%s`\n' "$image_status"
    printf -- '- Failure: could not prepare Docker image `%s`.\n' "$FRESH_WASIX_DOCKER_IMAGE"
  } >>"$report"
  printf 'WASIX Docker image preparation failed; see %s\n' "$log" >&2
  exit "$image_status"
fi
docker_image_id="$(fresh_wasix_builder_image_id)" || exit 2

docker_env=()
if [ -n "${WASIXCC_SYSROOT_PREFIX:-}" ]; then
  docker_env+=(-e "WASIXCC_SYSROOT_PREFIX=$(fresh_docker_path_for "$WASIXCC_SYSROOT_PREFIX")")
fi
if [ -n "${WASIXCC_SYSROOT:-}" ]; then
  docker_env+=(-e "WASIXCC_SYSROOT=$(fresh_docker_path_for "$WASIXCC_SYSROOT")")
fi

set +e
"$docker_bin" run --rm \
  -v "$REPO_ROOT:/work" \
  -w /work \
  -e JOBS="$jobs" \
  -e BUILD_DIR="${WASIX_BUILD_DIR#$REPO_ROOT/}" \
  -e INSTALL_DIR="${WASIX_INSTALL_DIR#$REPO_ROOT/}" \
  -e WASIXCC_RUN_WASM_OPT="$FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT" \
  -e WASIXCC_WASM_OPT_FLAGS="$FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT_FLAGS" \
  -e WASIXCC_WASM_OPT_SUPPRESS_DEFAULT="$FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT_SUPPRESS_DEFAULT" \
  -e "HOST_UID=$(id -u)" \
  -e "HOST_GID=$(id -g)" \
  "${docker_env[@]}" \
  "$docker_image_id" \
  bash -lc '
    set -euo pipefail
    source ./src/runtimes/liboliphaunt/wasix/assets/build/docker_wasix_env.sh
    restore_host_ownership() {
      local command_status="$?"
      local ownership_failed=0
      local output_path

      trap - EXIT
      for output_path in \
        "/work/$BUILD_DIR/src/test/regress" \
        "/work/$INSTALL_DIR/lib/postgresql"; do
        if [ -e "$output_path" ] && ! chown -R "$HOST_UID:$HOST_GID" "$output_path"; then
          printf "failed to restore host ownership for %s\n" "$output_path" >&2
          ownership_failed=1
        fi
      done
      if [ "$command_status" -eq 0 ] && [ "$ownership_failed" -ne 0 ]; then
        command_status="$ownership_failed"
      fi
      exit "$command_status"
    }
    trap restore_host_ownership EXIT

    if [ ! -e "$BUILD_DIR/src/include/utils/errcodes.h" ]; then
      make -C "$BUILD_DIR/src/backend" generated-headers
    fi
    make -C "$BUILD_DIR/src/test/regress" clean-lib
    make -C "$BUILD_DIR/src/test/regress" -j "$JOBS" all-lib
    make -C "$BUILD_DIR/src/test/regress" install-lib DESTDIR="/work/$INSTALL_DIR"
    test -f "/work/$INSTALL_DIR/lib/postgresql/regress.so"
    cp -f \
      "/work/$INSTALL_DIR/lib/postgresql/regress.so" \
      "/work/$INSTALL_DIR/lib/postgresql/regress.dylib"
  ' >>"$log" 2>&1
status=$?
set -e

if [ "$status" -eq 0 ]; then
  printf '%s' "$source_signature" >"$signature_file"
  {
    printf '\n## Result\n\n'
    printf -- '- Status: `pass`\n'
    printf -- '- Cached: `false`\n'
    printf -- '- Installed module: `%s`\n' "$regress_so"
    printf -- '- Host pg_regress dlsuffix alias: `%s`\n' "$regress_host_dlsuffix_alias"
  } >>"$report"
  printf 'built WASIX regress support at %s\n' "$regress_so"
else
  {
    printf '\n## Result\n\n'
    printf -- '- Status: `fail`\n'
    printf -- '- Exit code: `%s`\n\n' "$status"
    printf 'Treat this as an extension-loading/build blocker, not a PostgreSQL test skip.\n'
  } >>"$report"
  printf 'WASIX regress support build failed; see %s\n' "$log" >&2
  exit "$status"
fi
