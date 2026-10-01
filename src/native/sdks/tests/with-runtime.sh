#!/usr/bin/env bash
set -euo pipefail
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"
. src/native/runtime/tools/runtime-preflight.sh
target="$(oliphaunt_runtime_native_host_target_id)"
version="$(bun tools/release/product-version.mts version liboliphaunt-native)"
assets="${OLIPHAUNT_LIBOLIPHAUNT_RELEASE_ASSETS:-$root/target/liboliphaunt/desktop-release-assets/$target}"
stage="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-sdk-runtime.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
extract() {
  mkdir -p "$2"
  case "$target" in
    windows-*) unzip -q "$1.zip" -d "$2" ;;
    *) tar -xzf "$1.tar.gz" -C "$2" ;;
  esac
}
extract "$assets/liboliphaunt-$version-$target" "$stage"
suffix=
case "$target" in
  windows-*) library=bin/oliphaunt.dll; suffix=.exe ;;
  macos-*) library=lib/liboliphaunt.dylib ;;
  *) library=lib/liboliphaunt.so ;;
esac
export LIBOLIPHAUNT_PATH="$stage/$library"
export OLIPHAUNT_INSTALL_DIR="$stage/runtime"
export OLIPHAUNT_INITDB="$stage/runtime/bin/initdb$suffix"
export OLIPHAUNT_POSTGRES="$stage/runtime/bin/postgres$suffix"
export OLIPHAUNT_EMBEDDED_MODULE_DIR="$stage/lib/modules"
export LD_LIBRARY_PATH="$stage/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
while [ "${1:-}" = --tools ] || [ "${1:-}" = --broker ]; do
  option="$1"
  shift
  if [ "$option" = --tools ]; then
    tools_version="$(bun tools/release/product-version.mts version postgres-tools-native)"
    tools_assets="${OLIPHAUNT_POSTGRES_TOOLS_RELEASE_ASSETS:-$root/target/postgres-tools/native/release-assets}"
    extract "$tools_assets/oliphaunt-tools-$tools_version-$target" "$stage/tools"
    export OLIPHAUNT_TOOLS_DIR="$stage/tools/runtime"
  else
    broker_version="$(bun tools/release/product-version.mts version oliphaunt-broker)"
    broker_assets="${OLIPHAUNT_BROKER_RELEASE_ASSETS:-$root/target/oliphaunt-broker/release-assets}"
    extract "$broker_assets/oliphaunt-broker-$broker_version-$target" "$stage/broker"
    export OLIPHAUNT_BROKER="$stage/broker/bin/oliphaunt-broker$suffix"
    test -x "$OLIPHAUNT_BROKER"
  fi
done
[ "$#" -gt 0 ] || { echo "usage: with-runtime.sh [--tools] [--broker] COMMAND [ARGS...]" >&2; exit 2; }
oliphaunt_runtime_native_host_require basic
"$@"
