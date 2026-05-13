#!/usr/bin/env bash

set -euo pipefail

_fresh_common_source="${BASH_SOURCE[0]}"
export FRESH_ROOT="${FRESH_ROOT:-$(cd "$(dirname "$_fresh_common_source")/.." && pwd)}"
export REPO_ROOT="${REPO_ROOT:-$(cd "$FRESH_ROOT/../../../.." && pwd)}"
export WASIX_BUILD_ROOT="${WASIX_BUILD_ROOT:-$REPO_ROOT/assets/wasix-build}"
export FRESH_WORK_ROOT="${FRESH_WORK_ROOT:-$WASIX_BUILD_ROOT/work/experiments/fresh-wasix-postgres}"

export POSTGRES_TAG="${POSTGRES_TAG:-REL_18_3}"
export POSTGRES_REMOTE="${POSTGRES_REMOTE:-https://github.com/postgres/postgres.git}"
export BASELINE_DIR="${BASELINE_DIR:-$FRESH_WORK_ROOT/sources/postgres-$POSTGRES_TAG}"
export WASIX_SRC_DIR="${WASIX_SRC_DIR:-$FRESH_WORK_ROOT/work/postgres-wasix-core-src}"
export NATIVE_BUILD_DIR="${NATIVE_BUILD_DIR:-$FRESH_WORK_ROOT/builds/native-oracle}"
export NATIVE_INSTALL_DIR="${NATIVE_INSTALL_DIR:-$FRESH_WORK_ROOT/install/native-oracle}"
export FRESH_WASIX_DOCKER_IMAGE="${FRESH_WASIX_DOCKER_IMAGE:-pglite-oxide-wasix-build:local}"
export FRESH_WASMER_VERSION="${FRESH_WASMER_VERSION:-7.2.0-alpha.2}"
export FRESH_UPSTREAM_WASMER_BIN="${FRESH_UPSTREAM_WASMER_BIN:-$WASIX_BUILD_ROOT/work/upstream/wasmer/target/release/wasmer}"

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

WASIX_CORE_PROFILE="$(fresh_normalize_wasix_core_profile "${WASIX_CORE_PROFILE:-safe-o2}")"
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
      ;;
    o3)
      FRESH_WASIX_CORE_PROFILE_DESCRIPTION="O3 codegen profile without LTO or Binaryen post-link optimization"
      FRESH_WASIX_CORE_PROFILE_CFLAGS="-O3 -g0 -fPIC -pthread -sWASM_EXCEPTIONS=yes -Wno-unused-command-line-argument"
      FRESH_WASIX_CORE_PROFILE_LDFLAGS="-fPIC -pthread -sWASM_EXCEPTIONS=yes"
      FRESH_WASIX_CORE_PROFILE_WASM_OPT="no"
      FRESH_WASIX_CORE_PROFILE_WASM_OPT_FLAGS=""
      ;;
    o3-wasmopt)
      FRESH_WASIX_CORE_PROFILE_DESCRIPTION="O3 plus Binaryen post-link converge/strip, without ThinLTO"
      FRESH_WASIX_CORE_PROFILE_CFLAGS="-O3 -g0 -fPIC -pthread -sWASM_EXCEPTIONS=yes -Wno-unused-command-line-argument"
      FRESH_WASIX_CORE_PROFILE_LDFLAGS="-fPIC -pthread -sWASM_EXCEPTIONS=yes"
      FRESH_WASIX_CORE_PROFILE_WASM_OPT="yes"
      FRESH_WASIX_CORE_PROFILE_WASM_OPT_FLAGS="--converge:--strip-debug:--strip-producers"
      ;;
    o3-thinlto)
      FRESH_WASIX_CORE_PROFILE_DESCRIPTION="O3 plus ThinLTO, without Binaryen post-link optimization"
      FRESH_WASIX_CORE_PROFILE_CFLAGS="-O3 -g0 -flto=thin -fPIC -pthread -sWASM_EXCEPTIONS=yes -Wno-unused-command-line-argument"
      FRESH_WASIX_CORE_PROFILE_LDFLAGS="-flto=thin -fPIC -pthread -sWASM_EXCEPTIONS=yes"
      FRESH_WASIX_CORE_PROFILE_WASM_OPT="no"
      FRESH_WASIX_CORE_PROFILE_WASM_OPT_FLAGS=""
      ;;
    release-o3)
      FRESH_WASIX_CORE_PROFILE_DESCRIPTION="release-lane performance profile: O3, ThinLTO, and Binaryen converge/strip"
      FRESH_WASIX_CORE_PROFILE_CFLAGS="-O3 -g0 -flto=thin -fPIC -pthread -sWASM_EXCEPTIONS=yes -Wno-unused-command-line-argument"
      FRESH_WASIX_CORE_PROFILE_LDFLAGS="-flto=thin -fPIC -pthread -sWASM_EXCEPTIONS=yes"
      FRESH_WASIX_CORE_PROFILE_WASM_OPT="yes"
      FRESH_WASIX_CORE_PROFILE_WASM_OPT_FLAGS="--converge:--strip-debug:--strip-producers"
      ;;
    release-o3-symbols)
      FRESH_WASIX_CORE_PROFILE_DESCRIPTION="release-lane profiling profile: O3, ThinLTO, and Binaryen converge while retaining Wasm symbol names"
      FRESH_WASIX_CORE_PROFILE_CFLAGS="-O3 -g0 -flto=thin -fPIC -pthread -sWASM_EXCEPTIONS=yes -Wno-unused-command-line-argument"
      FRESH_WASIX_CORE_PROFILE_LDFLAGS="-flto=thin -fPIC -pthread -sWASM_EXCEPTIONS=yes"
      FRESH_WASIX_CORE_PROFILE_WASM_OPT="yes"
      FRESH_WASIX_CORE_PROFILE_WASM_OPT_FLAGS="--converge:--debuginfo"
      ;;
  esac

  FRESH_WASIX_CORE_EFFECTIVE_CFLAGS="${WASIX_CORE_CFLAGS:-$FRESH_WASIX_CORE_PROFILE_CFLAGS}"
  FRESH_WASIX_CORE_EFFECTIVE_LDFLAGS="${WASIX_CORE_LDFLAGS:-$FRESH_WASIX_CORE_PROFILE_LDFLAGS}"
  FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT="${WASIXCC_RUN_WASM_OPT:-$FRESH_WASIX_CORE_PROFILE_WASM_OPT}"
  FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT_FLAGS="${WASIXCC_WASM_OPT_FLAGS:-$FRESH_WASIX_CORE_PROFILE_WASM_OPT_FLAGS}"
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

fresh_ensure_dirs() {
  mkdir -p "$REPORT_DIR" "$RUN_DIR" "$FRESH_WORK_ROOT/sources" "$FRESH_WORK_ROOT/work" \
    "$FRESH_WORK_ROOT/builds" "$FRESH_WORK_ROOT/install" "$FRESH_WORK_ROOT/tools"
}

fresh_host_arch() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) echo "darwin-arm64" ;;
    Darwin-x86_64) echo "darwin-amd64" ;;
    Linux-x86_64) echo "linux-amd64" ;;
    Linux-aarch64|Linux-arm64) echo "linux-arm64" ;;
    *)
      echo "unsupported host for pinned Wasmer installer: $(uname -s)-$(uname -m)" >&2
      return 2
      ;;
  esac
}

fresh_local_wasmer_bin() {
  local host_arch
  host_arch="$(fresh_host_arch)"
  printf '%s/tools/wasmer-v%s/bin/wasmer\n' "$FRESH_WORK_ROOT" "$FRESH_WASMER_VERSION"
}

fresh_wasmer_bin() {
  if [ -n "${WASMER_BIN:-}" ]; then
    if command -v "$WASMER_BIN" >/dev/null 2>&1; then
      command -v "$WASMER_BIN"
      return
    fi
    if [ -x "$WASMER_BIN" ]; then
      printf '%s\n' "$WASMER_BIN"
      return
    fi
    echo "WASMER_BIN is set but not executable: $WASMER_BIN" >&2
    return 127
  fi

  if [ -x "$FRESH_UPSTREAM_WASMER_BIN" ]; then
    printf '%s\n' "$FRESH_UPSTREAM_WASMER_BIN"
    return
  fi

  local local_bin
  local_bin="$(fresh_local_wasmer_bin)"
  if [ -x "$local_bin" ]; then
    printf '%s\n' "$local_bin"
    return
  fi

  if command -v wasmer >/dev/null 2>&1; then
    command -v wasmer
    return
  fi

  echo "Wasmer CLI not found; run $FRESH_ROOT/bin/install-wasmer.sh" >&2
  return 127
}

fresh_wasmer_bin_hash() {
  local wasmer_bin="$1"
  shasum -a 256 "$wasmer_bin" | awk '{print $1}'
}

fresh_wasmer_llvm_native_cpu_enabled() {
  case "${WASMER_LLVM_NATIVE_CPU:-0}" in
    1|yes|true|on) return 0 ;;
    *) return 1 ;;
  esac
}

fresh_wasmer_llvm_full_o3_enabled() {
  case "${WASMER_LLVM_FULL_O3_PIPELINE:-0}" in
    1|yes|true|on) return 0 ;;
    *) return 1 ;;
  esac
}

fresh_wasmer_llvm_indirect_call_cache_enabled() {
  case "${WASMER_LLVM_INDIRECT_CALL_CACHE:-0}" in
    1|yes|true|on) return 0 ;;
    *) return 1 ;;
  esac
}

fresh_wasmer_cache_dir() {
  local wasmer_bin="$1"
  local suffix=""
  if [ -n "${FRESH_PINNED_WASMER_CACHE_DIR:-}" ]; then
    printf '%s\n' "$FRESH_PINNED_WASMER_CACHE_DIR"
    return
  fi
  if fresh_wasmer_llvm_native_cpu_enabled; then
    suffix="${suffix}-llvm-native-cpu"
  fi
  if fresh_wasmer_llvm_full_o3_enabled; then
    suffix="${suffix}-llvm-full-o3"
  fi
  if fresh_wasmer_llvm_indirect_call_cache_enabled; then
    suffix="${suffix}-llvm-indirect-call-cache"
  fi
  printf '%s/tools/wasmer-cache/%s%s\n' "$FRESH_WORK_ROOT" "$(fresh_wasmer_bin_hash "$wasmer_bin")" "$suffix"
}

fresh_wasmer_llvm_opt_suffix() {
  case "${1:-aggressive}" in
    none) echo "opt0" ;;
    less) echo "optl" ;;
    default) echo "optd" ;;
    aggressive) echo "opta" ;;
    *)
      echo "unknown LLVM opt level: $1" >&2
      return 2
      ;;
  esac
}

fresh_normalize_wasmer_compiler() {
  case "${1:-llvm}" in
    llvm|LLVM) echo "llvm" ;;
    cranelift|clif|Cranelift) echo "cranelift" ;;
    singlepass|single-pass|Singlepass) echo "singlepass" ;;
    *)
      echo "unknown WASMER_COMPILER=$1; expected llvm, cranelift, or singlepass" >&2
      return 2
      ;;
  esac
}

fresh_wasmer_compiler() {
  fresh_normalize_wasmer_compiler "${WASMER_COMPILER:-${WASMER_BACKEND:-llvm}}"
}

fresh_wasmer_compiler_cli_flag() {
  case "$(fresh_normalize_wasmer_compiler "$1")" in
    llvm)
      printf '%s\n' --llvm
      ;;
    cranelift)
      printf '%s\n' --cranelift
      ;;
    singlepass)
      printf '%s\n' --singlepass
      ;;
  esac
}

fresh_wasmer_cli_has_option() {
  local wasmer_bin="$1"
  local subcommand="$2"
  local option="$3"

  "$wasmer_bin" "$subcommand" --help 2>/dev/null | grep -Eq "(^|[[:space:]])${option//-/\\-}([[:space:],]|$)"
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
        printf 'WASMER_COMPILER=%s requires `%s %s`, but `%s %s --help` does not expose that option.\n' \
          "$compiler" "$(basename "$wasmer_bin")" "$flag" "$wasmer_bin" "$subcommand"
        printf 'Build or select a Wasmer binary with the requested backend feature, or set WASMER_COMPILER to a backend exposed by this CLI.\n'
      } >&2
      return 2
    fi
    if [ "$(fresh_normalize_wasmer_compiler "$compiler")" = "llvm" ] && fresh_wasmer_llvm_full_o3_enabled; then
      if ! fresh_wasmer_cli_has_option "$wasmer_bin" "$subcommand" "--llvm-full-o3-pipeline"; then
        {
          printf 'WASMER_LLVM_FULL_O3_PIPELINE=1 requires `%s --llvm-full-o3-pipeline`, but `%s %s --help` does not expose that option.\n' \
            "$(basename "$wasmer_bin")" "$wasmer_bin" "$subcommand"
          printf 'Build or select a Wasmer binary with explicit full-O3 LLVM pipeline support, or unset WASMER_LLVM_FULL_O3_PIPELINE.\n'
        } >&2
        return 2
      fi
    fi
    if [ "$(fresh_normalize_wasmer_compiler "$compiler")" = "llvm" ] && fresh_wasmer_llvm_indirect_call_cache_enabled; then
      if ! fresh_wasmer_cli_has_option "$wasmer_bin" "$subcommand" "--llvm-indirect-call-cache"; then
        {
          printf 'WASMER_LLVM_INDIRECT_CALL_CACHE=1 requires `%s --llvm-indirect-call-cache`, but `%s %s --help` does not expose that option.\n' \
            "$(basename "$wasmer_bin")" "$wasmer_bin" "$subcommand"
          printf 'Build or select a Wasmer binary with guarded indirect-call cache support, or unset WASMER_LLVM_INDIRECT_CALL_CACHE.\n'
        } >&2
        return 2
      fi
    fi
  done
}

fresh_wasmer_compiler_args() {
  fresh_wasmer_compiler_args_for "" "" "$@"
}

fresh_wasmer_compiler_args_for() {
  local wasmer_bin="$1"
  local subcommand="$2"
  shift 2
  local compiler="$1"
  local llvm_opt_level="$2"
  local compiler_threads="$3"

  case "$(fresh_normalize_wasmer_compiler "$compiler")" in
    llvm)
      printf '%s\n' --llvm
      if [ -n "$wasmer_bin" ] &&
        [ -n "$subcommand" ] &&
        fresh_wasmer_cli_has_option "$wasmer_bin" "$subcommand" "--llvm-opt-level"; then
        printf '%s\n' --llvm-opt-level "$llvm_opt_level"
      fi
      if fresh_wasmer_llvm_full_o3_enabled; then
        printf '%s\n' --llvm-full-o3-pipeline
      fi
      if fresh_wasmer_llvm_indirect_call_cache_enabled; then
        printf '%s\n' --llvm-indirect-call-cache
      fi
      ;;
    cranelift)
      printf '%s\n' --cranelift
      ;;
    singlepass)
      printf '%s\n' --singlepass
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

  case "$(fresh_normalize_wasmer_compiler "$compiler")" in
    llvm)
      local suffix=""
      if fresh_wasmer_llvm_native_cpu_enabled; then
        suffix="${suffix}-nativecpu"
      fi
      if fresh_wasmer_llvm_full_o3_enabled; then
        suffix="${suffix}-fullo3"
      fi
      if fresh_wasmer_llvm_indirect_call_cache_enabled; then
        suffix="${suffix}-indirectcallcache"
      fi
      printf 'llvm-%s%s-v%s\n' "$(fresh_wasmer_llvm_opt_suffix "$llvm_opt_level")" "$suffix" "$artifact_version"
      ;;
    cranelift)
      printf 'cranelift-v%s\n' "$artifact_version"
      ;;
    singlepass)
      printf 'singlepass-v%s\n' "$artifact_version"
      ;;
  esac
}

fresh_wasmer_module_hash() {
  local wasm_path="$1"
  shasum -a 256 "$wasm_path" | awk '{print toupper($1)}'
}

fresh_overlay_digest() {
  local overlay_dir="$FRESH_ROOT/overlays/wasix-core"
  local patches_dir="$FRESH_ROOT/patches"
  {
    if [ -d "$overlay_dir" ]; then
      find "$overlay_dir" -type f | sort | while IFS= read -r path; do
        printf '%s\n' "${path#$overlay_dir/}"
        shasum -a 256 "$path"
      done
    fi
    if [ -d "$patches_dir" ]; then
      find "$patches_dir" -type f -name '*.patch' | sort | while IFS= read -r path; do
        printf '%s\n' "${path#$patches_dir/}"
        shasum -a 256 "$path"
      done
    fi
  } | shasum -a 256 | awk '{print $1}'
}

fresh_write_report_header() {
  local report="$1"
  local title="$2"
  mkdir -p "$(dirname "$report")"
  {
    printf '# %s\n\n' "$title"
    printf -- '- Generated: `%s`\n' "$(fresh_timestamp)"
    printf -- '- Repository: `%s`\n' "$REPO_ROOT"
    printf -- '- Experiment source root: `%s`\n' "$FRESH_ROOT"
    printf -- '- Experiment work root: `%s`\n' "$FRESH_WORK_ROOT"
    printf -- '- PostgreSQL tag: `%s`\n\n' "$POSTGRES_TAG"
  } >"$report"
}

fresh_ensure_docker_image() {
  local docker_bin
  docker_bin="$(fresh_docker_bin)"
  if "$docker_bin" image inspect "$FRESH_WASIX_DOCKER_IMAGE" >/dev/null 2>&1; then
    return
  fi
  "$docker_bin" build \
    -f "$WASIX_BUILD_ROOT/docker/Dockerfile" \
    -t "$FRESH_WASIX_DOCKER_IMAGE" \
    "$REPO_ROOT"
}
