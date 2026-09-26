#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.."
bun src/wasix/sdks/ts/tools/package.mts target/oliphaunt-wasix-ts/package
bun src/wasix/sdks/ts/tools/stage-host.mts --package
mkdir -p target/oliphaunt-wasix-ts/package/packages
bun pm --cwd target/oliphaunt-wasix-ts/package pack --quiet --destination packages
bun src/wasix/sdks/ts/tools/stage-release-artifacts.mts
bun src/wasix/sdks/ts/tools/check-package.mts
