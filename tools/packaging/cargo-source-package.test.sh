#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
bun test --timeout=30000 ./tools/packaging/cargo-source-package.test.mts
scratch=$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-cargo-source-XXXXXX")
trap 'rm -rf "$scratch"' EXIT
bun tools/packaging/cargo-source-package.test.mts prepare "$scratch"
for output in first second; do
  bash tools/packaging/package-cargo-source.sh "$scratch/source/Cargo.toml" "$scratch/$output" > "$scratch/$output.path"
done
bash tools/packaging/package-cargo-source.sh "$scratch/generated/Cargo.toml" "$scratch/cargo-generated" > "$scratch/generated.path"
bun tools/packaging/cargo-source-package.test.mts verify "$scratch"
if bash tools/packaging/package-cargo-source.sh "$scratch/linked/Cargo.toml" "$scratch/linked-out" > "$scratch/link.log" 2>&1; then exit 1; fi
grep -q 'must not be a symbolic link' "$scratch/link.log"
if command -v mkfifo >/dev/null; then
  mkfifo "$scratch/special/src/lib.rs"
  if bash tools/packaging/package-cargo-source.sh "$scratch/special/Cargo.toml" "$scratch/special-out" > "$scratch/fifo.log" 2>&1; then exit 1; fi
  grep -q "source src/lib.rs is absent from Cargo's package selection" "$scratch/fifo.log"
fi
