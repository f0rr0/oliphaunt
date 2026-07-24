#!/usr/bin/env sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "$script_dir/common.sh"
repo_root="$(oliphaunt_resolve_repo_root "$script_dir")"
cd "$repo_root"

if [ "${1:-}" != "" ]; then
  node src/runtimes/liboliphaunt/native/tools/run-host-c-smoke.mjs --smoke-only --root "$1"
else
  node src/runtimes/liboliphaunt/native/tools/run-host-c-smoke.mjs --smoke-only
fi
