#!/usr/bin/env bash
set -euo pipefail
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"
family="${1:?native or wasix is required}"
target="${2:-${OLIPHAUNT_CI_TARGET:-}}"
if [ "$family" = wasix ]; then target=portable; fi
if [ -z "$target" ]; then
  source runtimes/liboliphaunt-native/tools/runtime-preflight.sh
  target="$(oliphaunt_runtime_native_host_target_id)"
fi
bash tools/ci/with-projects.sh database-resources/seeds/package-carriers.mts --family "$family" --target "$target"
case "$target" in
  android-datum64|ios-datum64)
    bash tools/ci/with-projects.sh database-resources/seeds/package-mobile-carriers.mts "$target"
    ;;
esac
