#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$root" ]; then
  root="$(cd "$script_dir/../../../../.." && pwd)"
fi
cd "$root"

target="${OLIPHAUNT_EXTENSION_TARGET:-macos-arm64}"
case "$target" in
  macos-arm64|linux-x64-gnu|linux-arm64-gnu|windows-x64-msvc|ios-xcframework|android-arm64-v8a|android-x86_64)
    exec src/extensions/artifacts/native/tools/package-release-assets.sh
    ;;
  *)
    cat >&2 <<MSG
unsupported native extension artifact target: $target

Native exact-extension artifact CI currently has producers for:
  macos-arm64
  linux-x64-gnu
  linux-arm64-gnu
  windows-x64-msvc
  ios-xcframework
  android-arm64-v8a
  android-x86_64
MSG
    exit 2
    ;;
esac
