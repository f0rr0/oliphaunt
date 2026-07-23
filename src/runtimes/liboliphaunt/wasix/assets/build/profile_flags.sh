#!/usr/bin/env bash

oliphaunt_wasix_wasix_profile="${OLIPHAUNT_WASM_BUILD_PROFILE:-release}"

case "$oliphaunt_wasix_wasix_profile" in
  debug)
    OLIPHAUNT_WASM_PROFILE_CFLAGS="${OLIPHAUNT_WASM_WASIX_COPT:--O0 -g3}"
    OLIPHAUNT_WASM_PROFILE_LDFLAGS="${OLIPHAUNT_WASM_WASIX_LOPT:-}"
    ;;
  release)
    OLIPHAUNT_WASM_PROFILE_CFLAGS="${OLIPHAUNT_WASM_WASIX_COPT:--O2 -g0}"
    OLIPHAUNT_WASM_PROFILE_LDFLAGS="${OLIPHAUNT_WASM_WASIX_LOPT:-}"
    ;;
  release-o3)
    OLIPHAUNT_WASM_PROFILE_CFLAGS="${OLIPHAUNT_WASM_WASIX_COPT:--O3 -g0 -flto=thin}"
    OLIPHAUNT_WASM_PROFILE_LDFLAGS="${OLIPHAUNT_WASM_WASIX_LOPT:--flto=thin}"
    ;;
  release-os)
    OLIPHAUNT_WASM_PROFILE_CFLAGS="${OLIPHAUNT_WASM_WASIX_COPT:--Os -g0}"
    OLIPHAUNT_WASM_PROFILE_LDFLAGS="${OLIPHAUNT_WASM_WASIX_LOPT:-}"
    ;;
  release-oz)
    OLIPHAUNT_WASM_PROFILE_CFLAGS="${OLIPHAUNT_WASM_WASIX_COPT:--Oz -g0}"
    OLIPHAUNT_WASM_PROFILE_LDFLAGS="${OLIPHAUNT_WASM_WASIX_LOPT:-}"
    ;;
  *)
    echo "unknown OLIPHAUNT_WASM_BUILD_PROFILE=$oliphaunt_wasix_wasix_profile" >&2
    exit 2
    ;;
esac

OLIPHAUNT_WASM_WASIX_CONFIGURE_WASM_OPT="${OLIPHAUNT_WASM_WASIX_CONFIGURE_WASM_OPT:-no}"
OLIPHAUNT_WASM_WASIX_BUILD_WASM_OPT="${OLIPHAUNT_WASM_WASIX_BUILD_WASM_OPT:-yes}"
OLIPHAUNT_WASM_WASIX_BACKEND_TIMING="${OLIPHAUNT_WASM_WASIX_BACKEND_TIMING:-0}"
if [ -z "${OLIPHAUNT_WASM_WASM_OPT_FLAGS:-}" ]; then
  case "$oliphaunt_wasix_wasix_profile" in
    release*)
      OLIPHAUNT_WASM_WASM_OPT_FLAGS="--converge:--strip-debug:--strip-producers"
      ;;
    *)
      OLIPHAUNT_WASM_WASM_OPT_FLAGS=""
      ;;
  esac
elif [ "$OLIPHAUNT_WASM_WASM_OPT_FLAGS" = "none" ]; then
  OLIPHAUNT_WASM_WASM_OPT_FLAGS=""
fi

oliphaunt_wasix_reject_asyncify_flag() {
  local name="$1"
  local value="${!name:-}"

  if [ -z "$value" ] || [ -n "${OLIPHAUNT_WASM_ALLOW_ASYNCIFY_EXPERIMENT:-}" ]; then
    return
  fi

  case "$value" in
    *ASYNCIFY*|*asyncify*)
      echo "$name contains Asyncify flags; production WASIX artifacts require WebAssembly exceptions. Set OLIPHAUNT_WASM_ALLOW_ASYNCIFY_EXPERIMENT=1 only for isolated experiments." >&2
      exit 2
      ;;
  esac
}

for oliphaunt_wasix_flag_var in \
  OLIPHAUNT_WASM_PROFILE_CFLAGS \
  OLIPHAUNT_WASM_PROFILE_LDFLAGS \
  OLIPHAUNT_WASM_WASM_OPT_FLAGS \
  OLIPHAUNT_WASM_WASIX_COMPILER_FLAGS \
  OLIPHAUNT_WASM_WASIX_LINKER_FLAGS
do
  oliphaunt_wasix_reject_asyncify_flag "$oliphaunt_wasix_flag_var"
done

oliphaunt_wasix_apply_wasix_profile() {
  local phase="${1:-build}"

  export OLIPHAUNT_WASM_PROFILE_CFLAGS
  export OLIPHAUNT_WASM_PROFILE_LDFLAGS
  export WASIXCC_COMPILER_FLAGS="${OLIPHAUNT_WASM_WASIX_COMPILER_FLAGS:-}"
  export WASIXCC_LINKER_FLAGS="${OLIPHAUNT_WASM_WASIX_LINKER_FLAGS:-}"
  export WASIXCC_WASM_OPT_FLAGS="$OLIPHAUNT_WASM_WASM_OPT_FLAGS"
  if [ -n "${OLIPHAUNT_WASM_WASM_OPT_SUPPRESS_DEFAULT:-}" ]; then
    export WASIXCC_WASM_OPT_SUPPRESS_DEFAULT="$OLIPHAUNT_WASM_WASM_OPT_SUPPRESS_DEFAULT"
  fi
  if [ -n "${OLIPHAUNT_WASM_WASM_OPT_PRESERVE_UNOPTIMIZED:-}" ]; then
    export WASIXCC_WASM_OPT_PRESERVE_UNOPTIMIZED="$OLIPHAUNT_WASM_WASM_OPT_PRESERVE_UNOPTIMIZED"
  fi

  if [ "$phase" = "configure" ]; then
    export WASIXCC_RUN_WASM_OPT="$OLIPHAUNT_WASM_WASIX_CONFIGURE_WASM_OPT"
  else
    export WASIXCC_RUN_WASM_OPT="$OLIPHAUNT_WASM_WASIX_BUILD_WASM_OPT"
  fi
}

oliphaunt_wasix_wasix_profile_signature() {
  printf 'profile=%s\n' "$oliphaunt_wasix_wasix_profile"
  printf 'cflags=%s\n' "$OLIPHAUNT_WASM_PROFILE_CFLAGS"
  printf 'ldflags=%s\n' "$OLIPHAUNT_WASM_PROFILE_LDFLAGS"
  printf 'configure_wasm_opt=%s\n' "$OLIPHAUNT_WASM_WASIX_CONFIGURE_WASM_OPT"
  printf 'build_wasm_opt=%s\n' "$OLIPHAUNT_WASM_WASIX_BUILD_WASM_OPT"
  printf 'wasm_opt_flags=%s\n' "$OLIPHAUNT_WASM_WASM_OPT_FLAGS"
  printf 'wasm_opt_suppress_default=%s\n' "${OLIPHAUNT_WASM_WASM_OPT_SUPPRESS_DEFAULT:-}"
  printf 'wasm_opt_preserve_unoptimized=%s\n' "${OLIPHAUNT_WASM_WASM_OPT_PRESERVE_UNOPTIMIZED:-}"
  printf 'compiler_flags=%s\n' "${OLIPHAUNT_WASM_WASIX_COMPILER_FLAGS:-}"
  printf 'linker_flags=%s\n' "${OLIPHAUNT_WASM_WASIX_LINKER_FLAGS:-}"
  printf 'backend_timing=%s\n' "$OLIPHAUNT_WASM_WASIX_BACKEND_TIMING"
  if [ -f ./src/runtimes/liboliphaunt/wasix/assets/build/configure_wasix_dl.sh ]; then
    printf 'configure_postgres_wasix_dl_sha256=%s\n' "$(sha256sum ./src/runtimes/liboliphaunt/wasix/assets/build/configure_wasix_dl.sh | awk '{print $1}')"
  fi
  if [ -f ./src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_icu.sh ]; then
    printf 'build_wasix_icu_sha256=%s\n' "$(sha256sum ./src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_icu.sh | awk '{print $1}')"
  fi
}
