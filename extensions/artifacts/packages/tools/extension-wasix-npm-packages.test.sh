#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
OLIPHAUNT_EXTENSION_NODE_FIXTURES="$scratch" bun test ./extensions/artifacts/packages/tools/extension-wasix-npm-packages.test.mts
while IFS= read -r entrypoint; do
  node extensions/artifacts/packages/tools/testdata/inspect-wasix-descriptor.mts "$entrypoint"
done < "$scratch/entrypoints"
echo 'Actual Node imports verify frozen descriptors and carrier bytes'
