#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo 'usage: package-cargo-source.sh MANIFEST OUTPUT_DIRECTORY [PACKAGE_LIST]' >&2
  exit 1
fi
helper="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cargo-source-package.mts"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-cargo-source-XXXXXX")
trap 'rm -rf "$scratch"' EXIT
cargo package --manifest-path "$1" --allow-dirty --list > "$scratch/files.txt"
manifest=$(bun "$helper" prepare "$scratch/state.json" "$1" "$2" "$scratch/files.txt")
cargo metadata --manifest-path "$manifest" --format-version 1 --no-deps > "$scratch/metadata.json"
bun "$helper" finish "$scratch/state.json" "$scratch/metadata.json"
if [ "$#" -eq 3 ]; then cp "$scratch/files.txt" "$3"; fi
