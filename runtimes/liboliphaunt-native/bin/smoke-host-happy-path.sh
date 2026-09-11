#!/usr/bin/env sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "$script_dir/common.sh"
repo_root="$(oliphaunt_resolve_repo_root "$script_dir")"
cd "$repo_root"

if [ "${1:-}" != "" ]; then
  bash runtimes/liboliphaunt-native/tools/run-host-c-smoke.sh --smoke-only --root "$1"
else
  bash runtimes/liboliphaunt-native/tools/run-host-c-smoke.sh --smoke-only
fi
