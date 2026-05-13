#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

configure_only=0
force_clean=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --configure-only)
      configure_only=1
      ;;
    --clean)
      force_clean=1
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

fresh_ensure_dirs
fresh_require_command git

if [ -n "${FRESH_PINNED_WASIX_INSTALL_DIR:-}" ] && [ "$WASIX_INSTALL_DIR" = "$FRESH_PINNED_WASIX_INSTALL_DIR" ] && [ "${FRESH_ALLOW_PINNED_INSTALL_WRITE:-0}" != "1" ]; then
  {
    printf 'refusing to build into pinned WASIX install: %s\n' "$FRESH_PINNED_WASIX_INSTALL_DIR"
    printf 'Unset FRESH_PINNED_WASIX_INSTALL_DIR or set FRESH_ALLOW_PINNED_INSTALL_WRITE=1 if you are intentionally replacing the pin.\n'
  } >&2
  exit 2
fi

jobs="${JOBS:-$(fresh_jobs)}"
docker_bin="$(fresh_docker_bin)"
fresh_resolve_wasix_core_profile
wasix_core_cflags="$FRESH_WASIX_CORE_EFFECTIVE_CFLAGS"
wasix_core_ldflags="$FRESH_WASIX_CORE_EFFECTIVE_LDFLAGS"
wasixcc_run_wasm_opt="$FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT"
wasixcc_wasm_opt_flags="$FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT_FLAGS"

"$FRESH_ROOT/bin/apply-wasix-core-overlay.sh" >/dev/null

source_signature="$(
  {
    cat "$WASIX_SRC_DIR/.fresh-wasix-core-signature"
    shasum -a 256 "$0"
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
    printf 'WASIX_CORE_PROFILE=%s\n' "$WASIX_CORE_PROFILE"
    printf 'WASIX_CORE_CFLAGS=%s\n' "$wasix_core_cflags"
    printf 'WASIX_CORE_LDFLAGS=%s\n' "$wasix_core_ldflags"
    printf 'WASIXCC_RUN_WASM_OPT=%s\n' "$wasixcc_run_wasm_opt"
    printf 'WASIXCC_WASM_OPT_FLAGS=%s\n' "$wasixcc_wasm_opt_flags"
    git -C "$WASIX_SRC_DIR" diff -- \
      src/include \
      src/template \
      src/makefiles \
      src/backend/port \
      src/backend/utils/mb/conversion_procs \
      src/interfaces/libpq/Makefile
  } | shasum -a 256 | awk '{print $1}'
)"
build_signature_file="$WASIX_BUILD_DIR/.fresh-wasix-core-build-signature"
if [ "$force_clean" -eq 0 ] && [ -f "$build_signature_file" ] && [ "$(cat "$build_signature_file")" = "$source_signature" ]; then
  mkdir -p "$WASIX_BUILD_DIR" "$WASIX_INSTALL_DIR"
else
  rm -rf "$WASIX_BUILD_DIR"
  mkdir -p "$WASIX_BUILD_DIR" "$WASIX_INSTALL_DIR"
  printf '%s' "$source_signature" >"$build_signature_file"
fi

report="$REPORT_DIR/wasix-core-build.md"
log="$REPORT_DIR/wasix-core-build.log"
fresh_write_report_header "$report" "WASIX Core PostgreSQL Build"

{
  printf '## Scope\n\n'
  printf -- '- Source: clean PostgreSQL `%s` plus `overlays/wasix-core`.\n' "$POSTGRES_TAG"
  printf -- '- Template: `--with-template=wasix-core`.\n'
  printf -- '- Build profile: `%s`.\n' "$WASIX_CORE_PROFILE"
  printf -- '- Profile description: `%s`.\n' "$FRESH_WASIX_CORE_PROFILE_DESCRIPTION"
  printf -- '- Build lane: optimized core server/tools, PL/pgSQL, snowball dictionary, and core encoding conversion modules; no contrib or regression test binaries.\n'
  printf -- '- wasixcc sysroot prefix: `%s`.\n' "${WASIXCC_SYSROOT_PREFIX:-}"
  printf -- '- wasixcc sysroot: `%s`.\n' "${WASIXCC_SYSROOT:-}"
  printf -- '- Build directory: `%s`.\n' "$WASIX_BUILD_DIR"
  printf -- '- Install directory: `%s`.\n' "$WASIX_INSTALL_DIR"
  printf -- '- CFLAGS: `%s`.\n' "$wasix_core_cflags"
  printf -- '- LDFLAGS: `%s`.\n' "$wasix_core_ldflags"
  printf -- '- wasixcc wasm-opt: `%s`.\n' "$wasixcc_run_wasm_opt"
  printf -- '- wasixcc wasm-opt flags: `%s`.\n' "$wasixcc_wasm_opt_flags"
  printf -- '- Configure wasm-opt: `no`.\n'
  printf -- '- Largefile support: not disabled.\n'
  printf -- '- Spinlocks: not disabled.\n'
  printf -- '- PGlite compatibility macros: not used.\n\n'
  printf '## Build Log\n\n'
  printf 'See `%s`.\n' "$log"
} >>"$report"

mode="build"
if [ "$configure_only" -eq 1 ]; then
  mode="configure-only"
fi

: >"$log"
if ! "$docker_bin" info >>"$log" 2>&1; then
  {
    printf '\n## Result\n\n'
    printf -- '- Status: `blocked`\n'
    printf -- '- Mode: `%s`\n' "$mode"
    printf -- '- Blocker: Docker daemon is not reachable.\n\n'
    printf 'Start Docker or run this script inside an environment with the pinned WASIX toolchain already available.\n'
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
    printf -- '- Mode: `%s`\n' "$mode"
    printf -- '- Exit code: `%s`\n' "$image_status"
    printf -- '- Failure: could not prepare Docker image `%s`.\n' "$FRESH_WASIX_DOCKER_IMAGE"
  } >>"$report"
  printf 'WASIX Docker image preparation failed; see %s\n' "$log" >&2
  exit "$image_status"
fi

set +e
printf '\n## docker run\n\n' >>"$log"
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
  -e JOBS="$jobs" \
  -e PGSRC="${WASIX_SRC_DIR#$REPO_ROOT/}" \
  -e BUILD_DIR="${WASIX_BUILD_DIR#$REPO_ROOT/}" \
  -e INSTALL_DIR="${WASIX_INSTALL_DIR#$REPO_ROOT/}" \
  -e MODE="$mode" \
  -e WASIX_CORE_CFLAGS="$wasix_core_cflags" \
  -e WASIX_CORE_LDFLAGS="$wasix_core_ldflags" \
  -e WASIXCC_RUN_WASM_OPT="$wasixcc_run_wasm_opt" \
  -e WASIXCC_WASM_OPT_FLAGS="$wasixcc_wasm_opt_flags" \
  "${docker_env[@]}" \
  "$FRESH_WASIX_DOCKER_IMAGE" \
  bash -lc '
    set -euo pipefail
    source ./assets/wasix-build/docker_wasix_env.sh
    cd /work
    mkdir -p "$BUILD_DIR" "$INSTALL_DIR"
    cd "$BUILD_DIR"
    configure_args=(
      "--prefix=/"
      "--bindir=/bin"
      "--libdir=/lib"
      "--datadir=/share/postgresql"
      "--host=wasm32-wasix"
      "--with-template=wasix-core"
      "--without-readline"
      "--without-icu"
      "--without-zlib"
      "--without-llvm"
      "--without-pam"
      "--with-openssl=no"
    )
    if [ ! -f config.status ]; then
      WASIXCC_RUN_WASM_OPT=no \
      CC=wasixcc \
      AR=wasixar \
      RANLIB=wasixranlib \
      NM=wasixnm \
      CPPFLAGS="-D_GNU_SOURCE" \
      CFLAGS="$WASIX_CORE_CFLAGS" \
      LDFLAGS="$WASIX_CORE_LDFLAGS" \
      "/work/$PGSRC/configure" "${configure_args[@]}"
    fi
    if [ "$MODE" = "configure-only" ]; then
      exit 0
    fi
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
    rm -f \
      src/backend/postgres \
      src/bin/initdb/initdb \
      src/bin/pg_ctl/pg_ctl \
      src/bin/psql/psql \
      src/bin/pg_dump/pg_dump \
      src/bin/pg_dump/pg_restore \
      src/bin/pg_dump/pg_dumpall \
      src/bin/pg_config/pg_config
    for dir in "${core_dirs[@]}"; do
      make -C "$dir" -j "$JOBS" all
    done
    rm -rf "/work/$INSTALL_DIR"
    mkdir -p "/work/$INSTALL_DIR"
    for dir in "${core_dirs[@]}"; do
      make -C "$dir" -j "$JOBS" install DESTDIR="/work/$INSTALL_DIR"
    done
  ' >>"$log" 2>&1
status=$?
set -e

if [ "$status" -eq 0 ]; then
  {
    printf '\n## Result\n\n'
    printf -- '- Status: `pass`\n'
    printf -- '- Mode: `%s`\n' "$mode"
    printf -- '- Build directory: `%s`\n' "$WASIX_BUILD_DIR"
    printf -- '- Install directory: `%s`\n' "$WASIX_INSTALL_DIR"
  } >>"$report"
  printf 'built WASIX core PostgreSQL lane at %s\n' "$WASIX_INSTALL_DIR"
else
  {
    printf '\n## Result\n\n'
    printf -- '- Status: `fail`\n'
    printf -- '- Mode: `%s`\n' "$mode"
    printf -- '- Exit code: `%s`\n\n' "$status"
    printf '## Blocker Policy\n\n'
    printf 'Treat this as a PostgreSQL/WASIX/toolchain compatibility blocker. Do not add fake PostgreSQL success shims to make this pass.\n'
  } >>"$report"
  printf 'WASIX core build failed; see %s\n' "$log" >&2
  exit "$status"
fi
