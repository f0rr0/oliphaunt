#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
bash sdks/rust/mobile-bindings/tools/generate.sh
stage="$root/sdks/swift/.build/native-bindings"
mkdir -p "$stage/swift" "$stage/ffi"
cp target/mobile-bindings/generated/OliphauntNativeBindings.swift "$stage/swift/"
cp target/mobile-bindings/generated/OliphauntNativeBindingsFFI.h "$stage/ffi/"
cp target/mobile-bindings/generated/OliphauntNativeBindingsFFI.modulemap "$stage/ffi/module.modulemap"
cp "${CARGO_TARGET_DIR:-$root/target}/debug/liboliphaunt_mobile_bindings.a" "$stage/"
