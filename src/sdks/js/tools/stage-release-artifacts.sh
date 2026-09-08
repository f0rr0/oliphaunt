#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
artifact_root="$PWD/target/sdk-artifacts/oliphaunt-js"
work_root="$PWD/target/sdk-artifacts-work/oliphaunt-js"
package_shape=target/liboliphaunt-sdk-check/oliphaunt-js/package-shape/src/sdks/js
[ -f "$package_shape/package.json" ] || { echo "Missing JS package shape: $package_shape" >&2; exit 1; }
rm -rf "$artifact_root" "$work_root"
mkdir -p "$artifact_root" "$work_root"
cp -R "$package_shape" "$work_root/package"
bun src/shared/artifact-packaging/source-only-sdk-package.mts prepare-npm js "$work_root/package"
PNPM_CONFIG_NODE_LINKER=hoisted pnpm --dir "$work_root/package" pack --pack-destination "$artifact_root" --json > "$artifact_root/pnpm-pack.json"
archive="$(bun src/shared/artifact-packaging/npm-package.mts "$artifact_root")"
bun src/shared/artifact-packaging/source-only-sdk-package.mts check-npm-archive js "$archive"
bun src/shared/artifact-packaging/staging.mts "$artifact_root"
