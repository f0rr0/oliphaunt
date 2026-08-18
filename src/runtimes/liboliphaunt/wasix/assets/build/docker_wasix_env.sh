#!/usr/bin/env bash
set -euo pipefail

: "${WASIX_HOME:=/opt/wasixcc-home/.wasixcc}"

if [ "${HOME:-}" != "${WASIX_HOME%/.wasixcc}" ] &&
   [ ! -e "$HOME/.wasixcc" ] &&
   [ ! -L "$HOME/.wasixcc" ]; then
  ln -s "$WASIX_HOME" "$HOME/.wasixcc"
fi

export PATH="$WASIX_HOME/bin:$PATH"

oliphaunt_wasix_wasm_dis() {
  if [ -x "$WASIX_HOME/binaryen/bin/wasm-dis" ]; then
    printf '%s\n' "$WASIX_HOME/binaryen/bin/wasm-dis"
    return 0
  fi
  command -v wasm-dis
}

# WebAssembly SJLJ handlers must be emitted in the module that owns the
# protected frame. An out-of-line sigsetjmp import silently builds but turns a
# later PG_RE_THROW into an uncaught exception, so reject it at production.
oliphaunt_wasix_verify_side_module_sjlj() {
  local module="${1:?WASIX side-module path is required}"
  local wasm_dis
  test -s "$module"
  wasm_dis="$(oliphaunt_wasix_wasm_dis)" || {
    echo "wasm-dis is required to verify WASIX side-module SJLJ: $module" >&2
    return 1
  }
  if "$wasm_dis" "$module" -o - | awk '
    /\(import / && /"sigsetjmp"/ { found = 1 }
    END { exit found ? 0 : 1 }
  '; then
    echo "WASIX side module imports out-of-line sigsetjmp: $module" >&2
    return 1
  fi
}
