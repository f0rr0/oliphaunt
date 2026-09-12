#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../../.."
bun postgres-tools/wasix/ts/tools/package.mts target/oliphaunt-wasix-tools-ts/package
mkdir -p target/oliphaunt-wasix-tools-ts/package/packages
bun pm pack --cwd target/oliphaunt-wasix-tools-ts/package --quiet --destination packages
bun postgres-tools/wasix/ts/tools/stage-release-artifacts.mts
