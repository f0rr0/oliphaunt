#!/usr/bin/env bash
set -eu
version="$1"
bindings_asset="oliphaunt-swift-$version-bindings.xcframework.zip"
expected_url="https://github.com/f0rr0/oliphaunt/releases/download/oliphaunt-swift-v$version/$bindings_asset"
target="$(sed -n '/name: "OliphauntNativeBindingsFFI"/,/)/p' Package.swift)"
url="$(printf '%s\n' "$target" | sed -n 's/.*url: "\([^"]*\)".*/\1/p')"
checksum="$(printf '%s\n' "$target" | sed -n 's/.*checksum: "\([0-9a-f]*\)".*/\1/p')"
[ "$url" = "$expected_url" ] && [ "${#checksum}" -eq 64 ] || {
  echo 'Swift source must contain the checksum-pinned bindings target for the selected SDK version' >&2
  exit 1
}
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
archive="$PWD/Artifacts/$bindings_asset"
if [ ! -f "$archive" ]; then
  archive="$scratch/$bindings_asset"
  curl --fail --location --silent --show-error "$url" --output "$archive"
fi
printf '%s  %s\n' "$checksum" "$archive" | shasum -a 256 -c -
unzip -q "$archive" -d "$scratch"
test -s "$scratch/OliphauntNativeBindingsFFI.xcframework/Info.plist"
mkdir -p Artifacts
rm -rf Artifacts/OliphauntNativeBindingsFFI.xcframework
mv "$scratch/OliphauntNativeBindingsFFI.xcframework" Artifacts/
