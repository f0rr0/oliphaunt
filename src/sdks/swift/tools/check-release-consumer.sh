#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "check-swift-release-consumer.sh: must run inside the Oliphaunt checkout" >&2
  exit 1
}
cd "$root"

fail() {
  echo "check-swift-release-consumer.sh: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

require_file() {
  [ -f "$1" ] || fail "missing required file: $1"
  [ -s "$1" ] || fail "required file is empty: $1"
}

require_executable() {
  require_file "$1"
  [ -x "$1" ] || fail "required executable is not executable: $1"
}

require_directory() {
  [ -n "${2:-}" ] || fail "missing required environment variable $1"
  [ -d "$2" ] || fail "$1 is not a directory: $2"
}

safe_extract_tar_gz() {
  local archive="$1"
  local destination="$2"
  local member normalized
  require_file "$archive"
  mkdir -p "$destination"
  while IFS= read -r member; do
    [ -n "$member" ] || fail "archive has an empty member name: $archive"
    if [ "$member" = "." ] || [ "$member" = "./" ]; then
      continue
    fi
    normalized="${member#./}"
    case "$normalized" in
      ""|/*|..|../*|*/..|*/../*|*\\*)
        fail "archive contains an unsafe member $member: $archive"
        ;;
    esac
  done < <(tar -tzf "$archive")
  tar -xzf "$archive" -C "$destination"
}

safe_extract_zip() {
  local archive="$1"
  local destination="$2"
  require_file "$archive"
  [ ! -e "$destination" ] && [ ! -L "$destination" ] ||
    fail "verified ZIP destination already exists: $destination"
  node src/sdks/swift/tools/extract-verified-zip.mjs \
    --archive "$archive" \
    --destination "$destination"
}

require_command swift
require_command tar
require_command node
require_command unzip
require_command diff

[ "$(uname -s)" = "Darwin" ] || fail "canonical Swift release consumer must run on macOS"
[ "$(uname -m)" = "arm64" ] || fail "canonical Swift release consumer requires macOS arm64; found $(uname -m)"

candidate_sha="${CI_HEAD_SHA:-}"
[[ "$candidate_sha" =~ ^[0-9a-f]{40}$ ]] ||
  fail "CI_HEAD_SHA must be the full immutable candidate commit"
actual_sha="$(git rev-parse HEAD)"
[ "$actual_sha" = "$candidate_sha" ] ||
  fail "checked-out candidate $actual_sha does not match CI_HEAD_SHA $candidate_sha"

sdk_artifact_dir="${OLIPHAUNT_SWIFT_SDK_ARTIFACT_DIR:-}"
native_asset_dir="${OLIPHAUNT_SWIFT_NATIVE_ASSET_DIR:-}"
require_directory OLIPHAUNT_SWIFT_SDK_ARTIFACT_DIR "$sdk_artifact_dir"
require_directory OLIPHAUNT_SWIFT_NATIVE_ASSET_DIR "$native_asset_dir"

native_version="$(tools/dev/bun.sh tools/release/product-version.mjs version liboliphaunt-native)"
source_archive="$sdk_artifact_dir/Oliphaunt-source.zip"
release_manifest="$sdk_artifact_dir/Package.swift.release"
release_tree="$sdk_artifact_dir/release-tree"
xcframework_archive="$native_asset_dir/liboliphaunt-$native_version-apple-spm-xcframework.zip"
runtime_archive="$native_asset_dir/liboliphaunt-$native_version-runtime-resources.tar.gz"
icu_archive="$native_asset_dir/liboliphaunt-$native_version-icu-data.tar.gz"

for artifact in \
  "$source_archive" \
  "$release_manifest" \
  "$xcframework_archive" \
  "$runtime_archive" \
  "$icu_archive"; do
  require_file "$artifact"
done
require_directory swift-release-tree "$release_tree"

scratch="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-swift-release-consumer.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
release_package="$scratch/release/oliphaunt"
mkdir -p "$release_package/src/sdks/swift"

safe_extract_zip "$source_archive" "$scratch/source"
require_directory swift-source-package "$scratch/source/package"
cp -R "$scratch/source/package/." "$release_package/src/sdks/swift/"
cp -R "$release_tree/." "$release_package/"
safe_extract_zip "$xcframework_archive" "$release_package/Artifacts"

xcframework="$release_package/Artifacts/liboliphaunt.xcframework"
library="$xcframework/macos-arm64/liboliphaunt.framework/liboliphaunt"
require_directory apple-xcframework "$xcframework"
require_executable "$library"
require_file "$xcframework/Info.plist"
require_directory ios-device-slice "$xcframework/ios-arm64"
require_directory ios-simulator-slice "$xcframework/ios-arm64-simulator"

tools/dev/bun.sh tools/release/prepare-swift-release-consumer.mjs \
  --manifest "$release_manifest" \
  --asset "$xcframework_archive" \
  --output "$release_package/Package.swift"
echo "OLIPHAUNT_SWIFT_RELEASE_CONSUMER_STAGE_PASS stage=manifest-localization"

safe_extract_tar_gz "$runtime_archive" "$scratch/runtime-resources"
safe_extract_tar_gz "$icu_archive" "$scratch/icu-data"
resource_root="$scratch/runtime-resources/oliphaunt"
runtime_files="$resource_root/runtime/files"
require_directory swift-resource-root "$resource_root"
require_directory swift-runtime-files "$runtime_files"
require_file "$resource_root/runtime/manifest.properties"
require_file "$resource_root/template-pgdata/manifest.properties"
require_file "$resource_root/template-pgdata/files/PG_VERSION"
require_executable "$runtime_files/bin/initdb"
require_executable "$runtime_files/bin/postgres"
generated_icu="$release_package/generated/swiftpm/OliphauntICU/share/icu"
exact_icu="$scratch/icu-data/share/icu"
require_directory generated-icu "$generated_icu"
require_directory exact-icu "$exact_icu"
diff -qr "$exact_icu" "$generated_icu" >/dev/null ||
  fail "generated SwiftPM ICU resource tree differs from the exact same-run ICU asset"

echo "==> Building the generated exact-candidate SwiftPM release package"
swift package --package-path "$release_package" --scratch-path "$scratch/release-build" describe
swift build --package-path "$release_package" --scratch-path "$scratch/release-build"
echo "OLIPHAUNT_SWIFT_RELEASE_CONSUMER_STAGE_PASS stage=package-build"

consumer="$root/src/sdks/swift/Tests/ReleaseConsumer"
require_file "$consumer/Package.swift"
require_file "$consumer/Sources/OliphauntReleaseSmoke/main.swift"
mkdir -p "$scratch/runtime-cache" "$scratch/database-root"

echo "==> Running an external macOS Swift consumer against exact same-run Apple bytes"
env \
  OLIPHAUNT_SWIFT_RELEASE_PACKAGE="$release_package" \
  OLIPHAUNT_SWIFT_RESOURCE_ROOT="$resource_root" \
  OLIPHAUNT_SWIFT_RUNTIME_CACHE_DIR="$scratch/runtime-cache" \
  OLIPHAUNT_SWIFT_DATABASE_ROOT="$scratch/database-root" \
  LIBOLIPHAUNT_PATH="$library" \
  DYLD_LIBRARY_PATH="$runtime_files/lib:$xcframework/macos-arm64/liboliphaunt.framework${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}" \
  swift run \
    --package-path "$consumer" \
    --scratch-path "$scratch/consumer-build" \
    OliphauntReleaseSmoke
echo "OLIPHAUNT_SWIFT_RELEASE_CONSUMER_PASS"
