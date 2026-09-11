#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
mode="${1:-}"
target="${OLIPHAUNT_CI_TARGET:-}"
case "$(uname -s):$target" in
  Darwin:macos-arm64|Darwin:) platform=macos ;;
  Linux:linux-arm64-gnu|Linux:linux-x64-gnu|Linux:) platform=linux ;;
  MINGW*:windows-x64-msvc|MSYS*:windows-x64-msvc|MINGW*:|MSYS*:) platform=windows ;;
  *) echo "unsupported native runtime host/target: $(uname -s)/$target" >&2; exit 2 ;;
esac
case "$mode" in
  build)
    [ "$platform" != macos ] || export OLIPHAUNT_BUILD_EXTENSIONS="${OLIPHAUNT_BUILD_EXTENSIONS-0}"
    script="runtimes/liboliphaunt-native/bin/build-postgres18-$platform"
    ;;
  package)
    : "${target:?OLIPHAUNT_CI_TARGET is required for packaging}"
    export OLIPHAUNT_LIBOLIPHAUNT_RELEASE_ASSETS="target/liboliphaunt/desktop-release-assets/$target"
    export OLIPHAUNT_RELEASE_BUILD_RUNTIME=0 OLIPHAUNT_RELEASE_FETCH_ASSETS=0
    script="runtimes/liboliphaunt-native/tools/package-liboliphaunt-$platform-assets"
    ;;
  *) echo 'usage: release-runtime.sh build|package' >&2; exit 2 ;;
esac
exec bash "$script.sh"
