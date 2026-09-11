#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)" || {
  echo "unable to determine repository root from $script_dir; run this script from a Git checkout" >&2
  exit 1
}
[ -f "$root/package.json" ] && [ -d "$root/runtimes/liboliphaunt-wasix" ] || {
  echo "must run inside the Oliphaunt workspace" >&2
  exit 1
}
cd "$root"

target="${AOT_TARGET:-${1:-}}"
if [ -z "$target" ]; then
  target="$(rustc -vV | awk '/^host:/{print $2}')"
fi
host="$(rustc -vV | awk '/^host:/{print $2}')"
if [ "$target" != "$host" ]; then
  echo "target AOT execution requires the builder host $host to match AOT target $target" >&2
  exit 1
fi

bash runtimes/liboliphaunt-wasix/tools/serialize-aot.sh --target-triple "$target"
cargo run -p xtask -- assets package-aot --target-triple "$target"
cargo run -p xtask -- assets check-aot --target-triple "$target"
