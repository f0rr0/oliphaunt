#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

force=0
modules=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --force)
      force=1
      ;;
    --module)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--module requires a path relative to the WASIX install root or an absolute path" >&2
        exit 2
      fi
      modules+=("$1")
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

fresh_ensure_dirs

wasmer_receipt="${WASMER_BUILD_RECEIPT:-$FRESH_WASMER_BUILD_RECEIPT}"
product_receipt="$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT"
compiler_bin="$FRESH_POSTMASTER_COMPILER_BIN"
fresh_require_patched_postmaster_compiler \
  "$compiler_bin" "$product_receipt" "$wasmer_receipt" \
  "$FRESH_POSTMASTER_EXECUTOR_BIN"
compiler_bin_hash="$(fresh_wasmer_bin_hash "$compiler_bin")"
compiler_cache_dir="$(fresh_wasmer_cache_dir "$compiler_bin")"
wasmer_compiler=llvm
llvm_opt_level="${WASMER_LLVM_OPT_LEVEL:-aggressive}"
artifact_version="${WASMER_CACHE_ARTIFACT_VERSION:-21}"
compiler_threads="${WASMER_COMPILER_THREADS:-$(fresh_jobs)}"
precompile_timeout="${WASIX_PRECOMPILE_TIMEOUT:-0}"
precompile_scope="${WASIX_PRECOMPILE_SCOPE:-runtime}"

if [ -n "${FRESH_PINNED_WASMER_CACHE_DIR:-}" ]; then
  {
    printf 'postmaster product AOT refuses pinned or foreign cache roots: %s\n' "$FRESH_PINNED_WASMER_CACHE_DIR"
    printf 'Unset FRESH_PINNED_WASMER_CACHE_DIR; the product compiler hash must own the cache namespace.\n'
  } >&2
  exit 2
fi
if fresh_wasmer_llvm_native_cpu_enabled; then
  echo 'the postmaster product compiler refuses host-native CPU AOT' >&2
  exit 2
fi

append_module_if_present() {
  local module="$1"
  if [ -f "$WASIX_INSTALL_DIR/$module" ]; then
    modules+=("$module")
  fi
}

append_installed_modules_matching() {
  local dir="$1"
  shift
  if [ ! -d "$dir" ]; then
    return
  fi
  while IFS= read -r path; do
    modules+=("${path#$WASIX_INSTALL_DIR/}")
  done < <(find "$dir" "$@" -type f -print | sort)
}

if [ "${#modules[@]}" -eq 0 ]; then
  case "$precompile_scope" in
    minimal)
      modules=(
        bin/initdb
        lib/libpq.so.5.18
        bin/postgres
      )
      ;;
    runtime)
      append_module_if_present bin/initdb
      append_module_if_present bin/postgres
      append_module_if_present bin/pg_dump
      append_installed_modules_matching "$WASIX_INSTALL_DIR/lib" -maxdepth 1 -name 'libpq.so*'
      append_installed_modules_matching "$WASIX_INSTALL_DIR/lib/postgresql" -name '*.so'
      ;;
    all)
      append_installed_modules_matching "$WASIX_INSTALL_DIR/bin" -maxdepth 1 -perm -111
      append_installed_modules_matching "$WASIX_INSTALL_DIR/lib" -maxdepth 1 -name 'libpq.so*'
      append_installed_modules_matching "$WASIX_INSTALL_DIR/lib/postgresql" -name '*.so'
      append_module_if_present lib/postgresql/regress.dylib
      ;;
    *)
      echo "unknown WASIX_PRECOMPILE_SCOPE=$precompile_scope; expected minimal, runtime, or all" >&2
      exit 2
      ;;
  esac
fi
if [ "${#modules[@]}" -eq 0 ]; then
  echo "no WASIX modules found to precompile under $WASIX_INSTALL_DIR" >&2
  exit 2
fi

cache_bucket="$compiler_cache_dir/compiled/$(fresh_wasmer_compiler_cache_bucket "$wasmer_compiler" "$llvm_opt_level" "$artifact_version")"
wasmer_dir="$FRESH_WORK_ROOT/tools/wasmer-home"
report="$REPORT_DIR/wasix-core-precompile.md"
log="$REPORT_DIR/wasix-core-precompile.log"
fresh_write_report_header "$report" "WASIX Core Precompile"
mkdir -p "$wasmer_dir" "$cache_bucket" "$(dirname "$log")"
: >"$log"

{
  printf '## Runtime\n\n'
  printf -- '- Product compiler: `%s`\n' "$compiler_bin"
  printf -- '- Product compiler hash: `%s`\n' "$compiler_bin_hash"
  printf -- '- Product compiler version: `%s`\n' "$("$compiler_bin" --version)"
  printf -- '- Product build receipt: `%s`\n' "$product_receipt"
  printf -- '- Cache dir: `%s`\n' "$compiler_cache_dir"
  printf -- '- Cache bucket: `%s`\n' "$cache_bucket"
  printf -- '- WASIX core profile: `%s`\n' "$WASIX_CORE_PROFILE"
  printf -- '- WASIX install dir: `%s`\n' "$WASIX_INSTALL_DIR"
  printf -- '- Wasmer compiler: `%s`\n' "$wasmer_compiler"
  printf -- '- LLVM opt level: `%s`\n' "$llvm_opt_level"
  printf -- '- WASMER_LLVM_FULL_O3_PIPELINE: `%s`\n' "${WASMER_LLVM_FULL_O3_PIPELINE:-0}"
  printf -- '- WASMER_LLVM_INDIRECT_CALL_CACHE: `%s`\n' "${WASMER_LLVM_INDIRECT_CALL_CACHE:-0}"
  printf -- '- WASMER_LLVM_VOLATILE_MEMOPS: `%s`\n' "${WASMER_LLVM_VOLATILE_MEMOPS:-0}"
  printf -- '- Compiler threads: `%s`\n' "$compiler_threads"
  printf -- '- Module scope: `%s`\n' "$precompile_scope"
  printf -- '- Timeout per module: `%s`\n' "$precompile_timeout"
  printf -- '- Log: `%s`\n\n' "$log"
  printf '## Modules\n\n'
} >>"$report"

compile_one() {
  local module="$1"
  local wasm_path
  case "$module" in
    /*) wasm_path="$module" ;;
    *) wasm_path="$WASIX_INSTALL_DIR/$module" ;;
  esac

  if [ ! -f "$wasm_path" ]; then
    printf 'missing WASIX module: %s\n' "$wasm_path" >&2
    return 2
  fi

  local module_hash cache_path tmp_path status
  module_hash="$(fresh_wasmer_module_hash "$wasm_path")"
  cache_path="$cache_bucket/$module_hash.bin"

  printf -- '- `%s` -> `%s`' "$wasm_path" "$cache_path" >>"$report"
  if [ "$force" -eq 0 ] && [ -s "$cache_path" ]; then
    if "$compiler_bin" verify-aot "$wasm_path" "$cache_path" >>"$log" 2>&1; then
      printf ' (cached, attested)\n' >>"$report"
      return 0
    fi
    printf ' (cached artifact rejected; rebuilding)\n' >>"$report"
  fi
  printf '\n' >>"$report"

  tmp_path="$cache_path.tmp.$$"
  rm -f "$tmp_path"
  {
    printf '\n## %s\n\n' "$wasm_path"
    printf 'hash=%s\ncache=%s\n' "$module_hash" "$cache_path"
  } >>"$log"

  local compiler_args=(
    --llvm
    --llvm-opt-level "$llvm_opt_level"
    --compiler-threads "$compiler_threads"
  )
  if fresh_wasmer_llvm_full_o3_enabled; then
    compiler_args+=(--llvm-full-o3-pipeline)
  fi
  if fresh_wasmer_llvm_indirect_call_cache_enabled; then
    compiler_args+=(--llvm-indirect-call-cache)
  fi
  if fresh_wasmer_llvm_volatile_memops_enabled; then
    compiler_args+=(--disable-non-volatile-memops)
  fi

  set +e
  if [ "$precompile_timeout" != "0" ] && command -v timeout >/dev/null 2>&1; then
    timeout "$precompile_timeout" \
      env \
        WASMER_DIR="$wasmer_dir" \
        WASMER_CACHE_DIR="$compiler_cache_dir" \
        "$compiler_bin" \
        "${compiler_args[@]}" \
        --enable-exceptions \
        --enable-threads \
        -o "$tmp_path" \
        "$wasm_path" >>"$log" 2>&1
    status=$?
  else
    env \
      WASMER_DIR="$wasmer_dir" \
      WASMER_CACHE_DIR="$compiler_cache_dir" \
      "$compiler_bin" \
      "${compiler_args[@]}" \
      --enable-exceptions \
      --enable-threads \
      -o "$tmp_path" \
      "$wasm_path" >>"$log" 2>&1
    status=$?
  fi
  set -e

  if [ "$status" -ne 0 ]; then
    rm -f "$tmp_path"
    printf 'precompile failed for %s; see %s\n' "$wasm_path" "$log" >&2
    return "$status"
  fi

  if ! "$compiler_bin" verify-aot "$wasm_path" "$tmp_path" >>"$log" 2>&1; then
    rm -f "$tmp_path"
    printf 'compiled AOT admission failed for %s; see %s\n' "$wasm_path" "$log" >&2
    return 2
  fi

  mv "$tmp_path" "$cache_path"
}

status=0
for module in "${modules[@]}"; do
  set +e
  compile_one "$module"
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    break
  fi
done

{
  printf '\n## Result\n\n'
  if [ "$status" -eq 0 ]; then
    printf -- '- Status: `pass`\n'
  else
    printf -- '- Status: `fail`\n'
  fi
  printf -- '- Exit code: `%s`\n' "$status"
} >>"$report"

if [ "$status" -eq 0 ]; then
  printf 'precompiled WASIX core modules into %s\n' "$cache_bucket"
fi
exit "$status"
