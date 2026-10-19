#!/usr/bin/env bash
set -euo pipefail

root=$(git rev-parse --show-toplevel)
case "$(uname -s)" in
  Linux) strip_unused=-Wl,--gc-sections ;;
  Darwin) strip_unused=-Wl,-dead_strip ;;
  *) echo "stream queue unit test runs in the Linux/macOS C lanes"; exit 0 ;;
esac
scratch=$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-stream-queue.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
"${CC:-cc}" -std=c11 -D_POSIX_C_SOURCE=200809L -Wall -Wextra -Werror \
  -pthread -ffunction-sections -fdata-sections "$strip_unused" \
  "$root/src/native/runtime/src/liboliphaunt_error.c" \
  "$root/src/native/runtime/smoke/liboliphaunt_stream_queue.c" \
  -o "$scratch/stream-queue"
"$scratch/stream-queue"
