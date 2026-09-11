#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
[[ "$(uname -s)" == Darwin ]] || { echo "XCFramework assembly requires Xcode on macOS" >&2; exit 2; }
bash sdks/rust/mobile-bindings/tools/generate.sh
stage="$root/target/mobile-bindings/apple"
mkdir -p "$stage/headers"
cp target/mobile-bindings/generated/OliphauntNativeBindingsFFI.h "$stage/headers/"
cp target/mobile-bindings/generated/OliphauntNativeBindingsFFI.modulemap "$stage/headers/module.modulemap"
export IPHONEOS_DEPLOYMENT_TARGET=17.0
export MACOSX_DEPLOYMENT_TARGET=14.0
arguments=()
for target in aarch64-apple-ios aarch64-apple-ios-sim aarch64-apple-darwin; do
  cargo rustc --locked -p oliphaunt-mobile-bindings --release --target "$target" --lib --crate-type staticlib
  arguments+=(-library "${CARGO_TARGET_DIR:-$root/target}/$target/release/liboliphaunt_mobile_bindings.a" -headers "$stage/headers")
done
rm -rf "$stage/OliphauntNativeBindingsFFI.xcframework"
xcodebuild -create-xcframework "${arguments[@]}" -output "$stage/OliphauntNativeBindingsFFI.xcframework"
for target in ios-arm64 ios-simulator-arm64 macos-arm64; do
  bash tools/dev/bun.sh tools/packaging/release-notices.mts stage \
    "$stage/OliphauntNativeBindingsFFI.xcframework/licenses/$target" --profile source-sdk
  bash tools/dev/bun.sh sdks/rust/mobile-bindings/tools/dependency-license-contract.mts stage \
    "$stage/OliphauntNativeBindingsFFI.xcframework/licenses/$target" --target "$target"
done
version="$(cat sdks/swift/VERSION)"
mkdir -p target/oliphaunt-swift/release-assets
bash tools/dev/bun.sh tools/packaging/archive-directory.mts --keep-parent \
  "$stage/OliphauntNativeBindingsFFI.xcframework" \
  "target/oliphaunt-swift/release-assets/oliphaunt-swift-$version-bindings.xcframework.zip"
cd target/oliphaunt-swift/release-assets
shasum -a 256 "./oliphaunt-swift-$version-bindings.xcframework.zip" > "oliphaunt-swift-$version-release-assets.sha256"
