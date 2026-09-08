#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
artifact_root="$PWD/target/sdk-artifacts/oliphaunt-rust"
work_root="$PWD/target/sdk-artifacts-work/oliphaunt-rust"
rm -rf "$artifact_root" "$work_root"
mkdir -p "$artifact_root" "$work_root"
for package in oliphaunt oliphaunt-build; do
  manifest=$(bun src/sdks/rust/tools/prepare-rust-release-source.mts "$package" "$work_root/$package-source")
  crate=$(bash src/shared/artifact-packaging/package-cargo-source.sh "$manifest" "$work_root/$package-crate" "$work_root/$package-files.txt")
  prefix=$(basename "$crate" .crate)
  bun src/shared/artifact-packaging/release-notices.mts check-archive "$crate" --profile source-sdk --prefix "$prefix"
  cp "$crate" "$artifact_root/"
done
cp "$work_root/oliphaunt-files.txt" "$artifact_root/cargo-package-files.txt"
bun src/shared/artifact-packaging/staging.mts "$artifact_root"
