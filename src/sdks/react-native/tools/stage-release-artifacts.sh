#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
artifact_root="$PWD/target/sdk-artifacts/oliphaunt-react-native"
work_root="$PWD/target/sdk-artifacts-work/oliphaunt-react-native"
rm -rf "$artifact_root" "$work_root"
mkdir -p "$artifact_root" "$work_root"
bun src/sdks/react-native/tools/stage-release-artifacts.mts "$artifact_root" "$work_root"
node src/shared/js-core/tools/stage-package.mts "$work_root/package" src/shared/js-core
node "$work_root/package/tools/verify-ios-package.mjs" --package-dir "$work_root/package"
bun src/shared/artifact-packaging/source-only-sdk-package.mts prepare-npm react-native "$work_root/package"
PNPM_CONFIG_NODE_LINKER=hoisted pnpm --dir "$work_root/package" pack --pack-destination "$artifact_root" --json > "$artifact_root/pnpm-pack.json" || {
  cat "$artifact_root/pnpm-pack.json" >&2
  exit 1
}
archive="$(bun src/shared/artifact-packaging/npm-package.mts "$artifact_root")"
bun src/shared/artifact-packaging/source-only-sdk-package.mts check-npm-archive react-native "$archive"
bash src/sdks/react-native/tools/check-icu-autolinking.sh \
  "$archive" "$PWD/src/runtimes/liboliphaunt/native/icu-npm" "$PWD/examples/react-native-expo"
bun src/shared/artifact-packaging/staging.mts "$artifact_root"
