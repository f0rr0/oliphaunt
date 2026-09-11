#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
bun test ./tools/packaging/source-only-sdk-package.test.mts
scratch=$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-source-sdk-XXXXXX")
trap 'rm -rf "$scratch"' EXIT
bun tools/packaging/source-only-sdk-package.test.mts prepare "$scratch"
for package in "$scratch"/*/package; do
  mkdir -p "${package%/package}/packed"
  bun pm pack --cwd "$package" --destination "${package%/package}/packed" --ignore-scripts
done
bun tools/packaging/source-only-sdk-package.test.mts verify "$scratch"
