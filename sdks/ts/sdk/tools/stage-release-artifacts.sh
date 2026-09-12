#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
artifact_root="$PWD/target/sdk-artifacts/oliphaunt-js"
work_root="$PWD/target/sdk-artifacts-work/oliphaunt-js"
rm -rf "$artifact_root" "$work_root"
mkdir -p "$artifact_root" "$work_root/package"
rsync -a --exclude node_modules sdks/ts/sdk/ "$work_root/package/"
cp LICENSE THIRD_PARTY_NOTICES.md "$work_root/package/"
bun tools/packaging/source-only-sdk-package.mts prepare-npm js "$work_root/package"
filename="$(bun tools/packaging/npm-package.mts "$work_root/package")"
archive="$artifact_root/$filename"
bun pm pack --cwd "$work_root/package" --filename "$archive"

bun tools/packaging/staging.mts "$artifact_root"
