#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-independent-versions-XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

# Exercise the current sources in an isolated tree, including uncommitted fixes.
git ls-files -z --cached --others --exclude-standard -- tools src \
  LICENSE THIRD_PARTY_NOTICES.md .prototools package.json Cargo.toml Cargo.lock \
  release-please-config.json .release-please-manifest.json \
  > "$scratch/files"
tar -cf "$scratch/source.tar" --null -T "$scratch/files"
mkdir "$scratch/source"
tar -xf "$scratch/source.tar" -C "$scratch/source"
bash tools/ci/with-projects.sh --exec env OLIPHAUNT_INDEPENDENT_VERSION_TEST=1 \
  bash "$scratch/source/tools/dev/bun.sh" test ./tools/release/independent-version-pins.test.mts
