#!/usr/bin/env bash
set -euo pipefail

root=$(git rev-parse --show-toplevel)
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    echo "liboliphaunt static-extension registry unit test is covered by the Linux/macOS C lanes"
    exit 0
    ;;
esac

source_root="$root/src/runtimes/liboliphaunt/native"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-static-extension-registry.XXXXXX")
trap 'rm -rf "$scratch"' EXIT

"${CC:-cc}" \
  -std=c11 \
  -Wall \
  -Wextra \
  -Werror \
  -D_POSIX_C_SOURCE=200809L \
  -pthread \
  -I "$source_root/include" \
  -I "$source_root/src" \
  "$source_root/src/liboliphaunt_static_extensions.c" \
  "$source_root/smoke/liboliphaunt_static_extension_registry.c" \
  -o "$scratch/static-extension-registry"

"$scratch/static-extension-registry"
