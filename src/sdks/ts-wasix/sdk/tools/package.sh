#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.."
bun src/sdks/ts-wasix/sdk/tools/package.mts target/oliphaunt-wasix-ts/package
bun src/sdks/ts-wasix/sdk/tools/stage-host.mts --package
mkdir -p target/oliphaunt-wasix-ts/package/packages
bun pm --cwd target/oliphaunt-wasix-ts/package pack --quiet --destination packages
bun src/sdks/ts-wasix/sdk/tools/stage-release-artifacts.mts
bun src/sdks/ts-wasix/sdk/tools/check-package.mts
