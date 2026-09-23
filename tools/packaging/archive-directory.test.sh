#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
bun test ./tools/packaging/archive-directory.test.mts
scratch=$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-archive-interop-XXXXXX")
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/source/nested/empty" "$scratch/extracted"
printf 'archive interoperability\n' > "$scratch/source/nested/data"
bun tools/packaging/archive-directory.mts "$scratch/source" "$scratch/payload.tar.gz"
tar -xzf "$scratch/payload.tar.gz" -C "$scratch/extracted"
cmp "$scratch/source/nested/data" "$scratch/extracted/nested/data"
test -d "$scratch/extracted/nested/empty"
