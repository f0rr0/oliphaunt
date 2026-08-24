#!/usr/bin/env bash

# Shared, isolated PostgreSQL frontend build closure. The embedded backend does
# not own these archives, and frontend changes must not invalidate its large
# monolithic WASIX link.

oliphaunt_wasix_prepare_frontend_tools() {
  local helper_root
  local icu_native_build_dir
  local icu_build_dir
  local tool_shim
  local tool_stamp
  local expected_tool_stamp

  helper_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  . "$helper_root/wasix_icu_link.sh"

  icu_native_build_dir="$CONTAINER_GENERATED_ROOT/work/icu-native-tools"
  OLIPHAUNT_WASIX_FRONTEND_ICU_PREFIX="$CONTAINER_GENERATED_ROOT/work/icu-wasix-tools"
  icu_build_dir="$CONTAINER_GENERATED_ROOT/work/icu-wasix-tools-build"
  OLIPHAUNT_WASIX_FRONTEND_ICU_PREFIX="$(
    env -u AR -u RANLIB -u NM -u LLVM_NM \
      ICU_PREFIX="$OLIPHAUNT_WASIX_FRONTEND_ICU_PREFIX" \
      ICU_NATIVE_BUILD_DIR="$icu_native_build_dir" \
      ICU_BUILD_DIR="$icu_build_dir" \
      OLIPHAUNT_WASM_BUILD_PROFILE=release-os \
      OLIPHAUNT_WASM_WASIX_COPT="-O2 -g0" \
      "$helper_root/build_wasix_icu.sh"
  )"
  OLIPHAUNT_WASIX_FRONTEND_ICU_LIBS="$(
    oliphaunt_wasix_icu_libs "$OLIPHAUNT_WASIX_FRONTEND_ICU_PREFIX"
  )"

  OLIPHAUNT_WASIX_FRONTEND_BUILD_DIR="$CONTAINER_GENERATED_ROOT/work/docker-frontend-tools"
  tool_shim="$CONTAINER_GENERATED_ROOT/build/wasix-frontend-tools/oliphaunt_wasix_bridge.o"
  tool_stamp="$OLIPHAUNT_WASIX_FRONTEND_BUILD_DIR/.oliphaunt-wasix-frontend-build"
  expected_tool_stamp="$(
    printf "%s\n" "schema=oliphaunt-wasix-frontend-tools-v1"
    sha256sum \
      "$PGSRC/.oliphaunt-wasix-source-fingerprint" \
      "$PGSRC/.oliphaunt-wasix-postgres-version" \
      "$helper_root/configure_wasix_dl.sh" \
      "$helper_root/docker_pgdump.sh" \
      "$helper_root/docker_psql.sh" \
      "$helper_root/wasix_shim/oliphaunt_wasix_bridge.c" \
      "$helper_root/profile_flags.sh" \
      "$helper_root/wasix_frontend_tools.sh" \
      "$OLIPHAUNT_WASIX_FRONTEND_ICU_PREFIX/.oliphaunt-wasix-icu-build"
  )"
  if [ ! -f "$OLIPHAUNT_WASIX_FRONTEND_BUILD_DIR/config.status" ] ||
     [ ! -f "$tool_stamp" ] ||
     [ "$(cat "$tool_stamp")" != "$expected_tool_stamp" ]; then
    rm -rf "$OLIPHAUNT_WASIX_FRONTEND_BUILD_DIR"
    BUILD_DIR="$OLIPHAUNT_WASIX_FRONTEND_BUILD_DIR" \
    ICU_PREFIX="$OLIPHAUNT_WASIX_FRONTEND_ICU_PREFIX" \
    OLIPHAUNT_WASM_SHIM_OBJECT="$tool_shim" \
    OLIPHAUNT_WASM_BUILD_PROFILE=release-os \
    OLIPHAUNT_WASM_WASIX_COPT="-O2 -g0" \
    OLIPHAUNT_WASM_WASIX_LOPT="-Wl,--threads=1" \
      "$helper_root/configure_wasix_dl.sh"
    printf "%s\n" "$expected_tool_stamp" > "$tool_stamp"
  fi

  make -s -C "$OLIPHAUNT_WASIX_FRONTEND_BUILD_DIR/src/port" all
  make -s -C "$OLIPHAUNT_WASIX_FRONTEND_BUILD_DIR/src/common" all
  make -s -C "$OLIPHAUNT_WASIX_FRONTEND_BUILD_DIR/src/interfaces/libpq" all
  make -s -C "$OLIPHAUNT_WASIX_FRONTEND_BUILD_DIR/src/fe_utils" all
}
