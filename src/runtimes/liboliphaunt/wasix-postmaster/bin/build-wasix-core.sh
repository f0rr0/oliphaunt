#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
source "$FRESH_ROOT/lib/wasix-build-lock.sh"

configure_only=0
force_clean=0
portable_inputs="${OLIPHAUNT_WASIX_POSTMASTER_PORTABLE_INPUTS:-0}"
case "$portable_inputs" in
  0|1) ;;
  *)
    echo 'OLIPHAUNT_WASIX_POSTMASTER_PORTABLE_INPUTS must be 0 or 1' >&2
    exit 2
    ;;
esac
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

case "${WASIX_CORE_CHILD_BACKEND:-exec}" in
  exec|exec-backend)
    wasix_core_child_backend="exec"
    ;;
  *)
    printf 'unsupported WASIX_CORE_CHILD_BACKEND=%s; expected exec\n' \
      "$WASIX_CORE_CHILD_BACKEND" >&2
    exit 2
    ;;
esac

if [ "$portable_inputs" -eq 1 ]; then
  [ "$force_clean" -eq 0 ] || {
    echo '--clean is incompatible with portable PostgreSQL build inputs' >&2
    exit 2
  }
  guest_receipt="$WASIX_INSTALL_DIR/guest-build.receipt"
  [ -f "$guest_receipt" ] && [ ! -L "$guest_receipt" ] || {
    printf 'missing portable PostgreSQL guest receipt: %s\n' "$guest_receipt" >&2
    exit 2
  }
  expected_guest_identity="$(
    fresh_manifest_value "$guest_receipt" installed_closure_sha256
  )"
  actual_guest_identity="$(
    python3 "$FRESH_ROOT/lib/guest_build_provenance.py" identity \
      "$WASIX_INSTALL_DIR"
  )"
  [ "$actual_guest_identity" = "$expected_guest_identity" ] || {
    echo 'portable PostgreSQL guest differs from its build receipt' >&2
    exit 2
  }
  [ "$(fresh_manifest_value "$guest_receipt" core_profile)" = \
    "$WASIX_CORE_PROFILE" ] || {
    echo 'portable PostgreSQL guest profile differs from the selected product profile' >&2
    exit 2
  }
  printf 'validated portable PostgreSQL guest: %s\n' "$WASIX_INSTALL_DIR"
  exit 0
fi

managed_work_probe="$FRESH_WORK_ROOT/.managed-path-boundary"
fresh_require_managed_generated_path "$managed_work_probe" FRESH_WORK_ROOT
fresh_require_managed_generated_path "$WASIX_BUILD_DIR" WASIX_BUILD_DIR
fresh_require_managed_generated_path "$WASIX_INSTALL_DIR" WASIX_INSTALL_DIR
fresh_require_managed_generated_path "$REPORT_DIR" REPORT_DIR
fresh_require_managed_generated_path "$RUN_DIR" RUN_DIR

fresh_ensure_dirs
fresh_require_command git
fresh_require_command python3

durable_publication="$FRESH_ROOT/lib/durable_publication.py"
[ -f "$durable_publication" ] && [ ! -L "$durable_publication" ] || {
  printf 'missing regular durable-publication helper: %s\n' "$durable_publication" >&2
  exit 2
}

if [ -n "${FRESH_PINNED_WASIX_INSTALL_DIR:-}" ] && [ "$WASIX_INSTALL_DIR" = "$FRESH_PINNED_WASIX_INSTALL_DIR" ] && [ "${FRESH_ALLOW_PINNED_INSTALL_WRITE:-0}" != "1" ]; then
  {
    printf 'refusing to build into pinned WASIX install: %s\n' "$FRESH_PINNED_WASIX_INSTALL_DIR"
    printf 'Unset FRESH_PINNED_WASIX_INSTALL_DIR or set FRESH_ALLOW_PINNED_INSTALL_WRITE=1 if you are intentionally replacing the pin.\n'
  } >&2
  exit 2
fi

# Serialize the complete producer, including configuration, sealing, and
# receipt publication.  Every profile and wasix-make.sh acquires this same
# product-wide lock because the default profiles share one mutable source tree.
fresh_lock_wasix_core_build "$WASIX_INSTALL_DIR"

jobs="${JOBS:-$(fresh_jobs)}"
docker_bin="$(fresh_docker_bin)"
fresh_resolve_wasix_core_profile
wasix_core_cflags="$FRESH_WASIX_CORE_EFFECTIVE_CFLAGS"
wasix_core_ldflags="$FRESH_WASIX_CORE_EFFECTIVE_LDFLAGS"
wasix_core_latch_state_contract="packed-atomic-v1"
wasixcc_run_wasm_opt="$FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT"
wasixcc_wasm_opt_flags="$FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT_FLAGS"
wasixcc_wasm_opt_suppress_default="$FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT_SUPPRESS_DEFAULT"
expected_atomic_fence_total="$FRESH_WASIX_CORE_EXPECTED_ATOMIC_FENCE_TOTAL"
expected_final_atomic_fence_total="$FRESH_WASIX_CORE_EXPECTED_FINAL_ATOMIC_FENCE_TOTAL"

wasix_core_cflags="$wasix_core_cflags -DPG_WASIX_ATOMIC_LATCH_STATE=1"

"$FRESH_ROOT/bin/apply-wasix-core-overlay.sh" >/dev/null
postgres_worktree_signature="$WASIX_SRC_DIR/.fresh-wasix-core-signature"
postgres_worktree_state="$(
  fresh_git_worktree_state_sha256 "$WASIX_SRC_DIR" ".fresh-wasix-core-signature"
)" || exit
fresh_require_manifest_value "$postgres_worktree_signature" \
  worktree_state_sha256 "$postgres_worktree_state" || exit

compute_source_signature() {
  local worktree_state="$1"
  local builder_image_id="$2"

  {
    cat "$postgres_worktree_signature"
    shasum -a 256 "$0"
    shasum -a 256 \
      "$FRESH_ROOT/bin/apply-wasix-core-overlay.sh" \
      "$FRESH_ROOT/lib/common.sh" \
      "$FRESH_ROOT/lib/wasix-build-lock.sh" \
      "$FRESH_ROOT/runtime/bin/verify-postmaster-wasm-import.py" \
      "$FRESH_ROOT/runtime/bin/verify-postmaster-concurrency-contract.py" \
      "$FRESH_ROOT/bin/seal-wasix-core-exports.sh" \
      "$FRESH_ROOT/bin/seal-wasix-linear-memory.sh" \
      "$FRESH_ROOT/lib/guest_build_provenance.py" \
      "$FRESH_ROOT/lib/linear_memory_transaction.py" \
      "$FRESH_ROOT/lib/sealed_export_chain.py" \
      "$FRESH_ROOT/runtime/policies/sealed-main-runtime-exports.v1.txt" \
      "$FRESH_ROOT/runtime/policies/sealed-main-dlsym-exports.v1.txt" \
      "$FRESH_ROOT/runtime/policies/sealed-side-modules.v1.tsv" \
      "$FRESH_ROOT/tools/sealed-export-closure/Cargo.toml" \
      "$FRESH_ROOT/tools/sealed-export-closure/Cargo.lock" \
      "$FRESH_ROOT/tools/sealed-export-closure/src/main.rs" \
      "$durable_publication"
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
    printf 'WASIX_CORE_CHILD_BACKEND=%s\n' "$wasix_core_child_backend"
    printf 'WASIX_CORE_LATCH_STATE_CONTRACT=%s\n' "$wasix_core_latch_state_contract"
    printf 'WASIX_CORE_CFLAGS=%s\n' "$wasix_core_cflags"
    printf 'WASIX_CORE_LDFLAGS=%s\n' "$wasix_core_ldflags"
    printf 'WASIXCC_RUN_WASM_OPT=%s\n' "$wasixcc_run_wasm_opt"
    printf 'WASIXCC_WASM_OPT_FLAGS=%s\n' "$wasixcc_wasm_opt_flags"
    printf 'WASIXCC_WASM_OPT_SUPPRESS_DEFAULT=%s\n' "$wasixcc_wasm_opt_suppress_default"
    printf 'EXPECTED_ATOMIC_FENCE_TOTAL=%s\n' "${expected_atomic_fence_total:-profile-unlocked}"
    printf 'EXPECTED_FINAL_ATOMIC_FENCE_TOTAL=%s\n' \
      "${expected_final_atomic_fence_total:-profile-unlocked}"
    printf 'LINEAR_MEMORY_PROFILE_ID=%s\n' "$FRESH_LINEAR_MEMORY_PROFILE_ID"
    printf 'LINEAR_MEMORY_MAXIMUM_PAGES=%s\n' "$FRESH_LINEAR_MEMORY_MAXIMUM_PAGES"
    printf 'LINEAR_MEMORY_STATIC_BOUND_PAGES=%s\n' "$FRESH_LINEAR_MEMORY_STATIC_BOUND_PAGES"
    printf 'LINEAR_MEMORY_STATIC_OFFSET_GUARD_BYTES=%s\n' \
      "$FRESH_LINEAR_MEMORY_STATIC_OFFSET_GUARD_BYTES"
    printf 'DOCKER_IMAGE_ID=%s\n' "$builder_image_id"
    printf 'POSTGRES_WORKTREE_STATE=%s\n' "$worktree_state"
  } | shasum -a 256 | awk '{print $1}'
}

build_signature_file="$WASIX_BUILD_DIR/.fresh-wasix-core-build-signature"
fresh_require_managed_generated_path "$build_signature_file" wasix-core-build-signature

require_build_inputs_unchanged() {
  local context="$1"
  local current_source_signature
  local current_postgres_worktree_state

  [ -f "$build_signature_file" ] && [ ! -L "$build_signature_file" ] &&
    [ "$(cat "$build_signature_file")" = "$source_signature" ] || {
    printf 'WASIX core build signature changed %s\n' "$context" >&2
    return 125
  }
  current_postgres_worktree_state="$(
    fresh_git_worktree_state_sha256 \
      "$WASIX_SRC_DIR" ".fresh-wasix-core-signature"
  )" || return 125
  [ "$current_postgres_worktree_state" = "$postgres_worktree_state" ] || {
    printf 'WASIX core PostgreSQL source changed %s\n' "$context" >&2
    return 125
  }
  current_source_signature="$(
    compute_source_signature "$current_postgres_worktree_state" "$docker_image_id"
  )" || return 125
  fresh_is_sha256 "$current_source_signature" || return 125
  [ "$current_source_signature" = "$source_signature" ] || {
    printf 'WASIX core build input changed %s\n' "$context" >&2
    return 125
  }
}

report="$REPORT_DIR/wasix-core-build.md"
log="$REPORT_DIR/wasix-core-build.log"
fresh_require_managed_generated_path "$report" wasix-core-build-report
fresh_require_managed_generated_path "$log" wasix-core-build-log
fresh_write_report_header "$report" "WASIX Core PostgreSQL Build"

{
  printf '## Scope\n\n'
  printf -- '- Source: clean PostgreSQL `%s` plus `postgres/overlays/wasix-core` and the explicit patch series.\n' "$POSTGRES_TAG"
  printf -- '- Template: `--with-template=wasix-core`.\n'
  printf -- '- Build profile: `%s`.\n' "$WASIX_CORE_PROFILE"
  printf -- '- Profile description: `%s`.\n' "$FRESH_WASIX_CORE_PROFILE_DESCRIPTION"
  printf -- '- Child backend: `%s`.\n' "$wasix_core_child_backend"
  printf -- '- Shared latch state contract: `%s`.\n' "$wasix_core_latch_state_contract"
  printf -- '- Build lane: optimized core server/tools, PL/pgSQL, snowball dictionary, and core encoding conversion modules; no contrib or regression test binaries.\n'
  printf -- '- wasixcc sysroot prefix: `%s`.\n' "${WASIXCC_SYSROOT_PREFIX:-}"
  printf -- '- wasixcc sysroot: `%s`.\n' "${WASIXCC_SYSROOT:-}"
  printf -- '- Build directory: `%s`.\n' "$WASIX_BUILD_DIR"
  printf -- '- Install directory: `%s`.\n' "$WASIX_INSTALL_DIR"
  printf -- '- CFLAGS: `%s`.\n' "$wasix_core_cflags"
  printf -- '- LDFLAGS: `%s`.\n' "$wasix_core_ldflags"
  printf -- '- wasixcc wasm-opt: `%s`.\n' "$wasixcc_run_wasm_opt"
  printf -- '- wasixcc wasm-opt flags: `%s`.\n' "$wasixcc_wasm_opt_flags"
  printf -- '- wasixcc suppress implicit wasm-opt defaults: `%s`.\n' "$wasixcc_wasm_opt_suppress_default"
  printf -- '- Final-module critical fence contract: `SetLatch=2`, `ResetLatch=1`, and `WaitEventSetWait=1`.\n'
  printf -- '- Main export policy: exact typed packaged-side closure, followed only by Binaryen module-element reachability DCE and final proof replay.\n'
  printf -- '- Linear-memory ABI: `%s` (bounded 256 MiB guest maximum; 64-bit-host static lowering only).\n' "$FRESH_LINEAR_MEMORY_PROFILE_ID"
  printf -- '- Profile-locked pre-seal fence inventory: `%s`.\n' "${expected_atomic_fence_total:-critical-functions-only}"
  printf -- '- Profile-locked final sealed-module fence inventory: `%s`.\n' \
    "${expected_final_atomic_fence_total:-critical-functions-only}"
  printf -- '- Configure wasm-opt: `no`.\n'
  printf -- '- Largefile support: not disabled.\n'
  printf -- '- Spinlocks: not disabled.\n'
  printf -- '- Single-user compatibility macros: not used.\n\n'
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
docker_image_id="$(fresh_wasix_builder_image_id)" || {
  printf 'WASIX Docker image identity lookup failed; see %s\n' "$log" >&2
  exit 2
}
{
  printf '\n## Immutable Builder\n\n'
  printf -- '- Image reference: `%s`\n' "$FRESH_WASIX_DOCKER_IMAGE"
  printf -- '- Image ID: `%s`\n' "$docker_image_id"
} >>"$report"

# The immutable builder is an input, not merely the transport used to execute
# the build. Resolve it before deciding whether an existing build directory is
# reusable, and bind that exact identity into every later provenance record.
source_signature="$(
  compute_source_signature "$postgres_worktree_state" "$docker_image_id"
)"
fresh_is_sha256 "$source_signature" || {
  printf 'could not derive WASIX core source signature\n' >&2
  exit 125
}
if [ "$force_clean" -eq 0 ] && [ -f "$build_signature_file" ] && \
  [ "$(cat "$build_signature_file")" = "$source_signature" ]; then
  mkdir -p "$WASIX_BUILD_DIR" "$WASIX_INSTALL_DIR"
else
  fresh_require_managed_generated_path "$WASIX_BUILD_DIR" WASIX_BUILD_DIR
  fresh_require_managed_generated_path "$WASIX_INSTALL_DIR" WASIX_INSTALL_DIR
  rm -rf "$WASIX_BUILD_DIR" "$WASIX_INSTALL_DIR"
  mkdir -p "$WASIX_BUILD_DIR" "$WASIX_INSTALL_DIR"
  printf '%s' "$source_signature" >"$build_signature_file"
fi

if ! DOCKER_IMAGE="$FRESH_WASIX_DOCKER_IMAGE" \
  "$FRESH_ROOT/runtime/bin/validate-runtime-capabilities.sh" --validate-sysroot-only >>"$log" 2>&1; then
  {
    printf '\n## Result\n\n'
    printf -- '- Status: `fail`\n'
    printf -- '- Mode: `%s`\n' "$mode"
    printf -- '- Failure: exact patched WASIX libc carrier validation failed.\n'
  } >>"$report"
  printf 'WASIX libc carrier validation failed; see %s\n' "$log" >&2
  exit 2
fi

fresh_require_managed_generated_path "$WASIX_BUILD_DIR" WASIX_BUILD_DIR
fresh_require_managed_generated_path "$WASIX_INSTALL_DIR" WASIX_INSTALL_DIR
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
  -e WASIXCC_WASM_OPT_SUPPRESS_DEFAULT="$wasixcc_wasm_opt_suppress_default" \
  -e EXPECTED_ATOMIC_FENCE_TOTAL="$expected_atomic_fence_total" \
  -e WASIX_CORE_LATCH_STATE_CONTRACT="$wasix_core_latch_state_contract" \
  -e "HOST_UID=$(id -u)" \
  -e "HOST_GID=$(id -g)" \
  "${docker_env[@]}" \
  "$docker_image_id" \
  bash -lc '
    set -euo pipefail
    source ./src/runtimes/liboliphaunt/wasix/assets/build/docker_wasix_env.sh
    cd /work

    restore_host_ownership() {
      local command_status="$?"
      local ownership_failed=0
      local output_path

      trap - EXIT
      for output_path in "/work/$BUILD_DIR" "/work/$INSTALL_DIR"; do
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
    if ! grep -Fxq "#define HAVE_SYNC_FILE_RANGE 1" src/include/pg_config.h; then
      printf "configured PostgreSQL does not define HAVE_SYNC_FILE_RANGE=1; refuse the fallback build\n" >&2
      exit 2
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
    make -C src/backend -j "$JOBS" generated-headers
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
    python3 \
      /work/src/runtimes/liboliphaunt/wasix-postmaster/runtime/bin/verify-postmaster-wasm-import.py \
      "/work/$INSTALL_DIR/bin/postgres"
    concurrency_args=()
    if [ -n "$EXPECTED_ATOMIC_FENCE_TOTAL" ]; then
      concurrency_args+=(--expected-total "$EXPECTED_ATOMIC_FENCE_TOTAL")
    fi
    if [ "$WASIX_CORE_LATCH_STATE_CONTRACT" = packed-atomic-v1 ]; then
      concurrency_args+=(
        --latch-state-contract packed-atomic-v1
        --wasm-dis /opt/wasixcc-home/.wasixcc/binaryen/bin/wasm-dis
      )
    fi
    python3 \
      /work/src/runtimes/liboliphaunt/wasix-postmaster/runtime/bin/verify-postmaster-concurrency-contract.py \
      "${concurrency_args[@]}" \
      "/work/$INSTALL_DIR/bin/postgres"
  ' >>"$log" 2>&1
status=$?
set -e

if [ "$status" -eq 0 ] && [ "$mode" = build ] && \
  [ "$wasix_core_latch_state_contract" = packed-atomic-v1 ]
then
  if [ -z "$expected_atomic_fence_total" ] || \
    [ -z "$expected_final_atomic_fence_total" ]; then
    printf 'sealed export closure requires profile-locked pre-seal and final atomic fence totals\n' >>"$log"
    status=2
  else
    set +e
    (
      set -euo pipefail

      "$FRESH_ROOT/bin/seal-wasix-core-exports.sh" \
        --install-dir "$WASIX_INSTALL_DIR" \
        --expected-total "$expected_final_atomic_fence_total"

      sealed_export_receipt="$WASIX_INSTALL_DIR/share/postgresql/wasix-postmaster.sealed-export.structure.receipt"
      "$FRESH_ROOT/bin/seal-wasix-linear-memory.sh" \
        --install-dir "$WASIX_INSTALL_DIR" \
        --predecessor-receipt "$sealed_export_receipt"

      python3 "$FRESH_ROOT/runtime/bin/verify-postmaster-wasm-import.py" \
        "$WASIX_INSTALL_DIR/bin/postgres"
      fresh_require_start_proof_tool \
        "$FRESH_START_PROOF_BIN" \
        "$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT"

      proof_dir="$WASIX_INSTALL_DIR/share/postgresql"
      final_start_proof="$proof_dir/wasix-postmaster.start-proof.json"
      final_start_proof_pending="$proof_dir/.wasix-postmaster.start-proof.pending"
      final_concurrency_receipt="$proof_dir/wasix-postmaster.final-wasm-concurrency.receipt"
      final_concurrency_receipt_pending="$proof_dir/.wasix-postmaster.final-wasm-concurrency.pending"
      [ -d "$proof_dir" ] && [ ! -L "$proof_dir" ] || {
        printf 'unsafe final-proof directory: %s\n' "$proof_dir" >&2
        exit 2
      }
      python3 "$durable_publication" discard-private "$final_start_proof_pending"
      python3 "$durable_publication" discard-private "$final_concurrency_receipt_pending"
      cleanup_final_proof_stage() {
        status=$?
        trap - EXIT
        python3 "$durable_publication" discard-private \
          "$final_start_proof_pending" || status=2
        python3 "$durable_publication" discard-private \
          "$final_concurrency_receipt_pending" || status=2
        exit "$status"
      }
      trap cleanup_final_proof_stage EXIT

      docker_install_dir="$(fresh_docker_path_for "$WASIX_INSTALL_DIR")"

      validate_final_proof_generation() {
        "$FRESH_START_PROOF_BIN" "$WASIX_INSTALL_DIR/bin/postgres" \
          | python3 "$durable_publication" write-stdin \
            "$final_start_proof_pending"
        [ -s "$final_start_proof_pending" ] && \
          [ ! -L "$final_start_proof_pending" ] || {
          printf 'deterministic-start analyzer did not produce a regular proof\n' >&2
          return 2
        }
        python3 "$durable_publication" require-equal \
          "$final_start_proof_pending" "$final_start_proof"
        python3 "$durable_publication" discard-private "$final_start_proof_pending"
        python3 \
          "$FRESH_ROOT/runtime/bin/verify-postmaster-concurrency-contract.py" \
          --expected-total "$expected_final_atomic_fence_total" \
          --latch-state-contract packed-atomic-v1 \
          --verified-receipt "$final_concurrency_receipt" \
          --receipt-only \
          "$WASIX_INSTALL_DIR/bin/postgres"
      }

      if [ -e "$final_concurrency_receipt" ] || \
        [ -L "$final_concurrency_receipt" ]
      then
        [ -f "$final_concurrency_receipt" ] && \
          [ ! -L "$final_concurrency_receipt" ] || {
          printf 'final concurrency admission is not regular: %s\n' \
            "$final_concurrency_receipt" >&2
          exit 2
        }
        [ -f "$final_start_proof" ] && [ ! -L "$final_start_proof" ] || {
          printf 'admitted final generation has no regular start proof: %s\n' \
            "$final_start_proof" >&2
          exit 2
        }
        validate_final_proof_generation
      else
        final_start_proof_identity="$(
          "$FRESH_START_PROOF_BIN" "$WASIX_INSTALL_DIR/bin/postgres" |
            python3 "$durable_publication" write-stdin-identified \
              "$final_start_proof_pending"
        )"
        IFS=$'\t' read -r final_start_proof_dev final_start_proof_ino \
          final_start_proof_size final_start_proof_sha \
          <<<"$final_start_proof_identity"
        [ -s "$final_start_proof_pending" ] && \
          [ ! -L "$final_start_proof_pending" ] || {
          printf 'deterministic-start analyzer did not produce a regular proof\n' >&2
          exit 2
        }
        if [ -e "$final_start_proof" ] || [ -L "$final_start_proof" ]; then
          [ -f "$final_start_proof" ] && [ ! -L "$final_start_proof" ] || {
            printf 'partial final start proof is not regular: %s\n' \
              "$final_start_proof" >&2
            exit 2
          }
          python3 "$durable_publication" require-equal \
            "$final_start_proof_pending" "$final_start_proof"
          python3 "$durable_publication" discard-private "$final_start_proof_pending"
        else
          python3 "$durable_publication" publish-identified \
            "$final_start_proof_pending" "$final_start_proof" \
            "$final_start_proof_dev" "$final_start_proof_ino" \
            "$final_start_proof_size" "$final_start_proof_sha"
        fi

        "$docker_bin" run --rm \
          --user "$(id -u):$(id -g)" \
          -v "$REPO_ROOT:/work" \
          -w /work \
          "$docker_image_id" \
          python3 \
          /work/src/runtimes/liboliphaunt/wasix-postmaster/runtime/bin/verify-postmaster-concurrency-contract.py \
          --expected-total "$expected_final_atomic_fence_total" \
          --latch-state-contract packed-atomic-v1 \
          --wasm-dis /opt/wasixcc-home/.wasixcc/binaryen/bin/wasm-dis \
          --receipt "$docker_install_dir/share/postgresql/$(basename "$final_concurrency_receipt_pending")" \
          "$docker_install_dir/bin/postgres"
        [ -f "$final_concurrency_receipt_pending" ] && \
          [ ! -L "$final_concurrency_receipt_pending" ] || {
          printf 'concurrency analyzer did not produce a regular receipt\n' >&2
          exit 2
          }
        final_concurrency_identity="$(
          python3 "$durable_publication" identify-source \
            "$final_concurrency_receipt_pending"
        )"
        IFS=$'\t' read -r final_concurrency_dev final_concurrency_ino \
          final_concurrency_size final_concurrency_sha \
          <<<"$final_concurrency_identity"
        python3 \
          "$FRESH_ROOT/runtime/bin/verify-postmaster-concurrency-contract.py" \
          --expected-total "$expected_final_atomic_fence_total" \
          --latch-state-contract packed-atomic-v1 \
          --verified-receipt "$final_concurrency_receipt_pending" \
          --receipt-only \
          "$WASIX_INSTALL_DIR/bin/postgres"
        # This receipt is the admission record for the pair and is therefore
        # published last, without replacement, only after the start proof is
        # durable at its public name.
        python3 "$durable_publication" publish-identified \
          "$final_concurrency_receipt_pending" "$final_concurrency_receipt" \
          "$final_concurrency_dev" "$final_concurrency_ino" \
          "$final_concurrency_size" "$final_concurrency_sha"
        validate_final_proof_generation
      fi
      trap - EXIT
    ) >>"$log" 2>&1
    status=$?
    set -e
  fi
fi

if [ "$status" -eq 0 ]; then
  if [ "$mode" = build ]; then
    guest_build_receipt="$WASIX_INSTALL_DIR/guest-build.receipt"
    guest_build_receipt_pending="$WASIX_INSTALL_DIR/.guest-build.receipt.pending"
    concurrency_args=()
    if [ -n "$expected_final_atomic_fence_total" ]; then
      concurrency_args+=(--expected-total "$expected_final_atomic_fence_total")
    fi
    final_wasm_concurrency_receipt_sha256="none"
    if [ "$wasix_core_latch_state_contract" = packed-atomic-v1 ]; then
      final_wasm_concurrency_receipt="$WASIX_INSTALL_DIR/share/postgresql/wasix-postmaster.final-wasm-concurrency.receipt"
      [ -f "$final_wasm_concurrency_receipt" ] && [ ! -L "$final_wasm_concurrency_receipt" ] || {
        echo 'missing final Wasm concurrency receipt' >&2
        exit 125
      }
      concurrency_args+=(
        --latch-state-contract packed-atomic-v1
        --verified-receipt "$final_wasm_concurrency_receipt"
      )
      final_wasm_concurrency_receipt_sha256="$(
        fresh_wasmer_bin_hash "$final_wasm_concurrency_receipt"
      )" || exit
      fresh_is_sha256 "$final_wasm_concurrency_receipt_sha256" || {
        echo 'final Wasm concurrency receipt identity is not a SHA-256' >&2
        exit 125
      }
    fi
    concurrency_contract_output="$(
      python3 "$FRESH_ROOT/runtime/bin/verify-postmaster-concurrency-contract.py" \
        "${concurrency_args[@]}" "$WASIX_INSTALL_DIR/bin/postgres"
    )" || exit
    atomic_fence_total="$(
      printf '%s\n' "$concurrency_contract_output" |
        sed -n 's/^verified PostgreSQL Wasm concurrency contract: total=\([0-9][0-9]*\) .*/\1/p'
    )"
    case "$atomic_fence_total" in
      ''|*[!0-9]*) echo 'could not parse verified atomic fence total' >&2; exit 125 ;;
    esac
    linear_memory_profile_id="$FRESH_LINEAR_MEMORY_PROFILE_ID"
    linear_memory_install_receipt="$WASIX_INSTALL_DIR/share/postgresql/wasix-postmaster.linear-memory-profile.receipt.json"
    [ -f "$linear_memory_install_receipt" ] && \
      [ ! -L "$linear_memory_install_receipt" ] || {
      echo 'missing regular linear-memory install receipt' >&2
      exit 125
    }
    python3 - "$linear_memory_install_receipt" "$linear_memory_profile_id" <<'PY'
import json
import sys

path, expected_profile = sys.argv[1:]
with open(path, encoding="utf-8") as stream:
    receipt = json.load(stream)
if receipt.get("schema") != "oliphaunt.wasix-postmaster.linear-memory-install.v1":
    raise SystemExit("linear-memory install receipt schema differs")
if receipt.get("profile-id") != expected_profile:
    raise SystemExit("linear-memory install receipt profile differs")
PY
    linear_memory_install_receipt_sha256="$(
      fresh_wasmer_bin_hash "$linear_memory_install_receipt"
    )" || exit
    fresh_is_sha256 "$linear_memory_install_receipt_sha256" || {
      echo 'linear-memory install receipt identity is not a SHA-256' >&2
      exit 125
    }
    require_build_inputs_unchanged 'before guest receipt publication' || exit
    installed_closure_sha256="$(
      python3 "$FRESH_ROOT/lib/guest_build_provenance.py" \
        seal-identity "$WASIX_INSTALL_DIR"
    )" || exit
    fresh_is_sha256 "$installed_closure_sha256" || {
      echo 'WASIX core installed closure identity is not a SHA-256' >&2
      exit 125
    }
    require_build_inputs_unchanged 'while installed outputs were hashed' || exit
    case "$wasix_core_cflags$wasix_core_ldflags$wasixcc_run_wasm_opt$wasixcc_wasm_opt_flags$wasixcc_wasm_opt_suppress_default" in
      *$'\n'*|*$'\r'*)
        echo 'WASIX core effective build flags contain a line break' >&2
        exit 2
        ;;
    esac
    python3 "$durable_publication" discard-private "$guest_build_receipt_pending"
    guest_build_receipt_identity="$({
      printf 'schema=oliphaunt.wasix-postmaster.guest-build.v5\n'
      printf 'core_profile=%s\n' "$WASIX_CORE_PROFILE"
      printf 'guest_source_signature_sha256=%s\n' "$source_signature"
      printf 'docker_image_id=%s\n' "$docker_image_id"
      printf 'installed_closure_sha256=%s\n' "$installed_closure_sha256"
      printf 'child_backend=%s\n' "$wasix_core_child_backend"
      printf 'effective_cflags=%s\n' "$wasix_core_cflags"
      printf 'effective_ldflags=%s\n' "$wasix_core_ldflags"
      printf 'effective_wasm_opt=%s\n' "$wasixcc_run_wasm_opt"
      printf 'effective_wasm_opt_flags=%s\n' "${wasixcc_wasm_opt_flags:-none}"
      printf 'effective_wasm_opt_suppress_default=%s\n' "$wasixcc_wasm_opt_suppress_default"
      printf 'atomic_fence_total=%s\n' "$atomic_fence_total"
      printf 'atomic_fence_set_latch=2\n'
      printf 'atomic_fence_reset_latch=1\n'
      printf 'atomic_fence_wait_event_set_wait=1\n'
      printf 'latch_state_contract=%s\n' "$wasix_core_latch_state_contract"
      printf 'final_wasm_concurrency_receipt_sha256=%s\n' \
        "$final_wasm_concurrency_receipt_sha256"
      printf 'linear_memory_profile_id=%s\n' "$linear_memory_profile_id"
      printf 'linear_memory_install_receipt_sha256=%s\n' \
        "$linear_memory_install_receipt_sha256"
      printf 'postgres_tag=%s\n' "$POSTGRES_TAG"
      printf 'postgres_version=%s\n' "$POSTGRES_VERSION"
      printf 'sysroot_variant=%s\n' "$WASIXCC_SYSROOT_VARIANT"
    } | python3 "$durable_publication" write-stdin-identified \
      "$guest_build_receipt_pending")"
    IFS=$'\t' read -r guest_build_receipt_dev guest_build_receipt_ino \
      guest_build_receipt_size guest_build_receipt_sha \
      <<<"$guest_build_receipt_identity"
    require_build_inputs_unchanged 'before final guest receipt publication' || exit
    if [ -e "$guest_build_receipt" ] || [ -L "$guest_build_receipt" ]; then
      [ -f "$guest_build_receipt" ] && [ ! -L "$guest_build_receipt" ] || {
        printf 'guest build admission is not regular: %s\n' \
          "$guest_build_receipt" >&2
        exit 125
      }
      python3 "$durable_publication" require-equal \
        "$guest_build_receipt_pending" "$guest_build_receipt" || exit 125
      python3 "$durable_publication" discard-private \
        "$guest_build_receipt_pending" || exit 125
    else
      # The guest receipt admits the complete installed closure.  It is
      # synchronized and published without replacement only after every
      # predecessor proof above has been replayed against that closure.
      python3 "$durable_publication" publish-identified \
        "$guest_build_receipt_pending" "$guest_build_receipt" \
        "$guest_build_receipt_dev" "$guest_build_receipt_ino" \
        "$guest_build_receipt_size" "$guest_build_receipt_sha" || exit 125
    fi
  fi
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
