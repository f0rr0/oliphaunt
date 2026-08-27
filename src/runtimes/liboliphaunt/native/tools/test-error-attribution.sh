#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    echo "liboliphaunt error attribution unit test is covered by the Linux/macOS C lanes"
    exit 0
    ;;
esac

source_root="$repo_root/src/runtimes/liboliphaunt/native"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-error-attribution.XXXXXX")
trap 'rm -rf "$scratch"' EXIT

"${CC:-cc}" \
  -std=c11 \
  -Wall \
  -Wextra \
  -Werror \
  -Wpedantic \
  -D_POSIX_C_SOURCE=200809L \
  -pthread \
  -I "$source_root/include" \
  -I "$source_root/src" \
  "$source_root/src/liboliphaunt_error.c" \
  "$source_root/smoke/liboliphaunt_error_attribution.c" \
  -o "$scratch/error-attribution"

"$scratch/error-attribution"
