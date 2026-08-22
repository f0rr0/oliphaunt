#!/usr/bin/env bash

set -euo pipefail

_fresh_common_source="${BASH_SOURCE[0]}"
_fresh_source_root="$(cd -P "$(dirname "$_fresh_common_source")/.." && pwd -P)"
_fresh_source_repo_root="$(cd -P "$_fresh_source_root/../../../.." && pwd -P)"
export FRESH_ROOT="${FRESH_ROOT:-$_fresh_source_root}"
export REPO_ROOT="${REPO_ROOT:-$_fresh_source_repo_root}"
_fresh_project_source_id_prefix="src/runtimes/liboliphaunt/wasix-postmaster"
if [ "${FRESH_PROJECT_SOURCE_ID_PREFIX+x}" = x ]; then
  if [ "$FRESH_PROJECT_SOURCE_ID_PREFIX" != "$_fresh_project_source_id_prefix" ]; then
    printf 'FRESH_PROJECT_SOURCE_ID_PREFIX must be %s\n' \
      "$_fresh_project_source_id_prefix" >&2
    return 2 2>/dev/null || exit 2
  fi
else
  FRESH_PROJECT_SOURCE_ID_PREFIX="$_fresh_project_source_id_prefix"
fi
readonly FRESH_PROJECT_SOURCE_ID_PREFIX
export FRESH_PROJECT_SOURCE_ID_PREFIX
export WASIX_TOOLCHAIN_ROOT="${WASIX_TOOLCHAIN_ROOT:-$REPO_ROOT/src/runtimes/liboliphaunt/wasix/assets/build}"
export FRESH_WORK_ROOT="${FRESH_WORK_ROOT:-$REPO_ROOT/target/oliphaunt-wasix-postmaster}"

export POSTGRES_TAG="${POSTGRES_TAG:-REL_18_4}"
export POSTGRES_VERSION="${POSTGRES_VERSION:-18.4}"
export POSTGRES_SOURCE_TOML="${POSTGRES_SOURCE_TOML:-$REPO_ROOT/src/postgres/versions/18/source.toml}"
export BASELINE_DIR="${BASELINE_DIR:-$FRESH_WORK_ROOT/sources/postgresql-$POSTGRES_VERSION}"
export WASIX_SRC_DIR="${WASIX_SRC_DIR:-$FRESH_WORK_ROOT/work/postgres-wasix-core-src}"
export CLIENT_TOOLS_BUILD_DIR="${CLIENT_TOOLS_BUILD_DIR:-$FRESH_WORK_ROOT/builds/native-client-tools}"
export CLIENT_TOOLS_INSTALL_DIR="${CLIENT_TOOLS_INSTALL_DIR:-$FRESH_WORK_ROOT/install/native-client-tools}"
export FRESH_WASIX_DOCKER_IMAGE="${FRESH_WASIX_DOCKER_IMAGE:-oliphaunt-wasix-wasix-build:local}"
export FRESH_WASMER_VERSION="${FRESH_WASMER_VERSION:-7.2.0-alpha.2}"
export FRESH_WASMER_WASIX_VERSION="${FRESH_WASMER_WASIX_VERSION:-0.702.0-alpha.2}"
export FRESH_WASMER_COMPILER_FEATURES="${FRESH_WASMER_COMPILER_FEATURES:-llvm,wat}"
export FRESH_WASMER_HEADLESS_FEATURES="${FRESH_WASMER_HEADLESS_FEATURES:-headless-minimal}"
export FRESH_POSTMASTER_EXECUTOR_PACKAGE="oliphaunt-wasix-postmaster-executor"
export FRESH_POSTMASTER_EXECUTOR_BINARY="oliphaunt-wasix-postmaster-executor"
export FRESH_POSTMASTER_EXECUTOR_FEATURES="product-executor"
export FRESH_START_PROOF_BINARY="oliphaunt-wasix-start-proof"
export FRESH_START_PROOF_FEATURES="start-proof-tool"
export FRESH_START_PROOF_POLICY="llvm-shared-memory-init-restricted-effects.v1"
export FRESH_MEMORY_PROFILE_BINARY="oliphaunt-wasix-memory-profile"
export FRESH_MEMORY_PROFILE_FEATURES="memory-profile-tool"
export FRESH_LINEAR_MEMORY_PROFILE_ID="oliphaunt.wasix-postmaster.linear-memory.wasm32-max256m-u64-static4g-guard2g.v1"
export FRESH_LINEAR_MEMORY_MAXIMUM_PAGES="4096"
export FRESH_LINEAR_MEMORY_STATIC_BOUND_PAGES="65536"
export FRESH_LINEAR_MEMORY_STATIC_OFFSET_GUARD_BYTES="2147483648"
export FRESH_POSTMASTER_COMPILER_BINARY="oliphaunt-wasix-postmaster-compiler"
export FRESH_POSTMASTER_COMPILER_FEATURES="product-compiler"
export FRESH_POSTMASTER_EXECUTOR_ROLE="postmaster-product"
export FRESH_POSTMASTER_TASK_BUDGET_PROFILE="$FRESH_ROOT/profiles/runtime-task-budgets/embedded-postmaster-v1.tsv"
export FRESH_POSTMASTER_RUNTIME_FOOTPRINT_PROFILE="$FRESH_ROOT/profiles/runtime-footprints/embedded-concurrent-v1.gucs"
export FRESH_POSTMASTER_TASK_BUDGET_PROFILE_ID="embedded-postmaster-v1"
export FRESH_POSTMASTER_HOST_TASK_BUDGET="96"
export FRESH_POSTMASTER_BLOCKING_CORE_THREADS="1"
export FRESH_POSTMASTER_BLOCKING_WORKER_IDLE_TIMEOUT_MS="1000"
export FRESH_POSTMASTER_EXECUTOR_RUNTIME_POLICY_ID="oliphaunt.wasix-postmaster.tokio.2-async.embedded-postmaster-v1-budget96.v2"
export FRESH_POSTMASTER_EXECUTOR_CLI_CONTRACT="sealed-postmaster-run-v1"
export FRESH_WASMER_ARTIFACT_ABI_VERSION="${FRESH_WASMER_ARTIFACT_ABI_VERSION:-21}"
export FRESH_WASMER_SOURCE_COMMIT="${FRESH_WASMER_SOURCE_COMMIT:-1d1b3420beef28550afbb4692b664bd7f6bc2581}"
export FRESH_WASMER_NAPI_COMMIT="${FRESH_WASMER_NAPI_COMMIT:-706383f42391cb4e4e82e5fd5e63a0ebf81ae19d}"
export FRESH_WASMER_TEST_FILES_COMMIT="${FRESH_WASMER_TEST_FILES_COMMIT:-7f27e84c69af3b772f751d6c4a733d9f448b2c70}"
export FRESH_WASMER_SPEC_COMMIT="${FRESH_WASMER_SPEC_COMMIT:-7e0b83aba9dbbb6e0623c9334b0f73b3bb584b90}"
export FRESH_WASIX_LIBC_SOURCE_COMMIT="${FRESH_WASIX_LIBC_SOURCE_COMMIT:-34178a6272804f90448b5bd08dc7bcf0d85438e3}"
export FRESH_UPSTREAM_WASMER_BIN="${FRESH_UPSTREAM_WASMER_BIN:-$FRESH_WORK_ROOT/runtime/wasmer/target/release/wasmer}"
export FRESH_UPSTREAM_WASMER_HEADLESS_BIN="${FRESH_UPSTREAM_WASMER_HEADLESS_BIN:-$FRESH_WORK_ROOT/runtime/wasmer/target/release/wasmer-headless}"
export FRESH_WASMER_BUILD_RECEIPT="${FRESH_WASMER_BUILD_RECEIPT:-$FRESH_WORK_ROOT/runtime/build/wasmer-build.receipt}"
export FRESH_POSTMASTER_EXECUTOR_TARGET_DIR="${FRESH_POSTMASTER_EXECUTOR_TARGET_DIR:-$FRESH_WORK_ROOT/runtime/postmaster-executor-target}"
export FRESH_POSTMASTER_EXECUTOR_BIN="${FRESH_POSTMASTER_EXECUTOR_BIN:-$FRESH_POSTMASTER_EXECUTOR_TARGET_DIR/release/$FRESH_POSTMASTER_EXECUTOR_BINARY}"
export FRESH_START_PROOF_BIN="${FRESH_START_PROOF_BIN:-$FRESH_POSTMASTER_EXECUTOR_TARGET_DIR/release/$FRESH_START_PROOF_BINARY}"
export FRESH_MEMORY_PROFILE_BIN="${FRESH_MEMORY_PROFILE_BIN:-$FRESH_POSTMASTER_EXECUTOR_TARGET_DIR/release/$FRESH_MEMORY_PROFILE_BINARY}"
export FRESH_POSTMASTER_COMPILER_TARGET_DIR="${FRESH_POSTMASTER_COMPILER_TARGET_DIR:-$FRESH_WORK_ROOT/runtime/postmaster-compiler-target}"
export FRESH_POSTMASTER_COMPILER_BIN="${FRESH_POSTMASTER_COMPILER_BIN:-$FRESH_POSTMASTER_COMPILER_TARGET_DIR/release/$FRESH_POSTMASTER_COMPILER_BINARY}"
export FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT="${FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT:-$FRESH_WORK_ROOT/runtime/build/postmaster-executor-build.receipt}"
export FRESH_PATCHED_WASIXCC_SYSROOT_PREFIX="${FRESH_PATCHED_WASIXCC_SYSROOT_PREFIX:-$FRESH_WORK_ROOT/runtime/build/patched-wasixcc-sysroot}"
export WASIXCC_SYSROOT_VARIANT="${WASIXCC_SYSROOT_VARIANT:-sysroot-exnref-ehpic}"
export WASIXCC_SYSROOT_PREFIX="${WASIXCC_SYSROOT_PREFIX:-$FRESH_PATCHED_WASIXCC_SYSROOT_PREFIX}"
export WASIXCC_SYSROOT="${WASIXCC_SYSROOT:-$WASIXCC_SYSROOT_PREFIX/$WASIXCC_SYSROOT_VARIANT}"

fresh_validate_postmaster_task_budget_profile() {
  local profile="${1:-$FRESH_POSTMASTER_TASK_BUDGET_PROFILE}"
  local footprint="${2:-$FRESH_POSTMASTER_RUNTIME_FOOTPRINT_PROFILE}"
  local max_connections
  local max_wal_senders
  local autovacuum_worker_slots
  local max_worker_processes
  local io_method
  local profile_key
  local profile_value

  [ -f "$profile" ] && [ ! -L "$profile" ] || {
    printf 'missing regular postmaster task-budget profile: %s\n' "$profile" >&2
    return 2
  }
  [ -f "$footprint" ] && [ ! -L "$footprint" ] || {
    printf 'missing regular postmaster runtime-footprint profile: %s\n' "$footprint" >&2
    return 2
  }
  for profile_key in \
    max_connections max_wal_senders autovacuum_worker_slots max_worker_processes io_method
  do
    profile_value="$(awk -F= -v expected="$profile_key" '
      $1 == expected { count += 1; value = substr($0, index($0, "=") + 1) }
      END { if (count != 1 || value == "") exit 2; print value }
    ' "$footprint")" || {
      printf 'runtime-footprint profile must contain one %s: %s\n' \
        "$profile_key" "$footprint" >&2
      return 2
    }
    case "$profile_key" in
      max_connections) max_connections="$profile_value" ;;
      max_wal_senders) max_wal_senders="$profile_value" ;;
      autovacuum_worker_slots) autovacuum_worker_slots="$profile_value" ;;
      max_worker_processes) max_worker_processes="$profile_value" ;;
      io_method) io_method="$profile_value" ;;
    esac
  done
  [ "$max_connections" = 8 ] && [ "$max_wal_senders" = 10 ] && \
    [ "$autovacuum_worker_slots" = 4 ] && [ "$max_worker_processes" = 8 ] && \
    [ "$io_method" = sync ] || {
    printf 'postmaster task budget does not match runtime-footprint GUC capacity: %s\n' \
      "$footprint" >&2
    return 2
  }
  awk -F '\t' \
    -v expected_id="$FRESH_POSTMASTER_TASK_BUDGET_PROFILE_ID" \
    -v expected_budget="$FRESH_POSTMASTER_HOST_TASK_BUDGET" \
    -v expected_core="$FRESH_POSTMASTER_BLOCKING_CORE_THREADS" \
    -v expected_idle_ms="$FRESH_POSTMASTER_BLOCKING_WORKER_IDLE_TIMEOUT_MS" '
    BEGIN {
      header = "schema_version\tprofile_id\tstatus\tpostgres_major\truntime_footprint\tmax_backends\tbackend_authentication_overlap\tmax_io_worker_slots\tfixed_non_max_backends_pmchild_roles\ttracked_child_capacity\tpostmaster_tasks\treserve_tasks\thost_task_budget\tblocking_core_threads\tblocking_worker_idle_timeout_ms"
    }
    NR == 1 {
      if ($0 != header) exit 2
      next
    }
    NR == 2 {
      if (NF != 15 ||
          $1 != "oliphaunt.wasix-postmaster.runtime-task-budget.v1" ||
          $2 != expected_id ||
          $3 != "supported" ||
          $4 != "18" ||
          $5 != "embedded-concurrent") exit 2
      for (i = 6; i <= 15; i++)
        if ($i !~ /^(0|[1-9][0-9]*)$/) exit 2
      if ($6 != 32 || $7 != 18 || $8 != 32 || $9 != 8) exit 2
      if ($10 != $6 + $7 + $8 + $9) exit 2
      if ($13 != $10 + $11 + $12) exit 2
      if ($13 != expected_budget || $14 != expected_core ||
          $15 != expected_idle_ms || $14 < 1 || $14 > $13 || $15 < 1) exit 2
      next
    }
    { exit 2 }
    END { if (NR != 2) exit 2 }
  ' "$profile" || {
    printf 'invalid or non-canonical postmaster task-budget profile: %s\n' "$profile" >&2
    return 2
  }
}

fresh_normalize_wasix_core_profile() {
  case "${1:-safe-o2}" in
    current|baseline|safe|safe-o2) echo "safe-o2" ;;
    o3) echo "o3" ;;
    o3-wasmopt|o3-wasm-opt) echo "o3-wasmopt" ;;
    o3-thinlto) echo "o3-thinlto" ;;
    release-o3|perf|production) echo "release-o3" ;;
    release-o3-symbols|perf-symbols|profile-o3) echo "release-o3-symbols" ;;
    *)
      echo "unknown WASIX_CORE_PROFILE=$1; expected safe-o2, o3, o3-wasmopt, o3-thinlto, release-o3, or release-o3-symbols" >&2
      return 2
      ;;
  esac
}

WASIX_CORE_PROFILE="$(fresh_normalize_wasix_core_profile "${WASIX_CORE_PROFILE:-release-o3}")"
export WASIX_CORE_PROFILE

fresh_wasix_core_profile_suffix_for() {
  case "$(fresh_normalize_wasix_core_profile "$1")" in
    safe-o2) printf '' ;;
    *) printf -- '-%s' "$(fresh_normalize_wasix_core_profile "$1")" ;;
  esac
}

fresh_wasix_core_build_dir_for() {
  printf '%s/builds/wasix-core%s\n' "$FRESH_WORK_ROOT" "$(fresh_wasix_core_profile_suffix_for "$1")"
}

fresh_wasix_core_install_dir_for() {
  printf '%s/install/wasix-core%s\n' "$FRESH_WORK_ROOT" "$(fresh_wasix_core_profile_suffix_for "$1")"
}

fresh_wasix_core_report_dir_for() {
  case "$(fresh_normalize_wasix_core_profile "$1")" in
    safe-o2) printf '%s/reports\n' "$FRESH_WORK_ROOT" ;;
    *) printf '%s/reports/%s\n' "$FRESH_WORK_ROOT" "$(fresh_normalize_wasix_core_profile "$1")" ;;
  esac
}

fresh_wasix_core_run_dir_for() {
  case "$(fresh_normalize_wasix_core_profile "$1")" in
    safe-o2) printf '%s/run\n' "$FRESH_WORK_ROOT" ;;
    *) printf '%s/run/%s\n' "$FRESH_WORK_ROOT" "$(fresh_normalize_wasix_core_profile "$1")" ;;
  esac
}

export WASIX_BUILD_DIR="${WASIX_BUILD_DIR:-$(fresh_wasix_core_build_dir_for "$WASIX_CORE_PROFILE")}"
export WASIX_INSTALL_DIR="${WASIX_INSTALL_DIR:-$(fresh_wasix_core_install_dir_for "$WASIX_CORE_PROFILE")}"
export REPORT_DIR="${REPORT_DIR:-$(fresh_wasix_core_report_dir_for "$WASIX_CORE_PROFILE")}"
export RUN_DIR="${RUN_DIR:-$(fresh_wasix_core_run_dir_for "$WASIX_CORE_PROFILE")}"

fresh_resolve_wasix_core_profile() {
  local profile="${1:-$WASIX_CORE_PROFILE}"
  profile="$(fresh_normalize_wasix_core_profile "$profile")"

  case "$profile" in
    safe-o2)
      FRESH_WASIX_CORE_PROFILE_DESCRIPTION="current conservative bring-up profile: O2, no wasm-opt, SIMD/vectorizers disabled"
      FRESH_WASIX_CORE_PROFILE_CFLAGS="-O2 -g0 -mno-simd128 -fno-vectorize -fno-slp-vectorize -fno-inline-functions-called-once -fno-unroll-loops -fPIC -pthread -sWASM_EXCEPTIONS=yes -Wno-unused-command-line-argument"
      FRESH_WASIX_CORE_PROFILE_LDFLAGS="-fPIC -pthread -sWASM_EXCEPTIONS=yes"
      FRESH_WASIX_CORE_PROFILE_WASM_OPT="no"
      FRESH_WASIX_CORE_PROFILE_WASM_OPT_FLAGS=""
      FRESH_WASIX_CORE_PROFILE_WASM_OPT_SUPPRESS_DEFAULT="yes"
      FRESH_WASIX_CORE_PROFILE_EXPECTED_ATOMIC_FENCE_TOTAL="275"
      FRESH_WASIX_CORE_PROFILE_EXPECTED_FINAL_ATOMIC_FENCE_TOTAL="233"
      ;;
    o3)
      FRESH_WASIX_CORE_PROFILE_DESCRIPTION="O3 codegen profile without LTO or Binaryen post-link optimization"
      FRESH_WASIX_CORE_PROFILE_CFLAGS="-O3 -g0 -fPIC -pthread -sWASM_EXCEPTIONS=yes -Wno-unused-command-line-argument"
      FRESH_WASIX_CORE_PROFILE_LDFLAGS="-fPIC -pthread -sWASM_EXCEPTIONS=yes"
      FRESH_WASIX_CORE_PROFILE_WASM_OPT="no"
      FRESH_WASIX_CORE_PROFILE_WASM_OPT_FLAGS=""
      FRESH_WASIX_CORE_PROFILE_WASM_OPT_SUPPRESS_DEFAULT="yes"
      FRESH_WASIX_CORE_PROFILE_EXPECTED_ATOMIC_FENCE_TOTAL=""
      FRESH_WASIX_CORE_PROFILE_EXPECTED_FINAL_ATOMIC_FENCE_TOTAL=""
      ;;
    o3-wasmopt)
      FRESH_WASIX_CORE_PROFILE_DESCRIPTION="O3 plus Binaryen post-link converge/strip, without ThinLTO"
      FRESH_WASIX_CORE_PROFILE_CFLAGS="-O3 -g0 -fPIC -pthread -sWASM_EXCEPTIONS=yes -Wno-unused-command-line-argument"
      FRESH_WASIX_CORE_PROFILE_LDFLAGS="-fPIC -pthread -sWASM_EXCEPTIONS=yes"
      FRESH_WASIX_CORE_PROFILE_WASM_OPT="yes"
      FRESH_WASIX_CORE_PROFILE_WASM_OPT_FLAGS="--converge:--strip-debug:--strip-producers"
      FRESH_WASIX_CORE_PROFILE_WASM_OPT_SUPPRESS_DEFAULT="yes"
      FRESH_WASIX_CORE_PROFILE_EXPECTED_ATOMIC_FENCE_TOTAL=""
      FRESH_WASIX_CORE_PROFILE_EXPECTED_FINAL_ATOMIC_FENCE_TOTAL=""
      ;;
    o3-thinlto)
      FRESH_WASIX_CORE_PROFILE_DESCRIPTION="O3 plus ThinLTO, without Binaryen post-link optimization"
      FRESH_WASIX_CORE_PROFILE_CFLAGS="-O3 -g0 -flto=thin -fPIC -pthread -sWASM_EXCEPTIONS=yes -Wno-unused-command-line-argument"
      FRESH_WASIX_CORE_PROFILE_LDFLAGS="-flto=thin -fPIC -pthread -sWASM_EXCEPTIONS=yes"
      FRESH_WASIX_CORE_PROFILE_WASM_OPT="no"
      FRESH_WASIX_CORE_PROFILE_WASM_OPT_FLAGS=""
      FRESH_WASIX_CORE_PROFILE_WASM_OPT_SUPPRESS_DEFAULT="yes"
      FRESH_WASIX_CORE_PROFILE_EXPECTED_ATOMIC_FENCE_TOTAL="1111"
      FRESH_WASIX_CORE_PROFILE_EXPECTED_FINAL_ATOMIC_FENCE_TOTAL=""
      ;;
    release-o3)
      FRESH_WASIX_CORE_PROFILE_DESCRIPTION="release-lane performance profile: O3, ThinLTO, and Binaryen converge/strip"
      FRESH_WASIX_CORE_PROFILE_CFLAGS="-O3 -g0 -flto=thin -fPIC -pthread -sWASM_EXCEPTIONS=yes -Wno-unused-command-line-argument"
      FRESH_WASIX_CORE_PROFILE_LDFLAGS="-flto=thin -fPIC -pthread -sWASM_EXCEPTIONS=yes"
      FRESH_WASIX_CORE_PROFILE_WASM_OPT="yes"
      FRESH_WASIX_CORE_PROFILE_WASM_OPT_FLAGS="--converge:--strip-debug:--strip-producers"
      FRESH_WASIX_CORE_PROFILE_WASM_OPT_SUPPRESS_DEFAULT="yes"
      FRESH_WASIX_CORE_PROFILE_EXPECTED_ATOMIC_FENCE_TOTAL="1111"
      FRESH_WASIX_CORE_PROFILE_EXPECTED_FINAL_ATOMIC_FENCE_TOTAL="995"
      ;;
    release-o3-symbols)
      FRESH_WASIX_CORE_PROFILE_DESCRIPTION="release-lane profiling profile: O3, ThinLTO, and Binaryen converge while retaining Wasm symbol names"
      FRESH_WASIX_CORE_PROFILE_CFLAGS="-O3 -g0 -flto=thin -fPIC -pthread -sWASM_EXCEPTIONS=yes -Wno-unused-command-line-argument"
      FRESH_WASIX_CORE_PROFILE_LDFLAGS="-flto=thin -fPIC -pthread -sWASM_EXCEPTIONS=yes"
      FRESH_WASIX_CORE_PROFILE_WASM_OPT="yes"
      FRESH_WASIX_CORE_PROFILE_WASM_OPT_FLAGS="--converge:--debuginfo"
      FRESH_WASIX_CORE_PROFILE_WASM_OPT_SUPPRESS_DEFAULT="yes"
      FRESH_WASIX_CORE_PROFILE_EXPECTED_ATOMIC_FENCE_TOTAL="1111"
      FRESH_WASIX_CORE_PROFILE_EXPECTED_FINAL_ATOMIC_FENCE_TOTAL=""
      ;;
  esac

  FRESH_WASIX_CORE_EFFECTIVE_CFLAGS="${WASIX_CORE_CFLAGS:-$FRESH_WASIX_CORE_PROFILE_CFLAGS}"
  FRESH_WASIX_CORE_EFFECTIVE_LDFLAGS="${WASIX_CORE_LDFLAGS:-$FRESH_WASIX_CORE_PROFILE_LDFLAGS}"
  FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT="${WASIXCC_RUN_WASM_OPT:-$FRESH_WASIX_CORE_PROFILE_WASM_OPT}"
  FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT_FLAGS="${WASIXCC_WASM_OPT_FLAGS:-$FRESH_WASIX_CORE_PROFILE_WASM_OPT_FLAGS}"
  FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT_SUPPRESS_DEFAULT="${WASIXCC_WASM_OPT_SUPPRESS_DEFAULT:-$FRESH_WASIX_CORE_PROFILE_WASM_OPT_SUPPRESS_DEFAULT}"
  FRESH_WASIX_CORE_EXPECTED_ATOMIC_FENCE_TOTAL="$FRESH_WASIX_CORE_PROFILE_EXPECTED_ATOMIC_FENCE_TOTAL"
  FRESH_WASIX_CORE_EXPECTED_FINAL_ATOMIC_FENCE_TOTAL="$FRESH_WASIX_CORE_PROFILE_EXPECTED_FINAL_ATOMIC_FENCE_TOTAL"

  case "$FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT_SUPPRESS_DEFAULT" in
    yes|true|1) FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT_SUPPRESS_DEFAULT="yes" ;;
    no|false|0) FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT_SUPPRESS_DEFAULT="no" ;;
    *)
      printf 'invalid WASIXCC_WASM_OPT_SUPPRESS_DEFAULT=%s; expected yes or no\n' \
        "$FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT_SUPPRESS_DEFAULT" >&2
      return 2
      ;;
  esac
}

fresh_jobs() {
  if command -v sysctl >/dev/null 2>&1; then
    sysctl -n hw.ncpu 2>/dev/null && return
  fi
  if command -v nproc >/dev/null 2>&1; then
    nproc 2>/dev/null && return
  fi
  echo 4
}

fresh_timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

fresh_require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "missing required command: $name" >&2
    return 127
  fi
}

# Return the stable repository identity for a file in this product source
# tree.  Measurement tools may execute from a content-addressed physical copy
# under target/, but build receipts must continue naming the canonical source
# location.  Mixing those two identities makes byte-identical frozen tools
# reject artifacts produced from the ordinary checkout.
fresh_project_source_identity_path() {
  local path="${1-}"
  local relative

  [ "$#" -eq 1 ] && [ -n "$path" ] && [ "${path#/}" != "$path" ] || {
    printf 'fresh_project_source_identity_path requires one absolute path\n' >&2
    return 2
  }
  case "$path" in
    "$FRESH_ROOT"/*)
      relative="${path#"$FRESH_ROOT"/}"
      ;;
    *)
      printf 'source path is outside FRESH_ROOT: %s\n' "$path" >&2
      return 2
      ;;
  esac
  case "$relative" in
    ""|/*|.|..|*/../*|../*|*/..|*/./*|./*|*/.)
      printf 'source path is not canonical beneath FRESH_ROOT: %s\n' "$path" >&2
      return 2
      ;;
  esac
  printf '%s/%s\n' "$FRESH_PROJECT_SOURCE_ID_PREFIX" "$relative"
}

fresh_require_patched_wasixcc_sysroot() {
  local carrier_manifest="$WASIXCC_SYSROOT_PREFIX/.oliphaunt-patched-sysroots.manifest"
  local variant_manifest="$WASIXCC_SYSROOT/.oliphaunt-patched-sysroot.manifest"
  local validator="$FRESH_ROOT/runtime/bin/validate-runtime-capabilities.sh"

  if [ ! -f "$carrier_manifest" ] || [ ! -f "$variant_manifest" ]; then
    {
      printf 'missing exact patched WASIX libc carrier: %s\n' "$WASIXCC_SYSROOT"
      printf 'Run %s/runtime/bin/build-patched-wasix-libc-sysroot.sh after preparing the pinned runtime sources.\n' "$FRESH_ROOT"
    } >&2
    return 2
  fi

  [ -x "$validator" ] || {
    printf 'missing exact patched WASIX libc validator: %s\n' "$validator" >&2
    return 2
  }
  UPSTREAM_WORK_ROOT="$FRESH_WORK_ROOT/runtime" \
    WASIXCC_SYSROOT_PREFIX="$WASIXCC_SYSROOT_PREFIX" \
    WASIXCC_SYSROOT_VARIANT="$WASIXCC_SYSROOT_VARIANT" \
    WASIXCC_SYSROOT="$WASIXCC_SYSROOT" \
    "$validator" --validate-sysroot-only >/dev/null
}

fresh_docker_bin() {
  if command -v docker >/dev/null 2>&1; then
    command -v docker
    return
  fi
  echo "missing required command: docker" >&2
  return 127
}

fresh_docker_path_for() {
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

fresh_managed_generated_root() {
  printf '%s/target/oliphaunt-wasix-postmaster\n' "$_fresh_source_repo_root"
}

# Fail closed before a builder removes or replaces generated output.  The
# trust root is derived physically from this file, rather than from the
# overridable REPO_ROOT or FRESH_WORK_ROOT variables. Rejecting every existing
# symlink component is deliberately stricter than resolving and following it.
fresh_require_managed_generated_path() {
  local candidate="${1-}"
  local label="${2:-generated path}"
  local managed_root
  local remainder
  local component
  local current=""
  local has_more

  if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    printf 'fresh_require_managed_generated_path expects a path and optional label\n' >&2
    return 2
  fi

  managed_root="$(fresh_managed_generated_root)"
  if [ -z "$candidate" ]; then
    printf 'refusing empty %s\n' "$label" >&2
    return 2
  fi
  case "$candidate" in
    /*) ;;
    *)
      printf 'refusing non-absolute %s: %s\n' "$label" "$candidate" >&2
      return 2
      ;;
  esac
  if [ "$candidate" = "/" ] || [ "$candidate" = "$managed_root" ]; then
    printf 'refusing unsafe %s root: %s\n' "$label" "$candidate" >&2
    return 2
  fi
  case "$candidate" in
    "$managed_root"/*) ;;
    *)
      printf 'refusing %s outside managed generated root %s: %s\n' \
        "$label" "$managed_root" "$candidate" >&2
      return 2
      ;;
  esac

  remainder="${candidate#/}"
  while :; do
    case "$remainder" in
      */*)
        component="${remainder%%/*}"
        remainder="${remainder#*/}"
        has_more=1
        ;;
      *)
        component="$remainder"
        remainder=""
        has_more=0
        ;;
    esac

    case "$component" in
      ""|.|..)
        printf 'refusing non-canonical %s component in: %s\n' "$label" "$candidate" >&2
        return 2
        ;;
    esac

    current="$current/$component"
    if [ -L "$current" ]; then
      printf 'refusing symlink component in %s: %s\n' "$label" "$current" >&2
      return 2
    fi
    if [ "$has_more" -eq 1 ] && [ -e "$current" ] && [ ! -d "$current" ]; then
      printf 'refusing non-directory component in %s: %s\n' "$label" "$current" >&2
      return 2
    fi
    [ "$has_more" -eq 1 ] || break
  done
}

# Reserve one or more generated leaf directories without replacement. Parents
# may be shared, but each requested leaf is claimed with plain mkdir so two
# equal qualification labels cannot enter the same evidence namespace. No
# caller writes until every leaf is held; a partial claim is rolled back only
# while it remains empty.
fresh_claim_generated_directories() {
  local -a requested=("$@")
  local -a claimed=()
  local path other parent
  local index

  [ "${#requested[@]}" -gt 0 ] || {
    printf 'fresh_claim_generated_directories requires at least one path\n' >&2
    return 2
  }
  for path in "${requested[@]}"; do
    fresh_require_managed_generated_path "$path" "generated directory claim" ||
      return
    for other in "${claimed[@]}"; do
      [ "$path" != "$other" ] || {
        printf 'duplicate generated directory claim: %s\n' "$path" >&2
        return 2
      }
    done
    claimed+=("$path")
  done

  claimed=()
  for path in "${requested[@]}"; do
    parent="$(dirname "$path")"
    fresh_require_managed_generated_path "$parent" "generated claim parent" ||
      return
    mkdir -p "$parent" || return
    fresh_require_managed_generated_path "$path" "generated directory claim" ||
      return
  done
  for path in "${requested[@]}"; do
    if ! mkdir -- "$path"; then
      printf 'generated directory is already claimed: %s\n' "$path" >&2
      for ((index = ${#claimed[@]} - 1; index >= 0; index--)); do
        rmdir -- "${claimed[$index]}" 2>/dev/null || true
      done
      return 2
    fi
    claimed+=("$path")
  done
}

fresh_ensure_dirs() {
  mkdir -p "$REPORT_DIR" "$RUN_DIR" "$FRESH_WORK_ROOT/sources" "$FRESH_WORK_ROOT/work" \
    "$FRESH_WORK_ROOT/builds" "$FRESH_WORK_ROOT/install" "$FRESH_WORK_ROOT/tools"
}

# Serialize publication and consumption of the canonical PostgreSQL baseline.
# Callers keep the descriptor open for the complete interval in which they read
# BASELINE_DIR. The permanent lock file lives outside that replaceable directory,
# so staged publication cannot change the synchronization object.
fresh_lock_postgres_baseline() {
  local mode="${1-}"
  local lock_dir="$FRESH_WORK_ROOT/baseline-locks"
  local lock_path

  [ "$#" -eq 1 ] || {
    printf 'fresh_lock_postgres_baseline expects shared or exclusive\n' >&2
    return 2
  }
  case "$mode" in
    shared) mode=-s ;;
    exclusive) mode=-x ;;
    *)
      printf 'invalid PostgreSQL baseline lock mode: %s\n' "$mode" >&2
      return 2
      ;;
  esac
  [ -z "${FRESH_POSTGRES_BASELINE_LOCK_FD:-}" ] || {
    printf 'PostgreSQL baseline lock is already held by this shell\n' >&2
    return 2
  }
  fresh_require_command flock || return
  fresh_require_managed_generated_path "$BASELINE_DIR" BASELINE_DIR || return
  fresh_require_managed_generated_path "$lock_dir" postgres-baseline-locks || return
  mkdir -p "$lock_dir"
  [ -d "$lock_dir" ] && [ ! -L "$lock_dir" ] || {
    printf 'unsafe PostgreSQL baseline lock directory: %s\n' "$lock_dir" >&2
    return 2
  }
  lock_path="$lock_dir/postgres-baseline.lock"
  fresh_require_managed_generated_path "$lock_path" postgres-baseline-lock || return
  [ ! -L "$lock_path" ] || {
    printf 'unsafe PostgreSQL baseline lock: %s\n' "$lock_path" >&2
    return 2
  }
  exec {FRESH_POSTGRES_BASELINE_LOCK_FD}>"$lock_path"
  [ -f "$lock_path" ] && [ ! -L "$lock_path" ] || {
    printf 'PostgreSQL baseline lock changed while opening: %s\n' "$lock_path" >&2
    exec {FRESH_POSTGRES_BASELINE_LOCK_FD}>&-
    unset FRESH_POSTGRES_BASELINE_LOCK_FD
    return 2
  }
  flock "$mode" "$FRESH_POSTGRES_BASELINE_LOCK_FD" || {
    printf 'could not acquire PostgreSQL baseline lock: %s\n' "$lock_path" >&2
    exec {FRESH_POSTGRES_BASELINE_LOCK_FD}>&-
    unset FRESH_POSTGRES_BASELINE_LOCK_FD
    return 2
  }
  FRESH_POSTGRES_BASELINE_LOCK_PATH="$lock_path"
}

fresh_unlock_postgres_baseline() {
  if [ -n "${FRESH_POSTGRES_BASELINE_LOCK_FD:-}" ]; then
    exec {FRESH_POSTGRES_BASELINE_LOCK_FD}>&-
  fi
  unset FRESH_POSTGRES_BASELINE_LOCK_FD
  unset FRESH_POSTGRES_BASELINE_LOCK_PATH
}

fresh_postgres_baseline_fingerprint() {
  local version
  local archive_sha256

  [ -f "$POSTGRES_SOURCE_TOML" ] && [ ! -L "$POSTGRES_SOURCE_TOML" ] || {
    printf 'missing regular PostgreSQL source manifest: %s\n' "$POSTGRES_SOURCE_TOML" >&2
    return 2
  }
  version="$(awk -F= '
    $1 ~ /^[[:space:]]*version[[:space:]]*$/ {
      count += 1
      value = $2
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^"|"$/, "", value)
    }
    END { if (count != 1 || value == "") exit 2; print value }
  ' "$POSTGRES_SOURCE_TOML")" || {
    printf 'PostgreSQL source manifest must contain one version: %s\n' \
      "$POSTGRES_SOURCE_TOML" >&2
    return 2
  }
  archive_sha256="$(awk -F= '
    $1 ~ /^[[:space:]]*sha256[[:space:]]*$/ {
      count += 1
      value = $2
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^"|"$/, "", value)
    }
    END { if (count != 1 || value == "") exit 2; print value }
  ' "$POSTGRES_SOURCE_TOML")" || {
    printf 'PostgreSQL source manifest must contain one SHA-256: %s\n' \
      "$POSTGRES_SOURCE_TOML" >&2
    return 2
  }
  [ "$version" = "$POSTGRES_VERSION" ] && fresh_is_sha256 "$archive_sha256" || {
    printf 'invalid PostgreSQL baseline source identity in %s\n' \
      "$POSTGRES_SOURCE_TOML" >&2
    return 2
  }
  printf '%s:%s\n' "$version" "$archive_sha256"
}

# Validate that BASELINE_DIR is the exact clean Git tree materialized from the
# pinned PostgreSQL archive.  The manifest lives inside the checkout so an
# overridden BASELINE_DIR cannot accidentally inherit another checkout's
# global fingerprint.
fresh_require_postgres_baseline() {
  local expected_fingerprint="${1-}"
  local manifest="$BASELINE_DIR/.git/oliphaunt-baseline.manifest"
  local head
  local tree

  [ "$#" -eq 1 ] && [ -n "$expected_fingerprint" ] || {
    printf 'fresh_require_postgres_baseline requires an expected fingerprint\n' >&2
    return 2
  }
  [ -d "$BASELINE_DIR" ] && [ ! -L "$BASELINE_DIR" ] &&
    [ -d "$BASELINE_DIR/.git" ] && [ ! -L "$BASELINE_DIR/.git" ] &&
    [ -f "$manifest" ] && [ ! -L "$manifest" ] || return 1
  fresh_require_manifest_value "$manifest" schema \
    oliphaunt.wasix-postmaster.postgres-baseline.v1 >/dev/null 2>&1 || return 1
  fresh_require_manifest_value "$manifest" fingerprint \
    "$expected_fingerprint" >/dev/null 2>&1 || return 1
  head="$(git -C "$BASELINE_DIR" rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" || return 1
  tree="$(git -C "$BASELINE_DIR" rev-parse --verify 'HEAD^{tree}' 2>/dev/null)" || return 1
  fresh_require_manifest_value "$manifest" head "$head" >/dev/null 2>&1 || return 1
  fresh_require_manifest_value "$manifest" tree "$tree" >/dev/null 2>&1 || return 1
  [ -z "$(git -C "$BASELINE_DIR" status --porcelain=v1 --untracked-files=all --ignored 2>/dev/null)" ] || return 1
  FRESH_POSTGRES_BASELINE_HEAD="$head"
  FRESH_POSTGRES_BASELINE_TREE="$tree"
}

fresh_host_arch() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) echo "darwin-arm64" ;;
    Darwin-x86_64) echo "darwin-amd64" ;;
    Linux-x86_64) echo "linux-amd64" ;;
    Linux-aarch64|Linux-arm64) echo "linux-arm64" ;;
    *)
      echo "unsupported host for patched Wasmer runtime: $(uname -s)-$(uname -m)" >&2
      return 2
      ;;
  esac
}

fresh_host_abi() {
  local ldd_version
  local glibc_version

  case "$(uname -s)" in
    Darwin) echo "darwin" ;;
    Linux)
      glibc_version="$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"
      if [ -n "$glibc_version" ]; then
        echo "linux-gnu"
        return
      fi
      if command -v ldd >/dev/null 2>&1; then
        ldd_version="$(ldd --version 2>&1 | head -1 || true)"
        case "$ldd_version" in
          *musl*|*Musl*) echo "linux-musl"; return ;;
          *GLIBC*|*glibc*|*GNU*) echo "linux-gnu"; return ;;
        esac
      fi
      echo "unable to identify Linux libc ABI for patched Wasmer receipt" >&2
      return 2
      ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows-gnu" ;;
    *)
      echo "unsupported host ABI for patched Wasmer receipt: $(uname -s)" >&2
      return 2
      ;;
  esac
}

fresh_release_target_for_host_arch() {
  case "$1" in
    darwin-arm64) echo "macos-arm64" ;;
    linux-arm64) echo "linux-arm64-gnu" ;;
    linux-amd64) echo "linux-x64-gnu" ;;
    *)
      printf 'unsupported WASIX postmaster release host: %s\n' "$1" >&2
      return 2
      ;;
  esac
}

fresh_release_target() {
  local host_arch
  host_arch="$(fresh_host_arch)" || return
  fresh_release_target_for_host_arch "$host_arch"
}

fresh_release_target_triple() {
  case "$1" in
    linux-arm64-gnu) echo "aarch64-unknown-linux-gnu" ;;
    linux-x64-gnu) echo "x86_64-unknown-linux-gnu" ;;
    macos-arm64) echo "aarch64-apple-darwin" ;;
    *)
      printf 'unsupported WASIX postmaster release target: %s\n' "$1" >&2
      return 2
      ;;
  esac
}

fresh_manifest_value() {
  local manifest="$1"
  local key="$2"

  awk -v expected_key="$key" '
    {
      separator = index($0, "=")
      if (separator > 0 && substr($0, 1, separator - 1) == expected_key) {
        count += 1
        value = substr($0, separator + 1)
      }
    }
    END {
      if (count != 1) exit 2
      print value
    }
  ' "$manifest"
}

fresh_require_manifest_value() {
  local manifest="$1"
  local key="$2"
  local expected="$3"
  local actual

  if ! actual="$(fresh_manifest_value "$manifest" "$key")"; then
    printf 'manifest must contain exactly one %s field: %s\n' "$key" "$manifest" >&2
    return 2
  fi
  if [ "$actual" != "$expected" ]; then
    printf 'manifest %s mismatch: expected %s, got %s\n' \
      "$key" "$expected" "${actual:-<empty>}" >&2
    return 2
  fi
}

fresh_validate_wasmer_build_receipt_shape() {
  local receipt="$1"

  awk -F= '
    BEGIN {
      split("schema build_recipe_sha256 wasmer_source_commit wasmer_napi_commit wasmer_test_files_commit wasmer_spec_commit wasmer_patch_sha256 wasmer_prepared_signature_sha256 wasmer_cargo_lock_sha256 wasmer_binary_sha256 wasmer_features wasmer_headless_binary_sha256 wasmer_headless_features runtime_abi_id artifact_abi_version wasix_libc_source_commit wasix_libc_patch_sha256 wasix_libc_prepared_signature_sha256 sysroot_carrier_manifest_sha256 sysroot_variant sysroot_variant_manifest_sha256 host_platform host_abi rustc_host rustc_version llvm_version", fields, " ")
      for (i in fields) allowed[fields[i]] = 1
    }
    index($0, "\r") || NF != 2 || $1 == "" || $2 == "" || !($1 in allowed) || seen[$1]++ || $1 != fields[NR] { exit 2 }
    END {
      if (NR != 26) exit 2
      for (key in allowed) if (seen[key] != 1) exit 2
    }
  ' "$receipt" || {
    printf 'invalid or non-canonical Wasmer build receipt: %s\n' "$receipt" >&2
    return 2
  }
}

fresh_validate_postmaster_executor_build_receipt_shape() {
  local receipt="$1"

  awk -F= '
    BEGIN {
      split("schema build_recipe_sha256 wasmer_build_receipt_sha256 wasmer_source_commit wasmer_patch_sha256 wasmer_prepared_signature_sha256 wasmer_cargo_lock_sha256 runtime_abi_id artifact_abi_version executor_package executor_binary executor_features executor_role runtime_policy_id cli_contract executor_binary_sha256 start_proof_binary start_proof_features start_proof_policy start_proof_binary_sha256 memory_profile_binary memory_profile_features linear_memory_profile_id memory_profile_binary_sha256 postmaster_compiler_binary postmaster_compiler_features compiler_cpu_policy compiler_cpu_features postmaster_compiler_binary_sha256 host_platform host_abi rustc_host rustc_version", fields, " ")
      for (i in fields) allowed[fields[i]] = 1
    }
    index($0, "\r") || NF != 2 || $1 == "" || $2 == "" || !($1 in allowed) || seen[$1]++ || $1 != fields[NR] { exit 2 }
    END {
      if (NR != 33) exit 2
      for (key in allowed) if (seen[key] != 1) exit 2
    }
  ' "$receipt" || {
    printf 'invalid or non-canonical postmaster executor build receipt: %s\n' "$receipt" >&2
    return 2
  }
}

fresh_is_sha256() {
  [ "${#1}" -eq 64 ] || return 1
  case "$1" in
    *[!0-9a-f]*) return 1 ;;
    *) return 0 ;;
  esac
}

fresh_require_receipt_sha256() {
  local receipt="$1"
  local key="$2"
  local value

  value="$(fresh_manifest_value "$receipt" "$key")" || {
    printf 'Wasmer build receipt must contain exactly one %s field: %s\n' "$key" "$receipt" >&2
    return 2
  }
  fresh_is_sha256 "$value" || {
    printf 'Wasmer build receipt %s is not a lowercase SHA-256: %s\n' "$key" "$receipt" >&2
    return 2
  }
}

fresh_sha256_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

fresh_require_canonical_directory() {
  local label="${1-}"
  local path="${2-}"
  local resolved

  [ "$#" -eq 2 ] && [ -n "$label" ] && [ -n "$path" ] && [ "${path#/}" != "$path" ] || {
    printf 'canonical directory validation requires a label and absolute path\n' >&2
    return 2
  }
  resolved="$(cd -P -- "$path" 2>/dev/null && pwd -P)" || {
    printf '%s is not an existing directory: %s\n' "$label" "$path" >&2
    return 2
  }
  [ "$resolved" = "$path" ] || {
    printf '%s is not an absolute canonical directory: %s (resolved %s)\n' \
      "$label" "$path" "$resolved" >&2
    return 2
  }
}

fresh_wasix_builder_recipe_sha256() {
  local file_sha256
  local identity_mode
  local path
  local recipe_paths=(
    "$WASIX_TOOLCHAIN_ROOT/docker/Dockerfile"
    "$WASIX_TOOLCHAIN_ROOT/docker/isrg-root-x1.pem"
    "$WASIX_TOOLCHAIN_ROOT/docker/install-pinned-apt-packages.sh"
    "$WASIX_TOOLCHAIN_ROOT/docker/install-pinned-wasixcc.sh"
    "$WASIX_TOOLCHAIN_ROOT/docker/pinned-wasixcc-assets.tsv"
  )

  fresh_require_canonical_directory REPO_ROOT "$REPO_ROOT" || return
  fresh_require_canonical_directory WASIX_TOOLCHAIN_ROOT "$WASIX_TOOLCHAIN_ROOT" || return
  {
    printf '%s\0%s\0' schema oliphaunt.wasix-builder-recipe.v1
    for path in "${recipe_paths[@]}"; do
      [ -f "$path" ] && [ ! -L "$path" ] || {
        printf 'missing regular WASIX builder-recipe input: %s\n' "$path" >&2
        return 2
      }
      file_sha256="$(fresh_wasmer_bin_hash "$path")" || return
      fresh_is_sha256 "$file_sha256" || {
        printf 'failed to hash WASIX builder-recipe input: %s\n' "$path" >&2
        return 2
      }
      if [ -x "$path" ]; then
        identity_mode=executable
      else
        identity_mode=data
      fi
      printf '%s\0%s\0%s\0' "${path#"$WASIX_TOOLCHAIN_ROOT"/}" "$file_sha256" "$identity_mode"
    done
  } | fresh_sha256_stream
}

fresh_runtime_build_recipe_sha256() {
  local builder_recipe_sha256
  local file_sha256
  local identity_path
  local identity_mode
  local path
  local recipe_paths=(
    "$FRESH_ROOT/lib/common.sh"
    "$FRESH_ROOT/sources.lock.toml"
    "$FRESH_ROOT/runtime/capabilities.tsv"
    "$FRESH_POSTMASTER_TASK_BUDGET_PROFILE"
    "$FRESH_POSTMASTER_RUNTIME_FOOTPRINT_PROFILE"
    "$FRESH_ROOT/runtime/bin/prepare-upstream-checkouts.sh"
    "$FRESH_ROOT/runtime/bin/build-runtime.sh"
    "$FRESH_ROOT/runtime/bin/build-patched-wasix-libc-sysroot.sh"
    "$FRESH_ROOT/runtime/bin/validate-runtime-capabilities.sh"
    "$FRESH_ROOT/runtime/bin/verify-runtime-execution-ownership.py"
    "$FRESH_ROOT/runtime/bin/verify-runtime-state-ownership.py"
    "$FRESH_ROOT/runtime/bin/verify-source-lock.py"
    "$WASIX_TOOLCHAIN_ROOT/docker_wasix_env.sh"
  )

  fresh_require_canonical_directory FRESH_ROOT "$FRESH_ROOT" || return
  fresh_require_canonical_directory REPO_ROOT "$REPO_ROOT" || return
  fresh_require_canonical_directory WASIX_TOOLCHAIN_ROOT "$WASIX_TOOLCHAIN_ROOT" || return

  for path in "${recipe_paths[@]}"; do
    [ -f "$path" ] && [ ! -L "$path" ] || {
      printf 'missing regular runtime build-recipe input: %s\n' "$path" >&2
      return 2
    }
  done
  builder_recipe_sha256="$(fresh_wasix_builder_recipe_sha256)" || return
  fresh_is_sha256 "$builder_recipe_sha256" || {
    printf 'failed to derive WASIX builder-recipe identity\n' >&2
    return 2
  }
  {
    printf '%s\0%s\0' schema oliphaunt.wasix-postmaster.runtime-build-recipe.v3
    printf '%s\0%s\0' wasix-builder-recipe-sha256 "$builder_recipe_sha256"
    for path in "${recipe_paths[@]}"; do
      case "$path" in
        "$FRESH_ROOT"/*)
          identity_path="$(fresh_project_source_identity_path "$path")" || return
          ;;
        "$REPO_ROOT"/*)
          identity_path="${path#"$REPO_ROOT"/}"
          ;;
        *)
          # An explicitly overridden external toolchain remains bound to its
          # absolute location. Product-local sources must always use the
          # canonical repository identity above so a byte-identical frozen
          # measurement closure validates the same receipt.
          identity_path="$path"
          ;;
      esac
      file_sha256="$(fresh_wasmer_bin_hash "$path")" || return
      fresh_is_sha256 "$file_sha256" || {
        printf 'failed to hash runtime build-recipe input: %s\n' "$path" >&2
        return 2
      }
      if [ -x "$path" ]; then
        identity_mode=executable
      else
        identity_mode=data
      fi
      printf '%s\0%s\0%s\0' "$identity_path" "$file_sha256" "$identity_mode"
    done
  } | fresh_sha256_stream
}

# This identity is embedded into both native executors at compile time and into
# every sealed AOT carrier.  Keep the serialization explicit and
# length-unambiguous: changing a source pin, patch, Cargo resolution, native
# target/ABI, feature set, artifact ABI, or tracked build recipe changes the
# identity and makes old compiler output fail closed under the new executor.
fresh_runtime_abi_id() {
  local cargo_lock_sha256="$1"
  local target_triple="$2"
  local host_platform="$3"
  local host_abi="$4"
  local wasmer_patch="$FRESH_ROOT/runtime/patches/wasmer/0001-postgres-wasix-blockers.patch"
  local wasix_libc_patch="$FRESH_ROOT/runtime/patches/wasix-libc/0001-postgres-wasix-blockers.patch"

  fresh_is_sha256 "$cargo_lock_sha256" || {
    printf 'runtime ABI Cargo.lock identity is not a lowercase SHA-256\n' >&2
    return 2
  }
  [ -n "$target_triple" ] && [ -n "$host_platform" ] && [ -n "$host_abi" ] || {
    printf 'runtime ABI target and host identity fields must be nonempty\n' >&2
    return 2
  }
  [ -f "$wasmer_patch" ] && [ ! -L "$wasmer_patch" ] || return 2
  [ -f "$wasix_libc_patch" ] && [ ! -L "$wasix_libc_patch" ] || return 2

  {
    printf '%s\0%s\0' schema oliphaunt.wasix-postmaster.runtime-abi.v1
    printf '%s\0%s\0' wasmer-source-commit "$FRESH_WASMER_SOURCE_COMMIT"
    printf '%s\0%s\0' wasmer-napi-commit "$FRESH_WASMER_NAPI_COMMIT"
    printf '%s\0%s\0' wasmer-test-files-commit "$FRESH_WASMER_TEST_FILES_COMMIT"
    printf '%s\0%s\0' wasmer-spec-commit "$FRESH_WASMER_SPEC_COMMIT"
    printf '%s\0%s\0' wasmer-patch-sha256 "$(fresh_wasmer_bin_hash "$wasmer_patch")"
    printf '%s\0%s\0' wasmer-cargo-lock-sha256 "$cargo_lock_sha256"
    printf '%s\0%s\0' wasix-libc-source-commit "$FRESH_WASIX_LIBC_SOURCE_COMMIT"
    printf '%s\0%s\0' wasix-libc-patch-sha256 "$(fresh_wasmer_bin_hash "$wasix_libc_patch")"
    printf '%s\0%s\0' sysroot-variant "$WASIXCC_SYSROOT_VARIANT"
    printf '%s\0%s\0' target-triple "$target_triple"
    printf '%s\0%s\0' host-platform "$host_platform"
    printf '%s\0%s\0' host-abi "$host_abi"
    printf '%s\0%s\0' wasmer-version "$FRESH_WASMER_VERSION"
    printf '%s\0%s\0' wasmer-wasix-version "$FRESH_WASMER_WASIX_VERSION"
    printf '%s\0%s\0' compiler-features "$FRESH_WASMER_COMPILER_FEATURES"
    printf '%s\0%s\0' headless-features "$FRESH_WASMER_HEADLESS_FEATURES"
    printf '%s\0%s\0' artifact-abi-version "$FRESH_WASMER_ARTIFACT_ABI_VERSION"
    printf '%s\0%s\0' build-recipe-sha256 "$(fresh_runtime_build_recipe_sha256)"
  } | fresh_sha256_stream
}

fresh_runtime_worktree_state_hash() {
  local root="$1"
  local path

  {
    git -C "$root" diff --binary HEAD
    git -C "$root" ls-files --others --exclude-standard -z |
      while IFS= read -r -d '' path; do
        printf 'untracked:%s\n' "$path"
        fresh_wasmer_bin_hash "$root/$path"
      done
  } | fresh_sha256_stream
}

fresh_require_prepared_worktree() {
  local label="$1"
  local root="$2"
  local source_commit="$3"
  local patch_hash="$4"
  local extra_signature="$5"
  local signature_file="$6"
  local expected_signature

  [ -d "$root/.git" ] && [ ! -L "$root" ] || {
    printf 'missing prepared %s worktree: %s\n' "$label" "$root" >&2
    return 2
  }
  [ -f "$signature_file" ] && [ ! -L "$signature_file" ] || {
    printf 'missing regular prepared %s signature: %s\n' "$label" "$signature_file" >&2
    return 2
  }
  [ "$(git -C "$root" rev-parse HEAD)" = "$source_commit" ] || {
    printf 'prepared %s worktree is not at %s: %s\n' "$label" "$source_commit" "$root" >&2
    return 2
  }
  expected_signature="$source_commit:$patch_hash:$extra_signature:$(fresh_runtime_worktree_state_hash "$root")"
  [ "$(cat "$signature_file")" = "$expected_signature" ] || {
    printf 'prepared %s worktree no longer matches its source-and-patch signature: %s\n' "$label" "$root" >&2
    return 2
  }
}

# Builder-only provenance verification. Runtime selection does not depend on
# disposable source worktrees or the compilation sysroot being present.
fresh_require_local_wasmer_build_state() {
  local receipt="$1"
  local runtime_root="$FRESH_WORK_ROOT/runtime"
  local wasmer_root="$runtime_root/wasmer"
  local wasix_libc_root="$runtime_root/wasix-libc"
  local wasmer_signature="$runtime_root/.prepared/wasmer.signature"
  local wasix_libc_signature="$runtime_root/.prepared/wasix-libc.signature"
  local carrier_manifest="$WASIXCC_SYSROOT_PREFIX/.oliphaunt-patched-sysroots.manifest"
  local variant_manifest="$WASIXCC_SYSROOT/.oliphaunt-patched-sysroot.manifest"
  local wasmer_patch="$FRESH_ROOT/runtime/patches/wasmer/0001-postgres-wasix-blockers.patch"
  local wasix_libc_patch="$FRESH_ROOT/runtime/patches/wasix-libc/0001-postgres-wasix-blockers.patch"
  local wasmer_patch_hash
  local wasix_libc_patch_hash

  fresh_require_command git || return
  wasmer_patch_hash="$(fresh_wasmer_bin_hash "$wasmer_patch")"
  wasix_libc_patch_hash="$(fresh_wasmer_bin_hash "$wasix_libc_patch")"
  fresh_require_prepared_worktree \
    Wasmer "$wasmer_root" "$FRESH_WASMER_SOURCE_COMMIT" "$wasmer_patch_hash" \
    "$FRESH_WASMER_NAPI_COMMIT:$FRESH_WASMER_TEST_FILES_COMMIT:$FRESH_WASMER_SPEC_COMMIT" \
    "$wasmer_signature" || return
  fresh_require_prepared_worktree \
    wasix-libc "$wasix_libc_root" "$FRESH_WASIX_LIBC_SOURCE_COMMIT" "$wasix_libc_patch_hash" \
    "" "$wasix_libc_signature" || return
  [ -f "$wasmer_root/Cargo.lock" ] && [ ! -L "$wasmer_root/Cargo.lock" ] || {
    printf 'missing regular Wasmer Cargo.lock: %s\n' "$wasmer_root/Cargo.lock" >&2
    return 2
  }
  fresh_require_patched_wasixcc_sysroot || return
  fresh_require_manifest_value \
    "$receipt" wasmer_prepared_signature_sha256 "$(fresh_wasmer_bin_hash "$wasmer_signature")" || return
  fresh_require_manifest_value \
    "$receipt" build_recipe_sha256 "$(fresh_runtime_build_recipe_sha256)" || return
  fresh_require_manifest_value \
    "$receipt" wasmer_cargo_lock_sha256 "$(fresh_wasmer_bin_hash "$wasmer_root/Cargo.lock")" || return
  fresh_require_manifest_value \
    "$receipt" wasix_libc_prepared_signature_sha256 "$(fresh_wasmer_bin_hash "$wasix_libc_signature")" || return
  fresh_require_manifest_value \
    "$receipt" sysroot_carrier_manifest_sha256 "$(fresh_wasmer_bin_hash "$carrier_manifest")" || return
  fresh_require_manifest_value \
    "$receipt" sysroot_variant_manifest_sha256 "$(fresh_wasmer_bin_hash "$variant_manifest")" || return
}

fresh_require_patched_wasmer_receipt() {
  local manifest="${WASMER_BUILD_RECEIPT:-$FRESH_WASMER_BUILD_RECEIPT}"
  local wasmer_patch="$FRESH_ROOT/runtime/patches/wasmer/0001-postgres-wasix-blockers.patch"
  local wasix_libc_patch="$FRESH_ROOT/runtime/patches/wasix-libc/0001-postgres-wasix-blockers.patch"

  [ -f "$manifest" ] && [ ! -L "$manifest" ] || {
    printf 'missing regular Wasmer build receipt: %s\n' "$manifest" >&2
    printf 'Run %s/runtime/bin/build-runtime.sh, or provide a matching WASMER_BUILD_RECEIPT.\n' "$FRESH_ROOT" >&2
    return 2
  }
  [ -f "$wasmer_patch" ] && [ ! -L "$wasmer_patch" ] || return 2
  [ -f "$wasix_libc_patch" ] && [ ! -L "$wasix_libc_patch" ] || return 2

  fresh_validate_wasmer_build_receipt_shape "$manifest" || return
  fresh_require_manifest_value \
    "$manifest" schema oliphaunt.wasix-postmaster.wasmer-build.v2 || return
  fresh_require_manifest_value \
    "$manifest" build_recipe_sha256 "$(fresh_runtime_build_recipe_sha256)" || return
  fresh_require_manifest_value \
    "$manifest" wasmer_source_commit "$FRESH_WASMER_SOURCE_COMMIT" || return
  fresh_require_manifest_value \
    "$manifest" wasmer_napi_commit "$FRESH_WASMER_NAPI_COMMIT" || return
  fresh_require_manifest_value \
    "$manifest" wasmer_test_files_commit "$FRESH_WASMER_TEST_FILES_COMMIT" || return
  fresh_require_manifest_value \
    "$manifest" wasmer_spec_commit "$FRESH_WASMER_SPEC_COMMIT" || return
  fresh_require_manifest_value \
    "$manifest" wasix_libc_source_commit "$FRESH_WASIX_LIBC_SOURCE_COMMIT" || return
  fresh_require_manifest_value \
    "$manifest" wasmer_patch_sha256 "$(fresh_wasmer_bin_hash "$wasmer_patch")" || return
  fresh_require_manifest_value \
    "$manifest" wasix_libc_patch_sha256 "$(fresh_wasmer_bin_hash "$wasix_libc_patch")" || return
  fresh_require_manifest_value \
    "$manifest" wasmer_features "$FRESH_WASMER_COMPILER_FEATURES" || return
  fresh_require_manifest_value \
    "$manifest" wasmer_headless_features "$FRESH_WASMER_HEADLESS_FEATURES" || return
  fresh_require_manifest_value \
    "$manifest" artifact_abi_version "$FRESH_WASMER_ARTIFACT_ABI_VERSION" || return
  fresh_require_manifest_value \
    "$manifest" host_platform "$(fresh_host_arch)" || return
  fresh_require_manifest_value \
    "$manifest" host_abi "$(fresh_host_abi)" || return
  fresh_require_manifest_value \
    "$manifest" runtime_abi_id "$(fresh_runtime_abi_id \
      "$(fresh_manifest_value "$manifest" wasmer_cargo_lock_sha256)" \
      "$(fresh_manifest_value "$manifest" rustc_host)" \
      "$(fresh_manifest_value "$manifest" host_platform)" \
      "$(fresh_manifest_value "$manifest" host_abi)")" || return

  local hash_field
  for hash_field in \
    build_recipe_sha256 \
    wasmer_patch_sha256 \
    wasmer_prepared_signature_sha256 \
    wasmer_cargo_lock_sha256 \
    wasmer_binary_sha256 \
    wasmer_headless_binary_sha256 \
    runtime_abi_id \
    wasix_libc_patch_sha256 \
    wasix_libc_prepared_signature_sha256 \
    sysroot_carrier_manifest_sha256 \
    sysroot_variant_manifest_sha256
  do
    fresh_require_receipt_sha256 "$manifest" "$hash_field" || return
  done
}

fresh_require_patched_wasmer() {
  local wasmer_bin="$1"
  local manifest="${WASMER_BUILD_RECEIPT:-$FRESH_WASMER_BUILD_RECEIPT}"

  [ -f "$wasmer_bin" ] && [ ! -L "$wasmer_bin" ] && [ -x "$wasmer_bin" ] || {
    printf 'missing executable patched Wasmer binary: %s\n' "$wasmer_bin" >&2
    return 2
  }
  fresh_require_patched_wasmer_receipt || return
  fresh_require_manifest_value \
    "$manifest" wasmer_binary_sha256 "$(fresh_wasmer_bin_hash "$wasmer_bin")"
}

fresh_require_patched_wasmer_headless() {
  local wasmer_bin="$1"
  local manifest="${WASMER_BUILD_RECEIPT:-$FRESH_WASMER_BUILD_RECEIPT}"

  [ -f "$wasmer_bin" ] && [ ! -L "$wasmer_bin" ] && [ -x "$wasmer_bin" ] || {
    printf 'missing executable patched headless Wasmer binary: %s\n' "$wasmer_bin" >&2
    return 2
  }
  fresh_require_patched_wasmer_receipt || return
  fresh_require_manifest_value \
    "$manifest" wasmer_headless_binary_sha256 "$(fresh_wasmer_bin_hash "$wasmer_bin")"
}

# Select the product-specific sealed-postmaster executor independently from the
# general compiler-free Wasmer CLI.  Its receipt binds the exact parent runtime
# receipt as well as the isolated Cargo feature/package build, so a carrier can
# retain the established AOT manifest format without treating two native
# executors as interchangeable.
fresh_require_patched_postmaster_executor() {
  local executor_bin="$1"
  local executor_receipt="${2:-$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT}"
  local wasmer_receipt="${3:-${WASMER_BUILD_RECEIPT:-$FRESH_WASMER_BUILD_RECEIPT}}"
  local hash_field

  [ -f "$executor_bin" ] && [ ! -L "$executor_bin" ] && [ -x "$executor_bin" ] || {
    printf 'missing executable postmaster executor binary: %s\n' "$executor_bin" >&2
    return 2
  }
  [ -f "$executor_receipt" ] && [ ! -L "$executor_receipt" ] || {
    printf 'missing regular postmaster executor build receipt: %s\n' "$executor_receipt" >&2
    return 2
  }
  [ -f "$wasmer_receipt" ] && [ ! -L "$wasmer_receipt" ] || {
    printf 'missing regular parent Wasmer build receipt: %s\n' "$wasmer_receipt" >&2
    return 2
  }

  WASMER_BUILD_RECEIPT="$wasmer_receipt" fresh_require_patched_wasmer_receipt || return
  fresh_validate_postmaster_executor_build_receipt_shape "$executor_receipt" || return
  fresh_require_manifest_value \
    "$executor_receipt" schema \
    oliphaunt.wasix-postmaster.postmaster-executor-build.v3 || return
  fresh_require_manifest_value \
    "$executor_receipt" build_recipe_sha256 \
    "$(fresh_runtime_build_recipe_sha256)" || return
  fresh_require_manifest_value \
    "$executor_receipt" wasmer_build_receipt_sha256 \
    "$(fresh_wasmer_bin_hash "$wasmer_receipt")" || return
  fresh_require_manifest_value \
    "$executor_receipt" wasmer_source_commit "$FRESH_WASMER_SOURCE_COMMIT" || return
  fresh_require_manifest_value \
    "$executor_receipt" wasmer_patch_sha256 \
    "$(fresh_wasmer_bin_hash "$FRESH_ROOT/runtime/patches/wasmer/0001-postgres-wasix-blockers.patch")" || return
  fresh_require_manifest_value \
    "$executor_receipt" wasmer_prepared_signature_sha256 \
    "$(fresh_manifest_value "$wasmer_receipt" wasmer_prepared_signature_sha256)" || return
  fresh_require_manifest_value \
    "$executor_receipt" wasmer_cargo_lock_sha256 \
    "$(fresh_manifest_value "$wasmer_receipt" wasmer_cargo_lock_sha256)" || return
  fresh_require_manifest_value \
    "$executor_receipt" runtime_abi_id \
    "$(fresh_manifest_value "$wasmer_receipt" runtime_abi_id)" || return
  fresh_require_manifest_value \
    "$executor_receipt" artifact_abi_version "$FRESH_WASMER_ARTIFACT_ABI_VERSION" || return
  fresh_require_manifest_value \
    "$executor_receipt" executor_package "$FRESH_POSTMASTER_EXECUTOR_PACKAGE" || return
  fresh_require_manifest_value \
    "$executor_receipt" executor_binary "$FRESH_POSTMASTER_EXECUTOR_BINARY" || return
  fresh_require_manifest_value \
    "$executor_receipt" executor_features "$FRESH_POSTMASTER_EXECUTOR_FEATURES" || return
  fresh_require_manifest_value \
    "$executor_receipt" executor_role "$FRESH_POSTMASTER_EXECUTOR_ROLE" || return
  fresh_require_manifest_value \
    "$executor_receipt" runtime_policy_id \
    "$FRESH_POSTMASTER_EXECUTOR_RUNTIME_POLICY_ID" || return
  fresh_require_manifest_value \
    "$executor_receipt" cli_contract "$FRESH_POSTMASTER_EXECUTOR_CLI_CONTRACT" || return
  fresh_require_manifest_value \
    "$executor_receipt" executor_binary_sha256 \
    "$(fresh_wasmer_bin_hash "$executor_bin")" || return
  fresh_require_manifest_value \
    "$executor_receipt" start_proof_binary "$FRESH_START_PROOF_BINARY" || return
  fresh_require_manifest_value \
    "$executor_receipt" start_proof_features "$FRESH_START_PROOF_FEATURES" || return
  fresh_require_manifest_value \
    "$executor_receipt" start_proof_policy "$FRESH_START_PROOF_POLICY" || return
  fresh_require_manifest_value \
    "$executor_receipt" memory_profile_binary "$FRESH_MEMORY_PROFILE_BINARY" || return
  fresh_require_manifest_value \
    "$executor_receipt" memory_profile_features "$FRESH_MEMORY_PROFILE_FEATURES" || return
  fresh_require_manifest_value \
    "$executor_receipt" linear_memory_profile_id "$FRESH_LINEAR_MEMORY_PROFILE_ID" || return
  fresh_require_manifest_value \
    "$executor_receipt" postmaster_compiler_binary "$FRESH_POSTMASTER_COMPILER_BINARY" || return
  fresh_require_manifest_value \
    "$executor_receipt" postmaster_compiler_features "$FRESH_POSTMASTER_COMPILER_FEATURES" || return
  fresh_require_manifest_value \
    "$executor_receipt" compiler_cpu_policy generic-baseline || return
  fresh_require_manifest_value \
    "$executor_receipt" compiler_cpu_features none || return
  fresh_require_manifest_value \
    "$executor_receipt" host_platform "$(fresh_host_arch)" || return
  fresh_require_manifest_value \
    "$executor_receipt" host_abi "$(fresh_host_abi)" || return
  fresh_require_manifest_value \
    "$executor_receipt" rustc_host \
    "$(fresh_manifest_value "$wasmer_receipt" rustc_host)" || return
  fresh_require_manifest_value \
    "$executor_receipt" rustc_version \
    "$(fresh_manifest_value "$wasmer_receipt" rustc_version)" || return

  for hash_field in \
    build_recipe_sha256 \
    wasmer_build_receipt_sha256 \
    wasmer_patch_sha256 \
    wasmer_prepared_signature_sha256 \
    wasmer_cargo_lock_sha256 \
    runtime_abi_id \
    executor_binary_sha256 \
    start_proof_binary_sha256 \
    memory_profile_binary_sha256 \
    postmaster_compiler_binary_sha256
  do
    fresh_require_receipt_sha256 "$executor_receipt" "$hash_field" || return
  done
}

fresh_require_memory_profile_tool() {
  local profile_bin="${1:-$FRESH_MEMORY_PROFILE_BIN}"
  local executor_receipt="${2:-$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT}"
  local actual_id

  [ -f "$profile_bin" ] && [ ! -L "$profile_bin" ] && [ -x "$profile_bin" ] || {
    printf 'missing executable linear-memory profile tool: %s\n' "$profile_bin" >&2
    return 2
  }
  fresh_validate_postmaster_executor_build_receipt_shape "$executor_receipt" || return
  fresh_require_manifest_value \
    "$executor_receipt" schema \
    oliphaunt.wasix-postmaster.postmaster-executor-build.v3 || return
  fresh_require_manifest_value \
    "$executor_receipt" memory_profile_binary "$FRESH_MEMORY_PROFILE_BINARY" || return
  fresh_require_manifest_value \
    "$executor_receipt" memory_profile_features "$FRESH_MEMORY_PROFILE_FEATURES" || return
  fresh_require_manifest_value \
    "$executor_receipt" linear_memory_profile_id "$FRESH_LINEAR_MEMORY_PROFILE_ID" || return
  fresh_require_manifest_value \
    "$executor_receipt" memory_profile_binary_sha256 \
    "$(fresh_wasmer_bin_hash "$profile_bin")" || return
  actual_id="$("$profile_bin" --profile-json | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')" || {
    printf 'could not read linear-memory profile identity from %s\n' "$profile_bin" >&2
    return 2
  }
  [ "$actual_id" = "$FRESH_LINEAR_MEMORY_PROFILE_ID" ] || {
    printf 'linear-memory profile tool identity mismatch: expected %s, got %s\n' \
      "$FRESH_LINEAR_MEMORY_PROFILE_ID" "$actual_id" >&2
    return 2
  }
}

fresh_require_patched_postmaster_compiler() {
  local compiler_bin="${1:-$FRESH_POSTMASTER_COMPILER_BIN}"
  local executor_receipt="${2:-$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT}"
  local wasmer_receipt="${3:-${WASMER_BUILD_RECEIPT:-$FRESH_WASMER_BUILD_RECEIPT}}"
  local executor_bin="${4:-$FRESH_POSTMASTER_EXECUTOR_BIN}"
  local version profile_id

  [ -f "$compiler_bin" ] && [ ! -L "$compiler_bin" ] && [ -x "$compiler_bin" ] || {
    printf 'missing executable postmaster product compiler: %s\n' "$compiler_bin" >&2
    return 2
  }
  fresh_require_patched_postmaster_executor \
    "$executor_bin" "$executor_receipt" "$wasmer_receipt" || return
  fresh_require_manifest_value \
    "$executor_receipt" postmaster_compiler_binary \
    "$FRESH_POSTMASTER_COMPILER_BINARY" || return
  fresh_require_manifest_value \
    "$executor_receipt" postmaster_compiler_features \
    "$FRESH_POSTMASTER_COMPILER_FEATURES" || return
  fresh_require_manifest_value \
    "$executor_receipt" compiler_cpu_policy generic-baseline || return
  fresh_require_manifest_value \
    "$executor_receipt" compiler_cpu_features none || return
  fresh_require_manifest_value \
    "$executor_receipt" postmaster_compiler_binary_sha256 \
    "$(fresh_wasmer_bin_hash "$compiler_bin")" || return
  version="$("$compiler_bin" --version)" || {
    printf 'could not read postmaster product compiler identity: %s\n' \
      "$compiler_bin" >&2
    return 2
  }
  profile_id="${version##* }"
  [ "${version%% *}" = "$FRESH_POSTMASTER_COMPILER_BINARY" ] && \
    [ "$profile_id" = "$FRESH_LINEAR_MEMORY_PROFILE_ID" ] || {
    printf 'postmaster product compiler profile identity differs: %s\n' \
      "${version:-<empty>}" >&2
    return 2
  }
}

fresh_require_start_proof_tool() {
  local proof_bin="${1:-$FRESH_START_PROOF_BIN}"
  local executor_receipt="${2:-$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT}"
  local actual_policy

  [ -f "$proof_bin" ] && [ ! -L "$proof_bin" ] && [ -x "$proof_bin" ] || {
    printf 'missing executable deterministic-start proof tool: %s\n' "$proof_bin" >&2
    return 2
  }
  fresh_validate_postmaster_executor_build_receipt_shape "$executor_receipt" || return
  fresh_require_manifest_value \
    "$executor_receipt" start_proof_binary "$FRESH_START_PROOF_BINARY" || return
  fresh_require_manifest_value \
    "$executor_receipt" start_proof_features "$FRESH_START_PROOF_FEATURES" || return
  fresh_require_manifest_value \
    "$executor_receipt" start_proof_policy "$FRESH_START_PROOF_POLICY" || return
  fresh_require_manifest_value \
    "$executor_receipt" start_proof_binary_sha256 \
    "$(fresh_wasmer_bin_hash "$proof_bin")" || return
  actual_policy="$("$proof_bin" --policy-id)" || return
  [ "$actual_policy" = "$FRESH_START_PROOF_POLICY" ] || {
    printf 'deterministic-start proof policy mismatch: expected %s, got %s\n' \
      "$FRESH_START_PROOF_POLICY" "${actual_policy:-<empty>}" >&2
    return 2
  }
}

fresh_wasmer_bin() {
  local candidate

  if [ -n "${WASMER_BIN:-}" ]; then
    if command -v "$WASMER_BIN" >/dev/null 2>&1; then
      candidate="$(command -v "$WASMER_BIN")"
    elif [ -x "$WASMER_BIN" ]; then
      candidate="$WASMER_BIN"
    else
      echo "WASMER_BIN is set but not executable: $WASMER_BIN" >&2
      return 127
    fi
  else
    candidate="$FRESH_UPSTREAM_WASMER_BIN"
  fi

  fresh_require_patched_wasmer "$candidate" || return
  printf '%s\n' "$candidate"
}

fresh_wasmer_bin_hash() {
  local wasmer_bin="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$wasmer_bin" | awk '{print $1}'
  else
    shasum -a 256 "$wasmer_bin" | awk '{print $1}'
  fi
}

fresh_wasmer_metadata_dir() {
  printf '%s/tools/wasmer-home\n' "$FRESH_WORK_ROOT"
}

fresh_wasmer_metadata_cache_dir() {
  printf '%s/tools/wasmer-cache/metadata\n' "$FRESH_WORK_ROOT"
}

fresh_wasmer_version() {
  local wasmer_bin="$1"
  local metadata_dir
  local metadata_cache_dir

  metadata_dir="$(fresh_wasmer_metadata_dir)"
  metadata_cache_dir="$(fresh_wasmer_metadata_cache_dir)"
  mkdir -p "$metadata_dir" "$metadata_cache_dir"
  env \
    WASMER_DIR="$metadata_dir" \
    WASMER_CACHE_DIR="$metadata_cache_dir" \
    "$wasmer_bin" --version
}

fresh_wasmer_cache_dir() {
  local wasmer_bin="$1"
  if [ -n "${FRESH_PINNED_WASMER_CACHE_DIR:-}" ]; then
    printf '%s\n' "$FRESH_PINNED_WASMER_CACHE_DIR"
    return
  fi
  printf '%s/tools/wasmer-cache/%s\n' "$FRESH_WORK_ROOT" "$(fresh_wasmer_bin_hash "$wasmer_bin")"
}

fresh_wasmer_llvm_opt_suffix() {
  [ "${1:-aggressive}" = aggressive ] || {
    echo "the postmaster product compiler is fixed to aggressive LLVM optimization" >&2
    return 2
  }
  echo opta
}

fresh_normalize_wasmer_compiler() {
  [ "${1:-llvm}" = llvm ] || {
    echo "the postmaster product compiler is fixed to llvm" >&2
    return 2
  }
  echo llvm
}

fresh_wasmer_compiler() {
  printf '%s\n' llvm
}

fresh_wasmer_compiler_cli_flag() {
  fresh_normalize_wasmer_compiler "$1" >/dev/null || return
  printf '%s\n' --llvm
}

fresh_wasmer_cli_has_option() {
  local wasmer_bin="$1"
  local subcommand="$2"
  local option="$3"

  local metadata_dir
  local metadata_cache_dir

  metadata_dir="$(fresh_wasmer_metadata_dir)"
  metadata_cache_dir="$(fresh_wasmer_metadata_cache_dir)"
  mkdir -p "$metadata_dir" "$metadata_cache_dir"

  env \
    WASMER_DIR="$metadata_dir" \
    WASMER_CACHE_DIR="$metadata_cache_dir" \
    "$wasmer_bin" "$subcommand" --help 2>/dev/null |
    grep -Eq "(^|[[:space:]])${option//-/\\-}([[:space:],]|$)"
}

fresh_require_wasmer_compiler_cli() {
  local wasmer_bin="$1"
  local compiler="$2"
  shift 2

  local flag
  flag="$(fresh_wasmer_compiler_cli_flag "$compiler")"

  local subcommand
  for subcommand in "$@"; do
    if ! fresh_wasmer_cli_has_option "$wasmer_bin" "$subcommand" "$flag"; then
      {
        printf 'the postmaster LLVM compiler requires `%s %s`, but `%s %s --help` does not expose that option.\n' \
          "$(basename "$wasmer_bin")" "$flag" "$wasmer_bin" "$subcommand"
        printf 'Build or select the receipt-bound postmaster compiler.\n'
      } >&2
      return 2
    fi
  done
}

fresh_wasmer_compiler_args_for() {
  local wasmer_bin="$1"
  local subcommand="$2"
  shift 2
  local compiler="$1"
  local llvm_opt_level="$2"
  local compiler_threads="$3"
  [ "$llvm_opt_level" = aggressive ] || {
    echo "the postmaster product compiler is fixed to aggressive LLVM optimization" >&2
    return 2
  }

  case "$(fresh_normalize_wasmer_compiler "$compiler")" in
    llvm)
      printf '%s\n' --llvm
      if [ -n "$wasmer_bin" ] &&
        [ -n "$subcommand" ] &&
        fresh_wasmer_cli_has_option "$wasmer_bin" "$subcommand" "--llvm-opt-level"; then
        printf '%s\n' --llvm-opt-level "$llvm_opt_level"
      fi
      ;;
  esac
  if [ -n "$compiler_threads" ]; then
    printf '%s\n' --compiler-threads "$compiler_threads"
  fi
}

fresh_wasmer_compiler_cache_bucket() {
  local compiler="$1"
  local llvm_opt_level="$2"
  local artifact_version="$3"
  [ "$llvm_opt_level" = aggressive ] || {
    echo "the postmaster product compiler is fixed to aggressive LLVM optimization" >&2
    return 2
  }

  case "$(fresh_normalize_wasmer_compiler "$compiler")" in
    llvm)
      printf 'llvm-%s-v%s\n' "$(fresh_wasmer_llvm_opt_suffix "$llvm_opt_level")" "$artifact_version"
      ;;
  esac
}

fresh_wasmer_module_hash() {
  local wasm_path="$1"
  shasum -a 256 "$wasm_path" | awk '{print toupper($1)}'
}

fresh_git_worktree_state_sha256() {
  local excluded_path="${2:-}"
  local file_sha256
  local identity_mode
  local path
  local root="$1"
  local source
  local source_head
  local symlink_target

  source_head="$(git -C "$root" rev-parse --verify 'HEAD^{commit}')" || {
    printf 'not a Git worktree: %s\n' "$root" >&2
    return 2
  }
  {
    printf '%s\0%s\0%s\0' \
      schema oliphaunt.git-worktree-state.v1 "$source_head"
    git -C "$root" diff --binary --full-index --no-ext-diff HEAD -- || return
    git -C "$root" ls-files --others --exclude-standard -z |
      LC_ALL=C sort -z |
      while IFS= read -r -d '' path; do
        [ -n "$excluded_path" ] && [ "$path" = "$excluded_path" ] && continue
        source="$root/$path"
        if [ -L "$source" ]; then
          symlink_target="$(readlink "$source")" || return
          printf 'untracked-symlink\0%s\0%s\0' "$path" "$symlink_target"
        elif [ -f "$source" ]; then
          file_sha256="$(fresh_wasmer_bin_hash "$source")" || return
          fresh_is_sha256 "$file_sha256" || {
            printf 'failed to hash untracked worktree input: %s\n' "$source" >&2
            return 2
          }
          if [ -x "$source" ]; then
            identity_mode=executable
          else
            identity_mode=data
          fi
          printf 'untracked-file\0%s\0%s\0%s\0' \
            "$path" "$file_sha256" "$identity_mode"
        else
          printf 'unsupported untracked worktree entry: %s\n' "$source" >&2
          return 2
        fi
      done || return
  } | fresh_sha256_stream
}

fresh_overlay_digest() {
  local overlay_dir="$FRESH_ROOT/postgres/overlays/wasix-core"
  local optimization_patches_dir="$REPO_ROOT/src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches"
  local optimization_series="$FRESH_ROOT/postgres/main-optimizations.series"
  local patch_name
  local patches_dir="$FRESH_ROOT/postgres/patches"
  local path

  [ -f "$patches_dir/series" ] && [ ! -L "$patches_dir/series" ] || {
    printf 'missing regular PostgreSQL patch series: %s\n' "$patches_dir/series" >&2
    return 2
  }
  [ -f "$optimization_series" ] && [ ! -L "$optimization_series" ] || {
    printf 'missing regular main-optimization series: %s\n' "$optimization_series" >&2
    return 2
  }
  while IFS= read -r patch_name || [ -n "$patch_name" ]; do
    case "$patch_name" in
      ''|'#'*) continue ;;
      */*)
        printf 'unsafe main-optimization patch entry: %s\n' "$patch_name" >&2
        return 2
        ;;
    esac
    path="$optimization_patches_dir/$patch_name"
    [ -f "$path" ] && [ ! -L "$path" ] || {
      printf 'missing regular main-optimization patch: %s\n' "$path" >&2
      return 2
    }
  done <"$optimization_series"

  {
    printf '%s\0%s\0' schema oliphaunt.wasix-postmaster.overlay.v2
    if [ -d "$overlay_dir" ]; then
      while IFS= read -r -d '' path; do
        printf 'overlay\0%s\0%s\0' \
          "${path#"$overlay_dir"/}" "$(fresh_wasmer_bin_hash "$path")"
      done < <(find "$overlay_dir" -type f -print0 | LC_ALL=C sort -z)
    fi
    printf 'series\0local\0%s\0' "$(fresh_wasmer_bin_hash "$patches_dir/series")"
    if [ -d "$patches_dir" ]; then
      while IFS= read -r -d '' path; do
        printf 'patch\0local/%s\0%s\0' \
          "${path#"$patches_dir"/}" "$(fresh_wasmer_bin_hash "$path")"
      done < <(find "$patches_dir" -type f -name '*.patch' -print0 | LC_ALL=C sort -z)
    fi
    printf 'series\0main-optimizations\0%s\0' \
      "$(fresh_wasmer_bin_hash "$optimization_series")"
    while IFS= read -r patch_name || [ -n "$patch_name" ]; do
      case "$patch_name" in
        ''|'#'*) continue ;;
      esac
      path="$optimization_patches_dir/$patch_name"
      printf 'patch\0main-optimizations/%s\0%s\0' \
        "$patch_name" "$(fresh_wasmer_bin_hash "$path")"
    done <"$optimization_series"
  } | fresh_sha256_stream
}

fresh_write_report_header() {
  local report="$1"
  local title="$2"
  mkdir -p "$(dirname "$report")"
  {
    printf '# %s\n\n' "$title"
    printf -- '- Generated: `%s`\n' "$(fresh_timestamp)"
    printf -- '- Repository: `%s`\n' "$REPO_ROOT"
    printf -- '- Project source root: `%s`\n' "$FRESH_ROOT"
    printf -- '- Generated work root: `%s`\n' "$FRESH_WORK_ROOT"
    printf -- '- PostgreSQL tag: `%s`\n\n' "$POSTGRES_TAG"
  } >"$report"
}

fresh_ensure_docker_image() {
  local docker_bin
  local actual_recipe
  local expected_recipe
  local image="${1:-$FRESH_WASIX_DOCKER_IMAGE}"
  local label=dev.oliphaunt.wasix-builder.recipe-sha256
  local context="$WASIX_TOOLCHAIN_ROOT/docker"
  docker_bin="$(fresh_docker_bin)"
  expected_recipe="$(fresh_wasix_builder_recipe_sha256)" || return
  actual_recipe="$("$docker_bin" image inspect \
    --format "{{ index .Config.Labels \"$label\" }}" "$image" 2>/dev/null || true)"
  if [ "$actual_recipe" = "$expected_recipe" ]; then
    return
  fi
  "$docker_bin" build \
    --label "$label=$expected_recipe" \
    -f "$context/Dockerfile" \
    -t "$image" \
    "$context" || return
  actual_recipe="$("$docker_bin" image inspect \
    --format "{{ index .Config.Labels \"$label\" }}" "$image" 2>/dev/null || true)"
  [ "$actual_recipe" = "$expected_recipe" ] || {
    printf 'WASIX builder image recipe label mismatch after build: %s\n' "$image" >&2
    return 2
  }
}

fresh_wasix_builder_image_id() {
  local actual_recipe
  local docker_bin
  local expected_recipe
  local image="${1:-$FRESH_WASIX_DOCKER_IMAGE}"
  local image_id
  local label=dev.oliphaunt.wasix-builder.recipe-sha256
  local record

  docker_bin="$(fresh_docker_bin)" || return
  expected_recipe="$(fresh_wasix_builder_recipe_sha256)" || return
  record="$("$docker_bin" image inspect \
    --format "{{.Id}}|{{ index .Config.Labels \"$label\" }}" \
    "$image" 2>/dev/null)" || {
    printf 'WASIX builder image is unavailable: %s\n' "$image" >&2
    return 2
  }
  case "$record" in
    *'|'*)
      image_id="${record%%|*}"
      actual_recipe="${record#*|}"
      ;;
    *)
      printf 'WASIX builder image inspection returned an invalid record: %s\n' "$image" >&2
      return 2
      ;;
  esac
  [ "$actual_recipe" = "$expected_recipe" ] || {
    printf 'WASIX builder image recipe label mismatch: %s\n' "$image" >&2
    return 2
  }
  case "$image_id" in
    sha256:*)
      fresh_is_sha256 "${image_id#sha256:}" || {
        printf 'WASIX builder image has an invalid immutable identity: %s\n' "$image" >&2
        return 2
      }
      ;;
    *)
      printf 'WASIX builder image has an invalid immutable identity: %s\n' "$image" >&2
      return 2
      ;;
  esac
  printf '%s\n' "$image_id"
}
