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

case "${1:-}" in
  "") bash "$script_dir/build-compiler-output.sh" ;;
  --package-only) ;;
  *) echo "usage: ${0##*/} [--package-only]" >&2; exit 2 ;;
esac
cargo run -p xtask -- assets package --skip-aot
cargo run -p xtask -- assets check --strict-generated
