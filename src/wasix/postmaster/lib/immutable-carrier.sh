#!/usr/bin/env bash

# Shell owns compilation; TypeScript owns the deployment transaction.
fresh_immutable_kernel() (
  set -euo pipefail
  [ "$(uname -s)" = Linux ] || { echo 'immutable deployment requires Linux' >&2; exit 2; }
  local source="$FRESH_ROOT/lib/immutable-kernel.c"
  local directory="$FRESH_WORK_ROOT/immutable-kernel/$(uname -m)/$(fresh_wasmer_bin_hash "$source")"
  local binding="$directory/kernel.node" temporary=""
  if [ ! -f "$binding" ] || [ -L "$binding" ]; then
    mkdir -p "$directory"
    temporary="$(mktemp "$directory/.kernel.XXXXXX")"
    trap 'rm -f "$temporary"' EXIT
    "${HOST_CC:-cc}" -shared -fPIC -std=c11 -Wall -Wextra -Werror "$source" -o "$temporary"
    mv -f "$temporary" "$binding"
  fi
  printf '%s\n' "$binding"
)

fresh_immutable_carrier() {
  local binding
  binding="$(fresh_immutable_kernel)" || return
  OLIPHAUNT_IMMUTABLE_KERNEL="$binding" bun "$FRESH_ROOT/lib/immutable-carrier.mts" "$@"
}
