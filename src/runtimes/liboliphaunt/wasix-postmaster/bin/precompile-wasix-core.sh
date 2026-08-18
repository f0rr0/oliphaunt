#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

[ "$#" -eq 0 ] || {
  printf 'usage: %s\n' "$0" >&2
  exit 2
}

fresh_ensure_dirs

wasmer_receipt="${WASMER_BUILD_RECEIPT:-$FRESH_WASMER_BUILD_RECEIPT}"
product_receipt="$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT"
compiler_bin="$FRESH_POSTMASTER_COMPILER_BIN"
fresh_require_patched_postmaster_compiler \
  "$compiler_bin" "$product_receipt" "$wasmer_receipt" \
  "$FRESH_POSTMASTER_EXECUTOR_BIN"

[ -z "${FRESH_PINNED_WASMER_CACHE_DIR:-}" ] || {
  printf 'postmaster AOT refuses a foreign cache root: %s\n' "$FRESH_PINNED_WASMER_CACHE_DIR" >&2
  exit 2
}

compiler_hash="$(fresh_wasmer_bin_hash "$compiler_bin")"
compiler_cache_dir="$(fresh_wasmer_cache_dir "$compiler_bin")"
cache_bucket="$compiler_cache_dir/compiled/$(fresh_wasmer_compiler_cache_bucket llvm aggressive "$FRESH_WASMER_ARTIFACT_ABI_VERSION")"
side_policy="$FRESH_ROOT/runtime/policies/sealed-side-modules.v1.tsv"
compiler_threads="${WASMER_COMPILER_THREADS:-$(fresh_jobs)}"
wasmer_dir="$FRESH_WORK_ROOT/tools/wasmer-home"
log="$REPORT_DIR/wasix-core-precompile.log"

modules=(bin/initdb bin/postgres)
while IFS=$'\t' read -r canonical _aliases _abi; do
  case "${canonical:-}" in ''|'#'*) continue ;; esac
  case "$canonical" in
    /*|*'..'*) printf 'unsafe sealed side-module path: %s\n' "$canonical" >&2; exit 2 ;;
  esac
  modules+=("$canonical")
done <"$side_policy"

[ "${#modules[@]}" -eq 29 ] || {
  printf 'expected initdb, postgres, and 27 declared side modules; found %s entries\n' "${#modules[@]}" >&2
  exit 2
}

mkdir -p "$wasmer_dir" "$cache_bucket" "$(dirname "$log")"
: >"$log"

for module in "${modules[@]}"; do
  wasm_path="$WASIX_INSTALL_DIR/$module"
  [ -f "$wasm_path" ] && [ ! -L "$wasm_path" ] || {
    printf 'missing sealed product module: %s\n' "$wasm_path" >&2
    exit 2
  }
  module_hash="$(fresh_wasmer_module_hash "$wasm_path")"
  cache_path="$cache_bucket/$module_hash.bin"
  if [ -s "$cache_path" ] && "$compiler_bin" verify-aot "$wasm_path" "$cache_path" >>"$log" 2>&1; then
    continue
  fi
  tmp_path="$cache_path.tmp.$$"
  rm -f "$tmp_path"
  if ! env \
    WASMER_DIR="$wasmer_dir" \
    WASMER_CACHE_DIR="$compiler_cache_dir" \
    "$compiler_bin" \
    --llvm \
    --llvm-opt-level aggressive \
    --compiler-threads "$compiler_threads" \
    --enable-exceptions \
    --enable-threads \
    -o "$tmp_path" \
    "$wasm_path" >>"$log" 2>&1; then
    rm -f "$tmp_path"
    printf 'precompile failed for %s; see %s\n' "$wasm_path" "$log" >&2
    exit 2
  fi
  if ! "$compiler_bin" verify-aot "$wasm_path" "$tmp_path" >>"$log" 2>&1; then
    rm -f "$tmp_path"
    printf 'compiled AOT admission failed for %s; see %s\n' "$wasm_path" "$log" >&2
    exit 2
  fi
  mv "$tmp_path" "$cache_path"
done

printf 'precompiled exact sealed closure (29 modules) with %s into %s\n' "$compiler_hash" "$cache_bucket"
