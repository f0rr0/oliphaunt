#!/usr/bin/env bash
set -euo pipefail

oliphaunt_wasix_cxx_runtime_lib_dir() {
  printf '%s\n' "${WASIX_CXX_RUNTIME_LIB_DIR:-$HOME/.wasixcc/sysroot/sysroot-exnref-ehpic/lib/wasm32-wasi}"
}

oliphaunt_wasix_cxx_runtime_libs() {
  local lib_dir
  lib_dir="$(oliphaunt_wasix_cxx_runtime_lib_dir)"
  local libs=(
    "$lib_dir/libc++.a"
    "$lib_dir/libc++abi.a"
    "$lib_dir/libunwind.a"
  )
  local lib
  for lib in "${libs[@]}"; do
    if [ ! -f "$lib" ]; then
      echo "missing WASIX C++ runtime archive: $lib" >&2
      return 1
    fi
  done
  printf '%s\n' "${libs[*]}"
}

oliphaunt_wasix_icu_cflags() {
  local prefix="${1:?ICU prefix is required}"
  printf '%s\n' "-DU_STATIC_IMPLEMENTATION -I$prefix/include"
}

oliphaunt_wasix_icu_libs() {
  local prefix="${1:?ICU prefix is required}"
  printf '%s\n' "$prefix/lib/libicui18n.a $prefix/lib/libicuuc.a $prefix/lib/libicudata.a $(oliphaunt_wasix_cxx_runtime_libs)"
}
