#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export OLIPHAUNT_EXPO_IOS_RUNNER="${OLIPHAUNT_EXPO_IOS_RUNNER:-benchmark}"
export OLIPHAUNT_EXPO_IOS_TIMEOUT_SECONDS="${OLIPHAUNT_EXPO_IOS_TIMEOUT_SECONDS:-360}"
exec "$script_dir/../../src/sdks/react-native/tools/mobile-drill.sh" ios benchmark "$@"
