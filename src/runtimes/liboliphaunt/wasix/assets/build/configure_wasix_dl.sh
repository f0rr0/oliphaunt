#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null || (cd "$ROOT/../../../../../.." && pwd))"
GENERATED_ROOT="${OLIPHAUNT_WASM_GENERATED_ROOT:-$REPO_ROOT/target/oliphaunt-wasix/wasix-build}"
. "$ROOT/wasix_icu_link.sh"

if [ -z "${PGSRC:-}" ]; then
  PGSRC="$(SOURCE_CACHE="${SOURCE_CACHE:-$REPO_ROOT/target/liboliphaunt-pg18/source}" "$ROOT/prepare_postgres_source.sh")"
fi
BUILD="${BUILD_DIR:-$GENERATED_ROOT/work/configure-smoke}"

WASIX_HOME="${WASIX_HOME:-/tmp/wasixcc-home/.wasixcc}"
export HOME="${WASIX_HOME%/.wasixcc}"
export PATH="$WASIX_HOME/bin:$PATH"

mkdir -p "$BUILD"

. "$ROOT/profile_flags.sh"
oliphaunt_wasix_apply_wasix_profile configure

ICU_PREFIX="${ICU_PREFIX:-$("$ROOT/build_wasix_icu.sh")}"
ICU_CFLAGS="$(oliphaunt_wasix_icu_cflags "$ICU_PREFIX")"
ICU_LIBS="$(oliphaunt_wasix_icu_libs "$ICU_PREFIX")"

COMMON_CPPFLAGS="-I$PGSRC/src/include/port/wasix-dl"
if [ "${OLIPHAUNT_WASM_WASIX_BACKEND_TIMING:-0}" = "1" ]; then
  COMMON_CPPFLAGS="$COMMON_CPPFLAGS -DOLIPHAUNT_WASIX_BACKEND_TIMING"
fi
COMMON_CPPFLAGS="$COMMON_CPPFLAGS $ICU_CFLAGS"
COMMON_CFLAGS="$OLIPHAUNT_WASM_PROFILE_CFLAGS -sWASM_EXCEPTIONS=yes -sPIC=yes -Wno-unused-command-line-argument"
COMMON_LDFLAGS="$OLIPHAUNT_WASM_PROFILE_LDFLAGS -sWASM_EXCEPTIONS=yes -sPIC=yes -L$ICU_PREFIX/lib"
MAIN_LDFLAGS="-sMODULE_KIND=dynamic-main -sSTACK_SIZE=8MB -sINITIAL_MEMORY=128MB"
SIDE_MODULE_LDFLAGS="-Wl,-shared"
CONFIGURE_EXTRA_ARGS=()
if [ "${OLIPHAUNT_WASM_PG18_DISABLE_SPINLOCKS:-0}" = "1" ]; then
  # Experimental only. Keep the
  # production default on WASIX atomics unless perf data justifies changing it.
  CONFIGURE_EXTRA_ARGS+=("--disable""-spinlocks")
fi

mkdir -p "$GENERATED_ROOT/build/wasix-oliphaunt"
OLIPHAUNT_SHIM="$GENERATED_ROOT/build/wasix-oliphaunt/oliphaunt_wasix_bridge.o"

wasixcc $COMMON_CFLAGS $COMMON_CPPFLAGS \
  -include stdbool.h \
  -include stdlib.h \
  -I"$PGSRC/src/include/port/wasix-dl" \
  -c "$ROOT/wasix_shim/oliphaunt_wasix_bridge.c" \
  -o "$OLIPHAUNT_SHIM"

OLIPHAUNT_CFLAGS="\
 -Dsystem=oliphaunt_wasix_system -Dpopen=oliphaunt_wasix_popen -Dpclose=oliphaunt_wasix_pclose\
 -Dexit=oliphaunt_wasix_exit\
 -Dmunmap=oliphaunt_wasix_munmap\
 -Dfcntl=oliphaunt_wasix_fcntl\
 -Datexit=oliphaunt_wasix_atexit\
 -Dsetsockopt=oliphaunt_wasix_setsockopt -Dgetsockopt=oliphaunt_wasix_getsockopt -Dgetsockname=oliphaunt_wasix_getsockname\
 -Dconnect=oliphaunt_wasix_connect\
 -Dpoll=oliphaunt_wasix_poll\
 -Dlongjmp=oliphaunt_wasix_longjmp -Dsiglongjmp=oliphaunt_wasix_siglongjmp\
 -Wno-declaration-after-statement\
 -Wno-macro-redefined\
 -Wno-unused-function\
 -Wno-missing-prototypes\
 -Wno-incompatible-pointer-types"

cd "$BUILD"

CC=wasixcc \
CXX=wasixcc++ \
AR=wasixar \
RANLIB=wasixranlib \
NM=wasixnm \
CPPFLAGS="$COMMON_CPPFLAGS" \
CFLAGS="$COMMON_CFLAGS$OLIPHAUNT_CFLAGS" \
LDFLAGS="$COMMON_LDFLAGS" \
ICU_CFLAGS="$ICU_CFLAGS" \
ICU_LIBS="$ICU_LIBS" \
LDFLAGS_EX="$MAIN_LDFLAGS $OLIPHAUNT_SHIM" \
LDFLAGS_SL="$SIDE_MODULE_LDFLAGS" \
"$PGSRC/configure" \
  --prefix=/ \
  --libdir=/lib \
  --datadir=/share/postgresql \
  --bindir=/bin \
  --host=wasm32-wasix \
  --with-template=wasix-dl \
  --without-readline \
  --with-icu \
  --without-zlib \
  --without-llvm \
  --disable-largefile \
  --without-pam \
  --with-openssl=no \
  "${CONFIGURE_EXTRA_ARGS[@]}"
