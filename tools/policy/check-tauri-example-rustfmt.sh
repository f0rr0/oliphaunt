#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

mapfile -t rust_files < <(git ls-files -- examples/tauri/src-tauri examples/tauri-wasix/src-tauri | awk '/\.rs$/ { print }' | sort)
[ "${#rust_files[@]}" -gt 0 ] || exit 0

rustfmt --edition 2021 --check "${rust_files[@]}"
