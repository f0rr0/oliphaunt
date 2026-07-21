#!/usr/bin/env bash
set -euo pipefail

root=$(git rev-parse --show-toplevel)
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    echo "liboliphaunt module-dir resolver test is covered by the Linux/macOS C lanes"
    exit 0
    ;;
esac

scratch=$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-module-dir-test.XXXXXX")
trap 'rm -rf "$scratch"' EXIT

compiler=${CC:-cc}
linker_args=()
if [[ "$(uname -s)" == Linux ]]; then
  linker_args=(-ldl)
fi

"$compiler" \
  -std=c11 \
  -Wall \
  -Wextra \
  -Werror \
  -I "$root/src/runtimes/liboliphaunt/native/include" \
  -I "$root/src/runtimes/liboliphaunt/native/src" \
  "$root/src/runtimes/liboliphaunt/native/smoke/liboliphaunt_module_dir_resolver.c" \
  "$root/src/runtimes/liboliphaunt/native/src/liboliphaunt_fs.c" \
  "${linker_args[@]}" \
  -o "$scratch/liboliphaunt_module_dir_resolver"

mkdir "$scratch/fixture"
"$scratch/liboliphaunt_module_dir_resolver" "$scratch/fixture"
