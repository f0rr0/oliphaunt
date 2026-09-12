#!/usr/bin/env bash
set -euo pipefail
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"
case "$(uname -s):$(uname -m)" in
  Linux:x86_64 | Linux:amd64)
    target=linux-x64-gnu
    library=lib/liboliphaunt.so
    ;;
  Linux:aarch64 | Linux:arm64)
    target=linux-arm64-gnu
    library=lib/liboliphaunt.so
    ;;
  Darwin:arm64 | Darwin:aarch64)
    target=macos-arm64
    library=lib/liboliphaunt.dylib
    ;;
  MINGW*:x86_64 | MSYS*:x86_64)
    target=windows-x64-msvc
    library=bin/oliphaunt.dll
    ;;
  *)
    echo 'Unsupported native artifact test host' >&2
    exit 2
    ;;
esac
if [ -n "${OLIPHAUNT_CI_TARGET:-}" ] && [ "$OLIPHAUNT_CI_TARGET" != "$target" ]; then
  echo "Cannot execute $OLIPHAUNT_CI_TARGET artifacts on $target" >&2
  exit 2
fi
version="$(bun tools/release/product-version.mts version liboliphaunt-native)"
asset_dir="${OLIPHAUNT_LIBOLIPHAUNT_RELEASE_ASSETS:-$root/target/liboliphaunt/desktop-release-assets/$target}"
work_root="${OLIPHAUNT_WORK_ROOT:-}"
case "$target" in
  linux-*) work_root="${OLIPHAUNT_LINUX_WORK_ROOT:-$work_root}" ;;
  windows-*)
    work_root="${OLIPHAUNT_WINDOWS_WORK_ROOT:-$work_root}"
    asset_dir="$(cygpath -u "$asset_dir")"
    ;;
esac
extension=tar.gz
[ "$target" != windows-x64-msvc ] || extension=zip
archive="$asset_dir/liboliphaunt-$version-$target.$extension"
test_root="$root/target/liboliphaunt/artifact-test-$target"
stage="$test_root/package"
rm -rf "$test_root"
mkdir -p "$stage"
if [ "$extension" = zip ]; then
  unzip -q "$archive" -d "$stage"
else
  tar -xzf "$archive" -C "$stage"
fi
case "$target" in
  linux-*) bash tools/packaging/check-linux-consumer-baseline.sh --target "$target" --root "$stage" ;;
esac
env OLIPHAUNT_WORK_ROOT="$work_root" LIBOLIPHAUNT_PATH="$stage/$library" OLIPHAUNT_INSTALL_DIR="$stage/runtime" \
  OLIPHAUNT_SMOKE_BIN_DIR="$test_root/bin" OLIPHAUNT_SMOKE_ROOT="$test_root/databases" \
  bash runtimes/liboliphaunt-native/tools/run-host-c-smoke.sh
