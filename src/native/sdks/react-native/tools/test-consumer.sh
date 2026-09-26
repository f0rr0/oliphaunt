#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.."
archives=(target/sdk-artifacts/oliphaunt-react-native/*.tgz)
[ "${#archives[@]}" -eq 1 ] && [ -f "${archives[0]}" ]
bash src/native/sdks/react-native/tools/check-icu-autolinking.sh \
  "$PWD/${archives[0]}" "$PWD/src/database-resources/icu/npm" "$PWD/src/examples/native/react-native-expo"
