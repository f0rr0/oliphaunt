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

wasmer_bin="$(fresh_wasmer_bin)"
wasmer_bin_hash="$(fresh_wasmer_bin_hash "$wasmer_bin")"
wasmer_cache_dir="$(fresh_wasmer_cache_dir "$wasmer_bin")"
wasmer_compiler="$(fresh_wasmer_compiler)"
llvm_opt_level="${WASMER_LLVM_OPT_LEVEL:-aggressive}"
artifact_version="${WASMER_CACHE_ARTIFACT_VERSION:-21}"
compiler_threads="${WASMER_COMPILER_THREADS:-$(fresh_jobs)}"
precompile_timeout="${WASIX_PRECOMPILE_TIMEOUT:-0}"
precompile_scope="${WASIX_PRECOMPILE_SCOPE:-runtime}"

if [ -n "${FRESH_PINNED_WASMER_CACHE_DIR:-}" ] && [ "$wasmer_cache_dir" = "$FRESH_PINNED_WASMER_CACHE_DIR" ] && [ "${FRESH_ALLOW_PINNED_CACHE_WRITE:-0}" != "1" ]; then
  {
    printf 'refusing to precompile into pinned Wasmer cache: %s\n' "$FRESH_PINNED_WASMER_CACHE_DIR"
    printf 'Run with --skip-precompile, unset FRESH_PINNED_WASMER_CACHE_DIR, or set FRESH_ALLOW_PINNED_CACHE_WRITE=1 if you are intentionally refreshing the pin.\n'
  } >&2
  exit 2
fi
fresh_require_wasmer_compiler_cli "$wasmer_bin" "$wasmer_compiler" compile

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

cache_bucket="$wasmer_cache_dir/compiled/$(fresh_wasmer_compiler_cache_bucket "$wasmer_compiler" "$llvm_opt_level" "$artifact_version")"
report="$REPORT_DIR/wasix-core-precompile.md"
log="$REPORT_DIR/wasix-core-precompile.log"
fresh_write_report_header "$report" "WASIX Core Precompile"
mkdir -p "$cache_bucket" "$(dirname "$log")"
: >"$log"

{
  printf '## Runtime\n\n'
  printf -- '- Wasmer binary: `%s`\n' "$wasmer_bin"
  printf -- '- Wasmer binary hash: `%s`\n' "$wasmer_bin_hash"
  printf -- '- Wasmer version: `%s`\n' "$("$wasmer_bin" --version 2>/dev/null || true)"
  printf -- '- Cache dir: `%s`\n' "$wasmer_cache_dir"
  printf -- '- Cache bucket: `%s`\n' "$cache_bucket"
  printf -- '- WASIX core profile: `%s`\n' "$WASIX_CORE_PROFILE"
  printf -- '- WASIX install dir: `%s`\n' "$WASIX_INSTALL_DIR"
  printf -- '- Wasmer compiler: `%s`\n' "$wasmer_compiler"
  printf -- '- LLVM opt level: `%s`\n' "$llvm_opt_level"
  printf -- '- WASMER_LLVM_FULL_O3_PIPELINE: `%s`\n' "${WASMER_LLVM_FULL_O3_PIPELINE:-0}"
  printf -- '- WASMER_LLVM_INDIRECT_CALL_CACHE: `%s`\n' "${WASMER_LLVM_INDIRECT_CALL_CACHE:-0}"
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
    printf ' (cached)\n' >>"$report"
    return 0
  fi
  printf '\n' >>"$report"

  tmp_path="$cache_path.tmp.$$"
  rm -f "$tmp_path"
  {
    printf '\n## %s\n\n' "$wasm_path"
    printf 'hash=%s\ncache=%s\n' "$module_hash" "$cache_path"
  } >>"$log"

  local compiler_args=()
  while IFS= read -r arg; do
    compiler_args+=("$arg")
  done < <(fresh_wasmer_compiler_args_for "$wasmer_bin" compile "$wasmer_compiler" "$llvm_opt_level" "$compiler_threads")

  set +e
  if [ "$precompile_timeout" != "0" ] && command -v timeout >/dev/null 2>&1; then
    timeout "$precompile_timeout" \
      "$wasmer_bin" compile \
        "${compiler_args[@]}" \
        --enable-exceptions \
        --enable-threads \
        -o "$tmp_path" \
        "$wasm_path" >>"$log" 2>&1
    status=$?
  else
    "$wasmer_bin" compile \
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
