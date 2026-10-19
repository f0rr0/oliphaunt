#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
case "$(uname -s)" in
  Linux) strip_unused=-Wl,--gc-sections ;;
  Darwin) strip_unused=-Wl,-dead_strip ;;
  *) echo "archive stream unit test runs in the Linux/macOS C lanes"; exit 0 ;;
esac
scratch=$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-archive-stream.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
source_root="$root/src/native/runtime"
"${CC:-cc}" -std=c11 -D_POSIX_C_SOURCE=200809L -Wall -Wextra -Werror \
  -pthread -ffunction-sections -fdata-sections "$strip_unused" \
  -I "$source_root/src" \
  "$source_root/src/liboliphaunt_archive_tar.c" \
  "$source_root/src/liboliphaunt_fs.c" \
  "$source_root/src/liboliphaunt_error.c" \
  "$source_root/smoke/liboliphaunt_archive_stream.c" \
  -o "$scratch/archive-stream"
"$scratch/archive-stream" "$scratch"
