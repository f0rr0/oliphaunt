#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
[[ "$(uname -s)" == Darwin ]] || { echo "Broker iOS compilation requires Xcode 26 or newer" >&2; exit 2; }
sdk="$(xcrun --sdk iphoneos --show-sdk-path)"
stage="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-broker-compile.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/ffi" "$stage/COliphaunt"
cp target/mobile-bindings/generated/OliphauntNativeBindingsFFI.h "$stage/ffi/"
cp target/mobile-bindings/generated/OliphauntNativeBindingsFFI.modulemap "$stage/ffi/module.modulemap"
cp src/native/runtime/include/oliphaunt.h "$stage/COliphaunt/"
cp src/native/sdks/swift/Sources/COliphaunt/include/{COliphaunt.h,module.modulemap} "$stage/COliphaunt/"
flags=(-sdk "$sdk" -swift-version 6 -package-name Oliphaunt -parse-as-library -I "$stage" -I "$stage/ffi")
xcrun swiftc "${flags[@]}" -target arm64-apple-ios17.0 -emit-module -module-name OliphauntNativeBindings \
  -emit-module-path "$stage/OliphauntNativeBindings.swiftmodule" target/mobile-bindings/generated/OliphauntNativeBindings.swift
for module in OliphauntCore Oliphaunt OliphauntBroker OliphauntBrokerExtension; do
  deployment=17.0
  case "$module" in OliphauntBroker*) deployment=26.0 ;; esac
  xcrun swiftc "${flags[@]}" -target "arm64-apple-ios$deployment" -emit-module -module-name "$module" \
    -emit-module-path "$stage/$module.swiftmodule" src/native/sdks/swift/Sources/"$module"/*.swift
done
sed 's/__HOST_BUNDLE_IDENTIFIER__/dev.oliphaunt.BrokerCompile/g' \
  src/native/sdks/swift/Templates/OliphauntBroker/OliphauntBroker.swift.template > "$stage/DatabaseExtension.swift"
cp src/native/sdks/swift/Templates/OliphauntBroker/OliphauntBrokerHost.swift.template "$stage/Host.swift"
xcrun swiftc "${flags[@]}" -target arm64-apple-ios26.0 -typecheck "$stage/Host.swift"
xcrun swiftc "${flags[@]}" -target arm64-apple-ios26.0 -application-extension -typecheck "$stage/DatabaseExtension.swift"
for execution in nativeDirect broker; do
  adapter_flags=(-target arm64-apple-ios17.0)
  if [[ "$execution" == broker ]]; then adapter_flags=(-target arm64-apple-ios26.0 -D OLIPHAUNT_BROKER); fi
  xcrun swiftc "${flags[@]}" "${adapter_flags[@]}" \
    -import-objc-header src/native/sdks/react-native/ios/OliphauntAdapter.h \
    -typecheck src/native/sdks/react-native/ios/OliphauntAdapter.swift
done
