#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

extensions="$(bun src/sdks/react-native/tools/qualify-ios-carriers.mts selection)"
node src/sdks/react-native/tools/stage-ios-app.mts \
  --carrier "$IOS_CARRIER_MANIFEST" \
  --output-dir "$IOS_CARRIER_STAGE" \
  --extensions "$extensions" \
  --icu \
  --cache-dir "$IOS_CARRIER_CACHE" \
  --allow-file-urls
bun src/sdks/react-native/tools/qualify-ios-carriers.mts verify
mkdir -p target/release/ios-carriers/qualification
cp "$IOS_CARRIER_STAGE/selection.json" \
  target/release/ios-carriers/qualification/all-extensions-selection.json
cp "$IOS_CARRIER_STAGE/resources/OliphauntReactNativeResources.bundle/oliphaunt/package-size.tsv" \
  target/release/ios-carriers/qualification/all-extensions-package-size.tsv
rm -rf "$IOS_CARRIER_STAGE" "$IOS_CARRIER_CACHE"
