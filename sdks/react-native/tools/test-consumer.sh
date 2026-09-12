#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
archives=(target/sdk-artifacts/oliphaunt-react-native/*.tgz)
[ "${#archives[@]}" -eq 1 ] && [ -f "${archives[0]}" ]
bash sdks/react-native/tools/check-icu-autolinking.sh \
  "$PWD/${archives[0]}" "$PWD/database-resources/icu/npm" "$PWD/examples/react-native-expo"
