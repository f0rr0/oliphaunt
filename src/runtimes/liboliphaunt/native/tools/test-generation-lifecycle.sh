#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
source_root="$root/src/runtimes/liboliphaunt/native"
work_root="$root/target/liboliphaunt-generation-lifecycle-test"

platform_lib=
case "$(uname -s)" in
  Linux) platform_lib=-ldl ;;
  Darwin) ;;
  *)
    echo "liboliphaunt generation lifecycle test is not applicable on $(uname -s)"
    exit 0
    ;;
esac

rm -rf "$work_root"
mkdir -p "$work_root"
trap 'rm -rf "$work_root"' EXIT

cc \
  -std=c11 \
  -D_POSIX_C_SOURCE=200809L \
  -Wall \
  -Wextra \
  -Werror \
  -pthread \
  -I "$source_root/include" \
  -I "$source_root/src" \
  "$source_root/src/liboliphaunt_backup_state.c" \
  "$source_root/src/liboliphaunt_config.c" \
  "$source_root/src/liboliphaunt_process.c" \
  "$source_root/smoke/liboliphaunt_generation_lifecycle.c" \
  ${platform_lib:+"$platform_lib"} \
  -o "$work_root/generation-lifecycle"

"$work_root/generation-lifecycle"
