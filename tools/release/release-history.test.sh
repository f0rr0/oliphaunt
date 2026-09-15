#!/usr/bin/env bash
set -euo pipefail
source_root="$(git rev-parse --show-toplevel)"
repo="$(mktemp -d)"
trap 'rm -rf "$repo"' EXIT
cd "$repo"
git init -q
git config user.name Fixture
git config user.email fixture@example.invalid
mkdir blue red
printf '%s' '{"packages":{"blue":{"component":"alpha"},"red":{"component":"beta"}}}' > release-please-config.json
printf '%s' '{"blue":"1.0.0","red":"8.0.0"}' > .release-please-manifest.json
printf 1.0.0 > blue/VERSION
printf 0.5.0 > blue/PIN
printf 8.0.0 > red/VERSION
printf 9.0.0 > red/PIN
git add .
git commit -qm fixture
git tag alpha-v1.0.0
git tag beta-v8.0.0
mv blue temp
mv red blue
mv temp red
printf '%s' '{"packages":{"red":{"component":"alpha"},"blue":{"component":"beta"}}}' > release-please-config.json
printf '%s' '{"red":"1.1.0","blue":"8.0.0"}' > .release-please-manifest.json
printf 1.1.0 > red/VERSION
printf 0.6.0 > red/PIN
printf 0.6.0 > red/NEW_PIN
git add .
git commit -qm fixture
cd "$source_root"
bun tools/release/release-history.test.mts prepare "$repo"
bash tools/release/with-product-history.sh "$repo" HEAD '' "$repo/graph.json" \
  bun tools/release/release-history.test.mts assert "$repo"
echo 'Release history: actual directory swap preserves tagged component versions and pins'
