#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)" || {
  echo "unable to determine repository root from $script_dir; run this script from a Git checkout" >&2
  exit 1
}
[ -f "$root/package.json" ] && [ -d "$root/src/runtimes/liboliphaunt/wasix" ] || {
  echo "must run inside the Oliphaunt workspace" >&2
  exit 1
}
cd "$root"

target="${AOT_TARGET:-${1:-}}"
if [ -z "$target" ]; then
  target="$(rustc -vV | awk '/^host:/{print $2}')"
fi
package="${AOT_PACKAGE:-oliphaunt-wasix-aot-${target}}"

cargo run -p xtask -- assets aot --target-triple "$target"
cargo run -p xtask -- assets package-aot --target-triple "$target"
cargo run -p xtask -- assets package-extension-aot --target-triple "$target"
cargo run -p xtask -- assets check-aot --target-triple "$target"
cargo check -p "$package" --locked
cargo run -p xtask -- assets smoke
