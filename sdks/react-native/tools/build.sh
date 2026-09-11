#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
rm -rf lib .generated-tools
tsc --ignoreConfig --noCheck --target ES2022 --module nodenext --rewriteRelativeImportExtensions \
  --rootDir . --outDir .generated-tools \
  app.plugin.cts react-native.config.cts tools/codegen-check.cts \
  tools/native-resource-closure.mts tools/verify-ios-package.mts
mv .generated-tools/app.plugin.cjs app.plugin.js
mv .generated-tools/react-native.config.cjs react-native.config.js
mv .generated-tools/tools/* tools/
rm -rf .generated-tools
bun build tools/stage-ios-app.mts --target=node --format=esm --outfile=tools/stage-ios-app.mjs
tsc -p tsconfig.build.types.json
tsc -p tsconfig.build.module.json
tsc -p tsconfig.build.commonjs.json
