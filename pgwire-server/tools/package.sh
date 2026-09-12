#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
artifact_root="$PWD/target/sdk-artifacts/oliphaunt-pgwire-server"
rm -rf "$artifact_root"
mkdir -p "$artifact_root"
crate=$(bash tools/packaging/package-cargo-source.sh pgwire-server/Cargo.toml "$PWD/target/sdk-artifacts-work/oliphaunt-pgwire-server")
prefix=$(basename "$crate" .crate)
bun tools/packaging/release-notices.mts check-archive "$crate" --profile source-sdk --prefix "$prefix"
cp "$crate" "$artifact_root/"
bun tools/packaging/staging.mts "$artifact_root"
