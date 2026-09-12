#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
artifact_root="$PWD/target/sdk-artifacts/oliphaunt-wasix-rust"
rm -rf "$artifact_root"
mkdir -p "$artifact_root"
manifest=$(bun sdks/rust-wasix/tools/prepare-rust-release-source.mts)
crate=$(bash tools/packaging/package-cargo-source.sh "$manifest" "$PWD/target/sdk-artifacts-work/oliphaunt-wasix-rust" "$artifact_root/cargo-package-files.txt")
prefix=$(basename "$crate" .crate)
bun tools/packaging/release-notices.mts check-archive "$crate" --profile source-sdk --prefix "$prefix"
cp "$crate" "$artifact_root/"
bun tools/packaging/staging.mts "$artifact_root"
