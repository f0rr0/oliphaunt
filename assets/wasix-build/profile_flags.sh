#!/usr/bin/env bash

pglite_oxide_wasix_profile="${PGLITE_OXIDE_BUILD_PROFILE:-release-o3}"

case "$pglite_oxide_wasix_profile" in
  debug)
    PGLITE_OXIDE_PROFILE_CFLAGS="${PGLITE_OXIDE_WASIX_COPT:--O0 -g3}"
    PGLITE_OXIDE_PROFILE_LDFLAGS="${PGLITE_OXIDE_WASIX_LOPT:-}"
    ;;
  release)
    PGLITE_OXIDE_PROFILE_CFLAGS="${PGLITE_OXIDE_WASIX_COPT:--O2 -g0}"
    PGLITE_OXIDE_PROFILE_LDFLAGS="${PGLITE_OXIDE_WASIX_LOPT:-}"
    ;;
  release-o3)
    PGLITE_OXIDE_PROFILE_CFLAGS="${PGLITE_OXIDE_WASIX_COPT:--O3 -g0 -flto=thin}"
    PGLITE_OXIDE_PROFILE_LDFLAGS="${PGLITE_OXIDE_WASIX_LOPT:--flto=thin}"
    ;;
  release-os)
    PGLITE_OXIDE_PROFILE_CFLAGS="${PGLITE_OXIDE_WASIX_COPT:--Os -g0}"
    PGLITE_OXIDE_PROFILE_LDFLAGS="${PGLITE_OXIDE_WASIX_LOPT:-}"
    ;;
  release-oz)
    PGLITE_OXIDE_PROFILE_CFLAGS="${PGLITE_OXIDE_WASIX_COPT:--Oz -g0}"
    PGLITE_OXIDE_PROFILE_LDFLAGS="${PGLITE_OXIDE_WASIX_LOPT:-}"
    ;;
  *)
    echo "unknown PGLITE_OXIDE_BUILD_PROFILE=$pglite_oxide_wasix_profile" >&2
    exit 2
    ;;
esac

PGLITE_OXIDE_WASIX_CONFIGURE_WASM_OPT="${PGLITE_OXIDE_WASIX_CONFIGURE_WASM_OPT:-no}"
PGLITE_OXIDE_WASIX_BUILD_WASM_OPT="${PGLITE_OXIDE_WASIX_BUILD_WASM_OPT:-yes}"
PGLITE_OXIDE_WASIX_BACKEND_TIMING="${PGLITE_OXIDE_WASIX_BACKEND_TIMING:-0}"
if [ -z "${PGLITE_OXIDE_WASM_OPT_FLAGS:-}" ]; then
  case "$pglite_oxide_wasix_profile" in
    release*)
      PGLITE_OXIDE_WASM_OPT_FLAGS="--converge:--strip-debug:--strip-producers"
      ;;
    *)
      PGLITE_OXIDE_WASM_OPT_FLAGS=""
      ;;
  esac
elif [ "$PGLITE_OXIDE_WASM_OPT_FLAGS" = "none" ]; then
  PGLITE_OXIDE_WASM_OPT_FLAGS=""
fi

pglite_oxide_reject_asyncify_flag() {
  local name="$1"
  local value="${!name:-}"

  if [ -z "$value" ] || [ -n "${PGLITE_OXIDE_ALLOW_ASYNCIFY_EXPERIMENT:-}" ]; then
    return
  fi

  case "$value" in
    *ASYNCIFY*|*asyncify*)
      echo "$name contains Asyncify flags; production WASIX artifacts require WebAssembly exceptions. Set PGLITE_OXIDE_ALLOW_ASYNCIFY_EXPERIMENT=1 only for isolated experiments." >&2
      exit 2
      ;;
  esac
}

for pglite_oxide_flag_var in \
  PGLITE_OXIDE_PROFILE_CFLAGS \
  PGLITE_OXIDE_PROFILE_LDFLAGS \
  PGLITE_OXIDE_WASM_OPT_FLAGS \
  PGLITE_OXIDE_WASIX_COMPILER_FLAGS \
  PGLITE_OXIDE_WASIX_LINKER_FLAGS
do
  pglite_oxide_reject_asyncify_flag "$pglite_oxide_flag_var"
done

pglite_oxide_apply_wasix_profile() {
  local phase="${1:-build}"

  export PGLITE_OXIDE_PROFILE_CFLAGS
  export PGLITE_OXIDE_PROFILE_LDFLAGS
  export WASIXCC_COMPILER_FLAGS="${PGLITE_OXIDE_WASIX_COMPILER_FLAGS:-}"
  export WASIXCC_LINKER_FLAGS="${PGLITE_OXIDE_WASIX_LINKER_FLAGS:-}"
  export WASIXCC_WASM_OPT_FLAGS="$PGLITE_OXIDE_WASM_OPT_FLAGS"
  if [ -n "${PGLITE_OXIDE_WASM_OPT_SUPPRESS_DEFAULT:-}" ]; then
    export WASIXCC_WASM_OPT_SUPPRESS_DEFAULT="$PGLITE_OXIDE_WASM_OPT_SUPPRESS_DEFAULT"
  fi
  if [ -n "${PGLITE_OXIDE_WASM_OPT_PRESERVE_UNOPTIMIZED:-}" ]; then
    export WASIXCC_WASM_OPT_PRESERVE_UNOPTIMIZED="$PGLITE_OXIDE_WASM_OPT_PRESERVE_UNOPTIMIZED"
  fi

  if [ "$phase" = "configure" ]; then
    export WASIXCC_RUN_WASM_OPT="$PGLITE_OXIDE_WASIX_CONFIGURE_WASM_OPT"
  else
    export WASIXCC_RUN_WASM_OPT="$PGLITE_OXIDE_WASIX_BUILD_WASM_OPT"
  fi
}

pglite_oxide_wasix_profile_signature() {
  printf 'profile=%s\n' "$pglite_oxide_wasix_profile"
  printf 'cflags=%s\n' "$PGLITE_OXIDE_PROFILE_CFLAGS"
  printf 'ldflags=%s\n' "$PGLITE_OXIDE_PROFILE_LDFLAGS"
  printf 'configure_wasm_opt=%s\n' "$PGLITE_OXIDE_WASIX_CONFIGURE_WASM_OPT"
  printf 'build_wasm_opt=%s\n' "$PGLITE_OXIDE_WASIX_BUILD_WASM_OPT"
  printf 'wasm_opt_flags=%s\n' "$PGLITE_OXIDE_WASM_OPT_FLAGS"
  printf 'wasm_opt_suppress_default=%s\n' "${PGLITE_OXIDE_WASM_OPT_SUPPRESS_DEFAULT:-}"
  printf 'wasm_opt_preserve_unoptimized=%s\n' "${PGLITE_OXIDE_WASM_OPT_PRESERVE_UNOPTIMIZED:-}"
  printf 'compiler_flags=%s\n' "${PGLITE_OXIDE_WASIX_COMPILER_FLAGS:-}"
  printf 'linker_flags=%s\n' "${PGLITE_OXIDE_WASIX_LINKER_FLAGS:-}"
  printf 'backend_timing=%s\n' "$PGLITE_OXIDE_WASIX_BACKEND_TIMING"
}
