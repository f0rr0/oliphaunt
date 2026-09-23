#!/usr/bin/env bash
set -euo pipefail
tool="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/expo-ios-runner.mts"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
fixture="${tool%.mts}.test.mts"
bun "$fixture" prepare "$scratch"
bun "$tool" configure-resource-dependencies "$scratch/workspace.json" "$scratch/example.json" "$scratch/icu.tgz" "$scratch/data.tgz"
bun "$fixture" icu "$scratch"
for invalid in "$scratch/wrong.tgz" "$scratch/standard.tgz"; do
  if bun "$tool" configure-resource-dependencies "$scratch/workspace.json" "$scratch/example.json" "$scratch/icu.tgz" "$invalid" > "$scratch/resource-failure.log" 2>&1; then
    echo 'incompatible ICU resource carrier was accepted' >&2
    exit 1
  fi
  bun "$fixture" icu "$scratch"
done
bun "$tool" configure-resource-dependencies "$scratch/workspace.json" "$scratch/example.json" "$scratch/standard.tgz"
bun "$fixture" standard "$scratch"
bun "$tool" configure-resource-dependencies "$scratch/single.json" "$scratch/single.json" "$scratch/icu.tgz" "$scratch/data.tgz"
bun "$fixture" single "$scratch"
valid='EXTERNAL SOURCES:
  OliphauntReactNativePayload:
    :path: oliphaunt'
printf '%s\n' "$valid" > "$scratch/Podfile.lock"
bun "$tool" validate-pod-source "$scratch/Podfile.lock" "$scratch/oliphaunt" 1
printf '%s\n' "$valid"$'\nPODS:\n  - OliphauntICU (1.0)\n  - OliphauntSeedNativeIOSICU (1.0)' > "$scratch/Podfile.lock"
bun "$tool" validate-pod-source "$scratch/Podfile.lock" "$scratch/oliphaunt"
for value in \
  "${valid/:path: oliphaunt/:path: ../elsewhere}" \
  "$valid"$'\n    :git: https://example.invalid/payload.git'; do
  printf '%s\n' "$value" > "$scratch/Podfile.lock"
  if bun "$tool" validate-pod-source "$scratch/Podfile.lock" "$scratch/oliphaunt" 1 > "$scratch/failure.log" 2>&1; then
    echo 'invalid CocoaPods source unexpectedly accepted' >&2
    exit 1
  fi
done
mkdir "$scratch/nested"
printf '%s\n' 'weak let first: Object?' 'nonisolated(unsafe) weak var second: Object?' 'let third: Object?' > "$scratch/nested/Refs.swift"
printf '%s\n' 'nonisolated(unsafe) weak var first: Object?' 'nonisolated(unsafe) weak var second: Object?' 'let third: Object?' > "$scratch/expected"
bun "$tool" patch-weak-references "$scratch"
cmp "$scratch/expected" "$scratch/nested/Refs.swift"
bun "$tool" patch-weak-references "$scratch"
cmp "$scratch/expected" "$scratch/nested/Refs.swift"

# Exercise the exact CocoaPods prepare command against a local bindings archive.
root="$(cd "$(dirname "$tool")/../../../.." && pwd)"
prepare="$root/src/sdks/react-native/ios/podspecs/prepare-native-bindings.sh"
version=1.2.3
asset="oliphaunt-swift-$version-bindings.xcframework.zip"
url="https://github.com/f0rr0/oliphaunt/releases/download/oliphaunt-swift-v$version/$asset"
mkdir -p "$scratch/input/OliphauntNativeBindingsFFI.xcframework" "$scratch/pod/Artifacts"
printf '%s\n' fixture-plist > "$scratch/input/OliphauntNativeBindingsFFI.xcframework/Info.plist"
bun "$root/tools/packaging/archive-directory.mts" --keep-parent \
  "$scratch/input/OliphauntNativeBindingsFFI.xcframework" "$scratch/pod/Artifacts/$asset"
checksum="$(shasum -a 256 "$scratch/pod/Artifacts/$asset" | cut -d ' ' -f 1)"
cat > "$scratch/pod/Package.swift" <<EOF
.binaryTarget(
    name: "OliphauntNativeBindingsFFI",
    url: "$url",
    checksum: "$checksum"
)
EOF
(
  cd "$scratch/pod"
  bash "$prepare" "$version"
  bash "$prepare" "$version"
  cmp "$scratch/input/OliphauntNativeBindingsFFI.xcframework/Info.plist" Artifacts/OliphauntNativeBindingsFFI.xcframework/Info.plist
  test ! -d Artifacts/OliphauntNativeBindingsFFI.xcframework/OliphauntNativeBindingsFFI.xcframework
  cp "Artifacts/$asset" "$scratch/download.zip"
  mkdir "$scratch/bin"
  cat > "$scratch/bin/curl" <<'CURL'
#!/usr/bin/env bash
set -eu
test "$5" = "$EXPECTED_BINDINGS_URL"
printf '%s\n' "$5" > "$DOWNLOAD_LOG"
cp "$DOWNLOAD_ARCHIVE" "$7"
CURL
  chmod +x "$scratch/bin/curl"
  rm "Artifacts/$asset"
  PATH="$scratch/bin:$PATH" EXPECTED_BINDINGS_URL="$url" \
    DOWNLOAD_LOG="$scratch/download.log" DOWNLOAD_ARCHIVE="$scratch/download.zip" \
    bash "$prepare" "$version"
  test "$(cat "$scratch/download.log")" = "$url"
  cmp "$scratch/input/OliphauntNativeBindingsFFI.xcframework/Info.plist" Artifacts/OliphauntNativeBindingsFFI.xcframework/Info.plist
  cp "$scratch/download.zip" "Artifacts/$asset"
  printf tampered >> "Artifacts/$asset"
  if bash "$prepare" "$version" > "$scratch/checksum-failure.log" 2>&1; then
    echo 'CocoaPods accepted a corrupt bindings archive' >&2
    exit 1
  fi
  cmp "$scratch/input/OliphauntNativeBindingsFFI.xcframework/Info.plist" Artifacts/OliphauntNativeBindingsFFI.xcframework/Info.plist
  if bash "$prepare" 9.9.9 > "$scratch/version-failure.log" 2>&1; then
    echo 'CocoaPods accepted another SDK version bindings target' >&2
    exit 1
  fi
)
