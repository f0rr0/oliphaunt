#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work_root="${LIBPGLITE_WORK_ROOT:-${PGLITE_OXIDE_NATIVE_WORK_ROOT:-$repo_root/target/libpglite-pg18}}"
out_dir="$work_root/out"
install_dir="$work_root/install"
smoke_src="$repo_root/libpglite/smoke/libpglite_smoke.c"
smoke_bin="$out_dir/libpglite_smoke"
libpglite="${LIBPGLITE_OXIDE_LIBPGLITE:-${PGLITE_OXIDE_NATIVE_LIBPGLITE:-$out_dir/libpglite.dylib}}"
initdb="${LIBPGLITE_OXIDE_INITDB:-${PGLITE_OXIDE_NATIVE_INITDB:-$install_dir/bin/initdb}}"
postgres="${LIBPGLITE_OXIDE_POSTGRES:-${PGLITE_OXIDE_NATIVE_POSTGRES:-$install_dir/bin/postgres}}"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "native libpglite smoke currently targets macOS only" >&2
  exit 2
fi

if [ ! -f "$libpglite" ]; then
  echo "missing libpglite dylib: $libpglite" >&2
  echo "run libpglite/bin/build-postgres18-macos.sh first" >&2
  exit 1
fi

if [ ! -x "$initdb" ]; then
  echo "missing initdb: $initdb" >&2
  exit 1
fi

if [ ! -x "$postgres" ]; then
  echo "missing postgres: $postgres" >&2
  exit 1
fi

mkdir -p "$out_dir"

smoke_cc="${LIBPGLITE_SMOKE_CC:-${PGLITE_OXIDE_NATIVE_SMOKE_CC:-${CC:-cc}}}"
ccache_mode="${LIBPGLITE_CCACHE:-${PGLITE_OXIDE_NATIVE_CCACHE:-auto}}"
if [ "$ccache_mode" != "0" ] && [ "$ccache_mode" != "off" ]; then
  if [ "$ccache_mode" != "auto" ]; then
    ccache_bin="$ccache_mode"
  else
    ccache_bin="$(command -v ccache || true)"
  fi
  if [ -n "${ccache_bin:-}" ]; then
    smoke_cc="$ccache_bin $smoke_cc"
  fi
fi

$smoke_cc -O0 -g \
  -I"$repo_root/libpglite/include" \
  "$smoke_src" \
  -L"$(dirname "$libpglite")" \
  -Wl,-rpath,"$(dirname "$libpglite")" \
  -lpglite \
  -o "$smoke_bin"

if [ "${1:-}" != "" ]; then
  root="$1"
  mkdir -p "$root"
  keep_root=1
else
  root="$(mktemp -d "$work_root/smoke.XXXXXX")"
  keep_root=0
fi

pgdata="$root/.pglite-pgdata"
runtime="$root/runtime"
mkdir -p "$pgdata" "$runtime"

export LIBPGLITE_INITDB="$initdb"
export LIBPGLITE_POSTGRES="$postgres"
export LIBPGLITE_OXIDE_INITDB="$initdb"
export LIBPGLITE_OXIDE_POSTGRES="$postgres"
export PGLITE_OXIDE_NATIVE_INITDB="$initdb"
export PGLITE_OXIDE_NATIVE_POSTGRES="$postgres"

set +e
"$smoke_bin" "$pgdata" "$runtime"
status=$?
if [ "$status" -eq 0 ]; then
  "$smoke_bin" "$pgdata" "$runtime"
  status=$?
fi
set -e

if [ "$status" -eq 0 ] && [ "$keep_root" -eq 0 ]; then
  rm -rf "$root"
else
  echo "native smoke root: $root" >&2
fi

exit "$status"
