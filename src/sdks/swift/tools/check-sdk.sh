#!/usr/bin/env sh
set -eu

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

package_dir="src/sdks/swift"
scratch_base="${OLIPHAUNT_SDK_CHECK_SCRATCH:-$root/target/liboliphaunt-sdk-check/oliphaunt-swift}"
. "$root/tools/runtime/preflight.sh"

mode="${1:-release-check}"

case "$mode" in
  check-static|test-unit|package-shape|smoke-runtime|regression|coverage|release-check)
    ;;
  "")
    mode="release-check"
    ;;
  *)
    echo "usage: src/sdks/swift/tools/check-sdk.sh [check-static|test-unit|package-shape|smoke-runtime|regression|coverage|release-check]" >&2
    exit 2
    ;;
esac

scratch_root="$scratch_base/$mode"

run() {
  printf '\n==> %s\n' "$*"
  "$@"
}

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

prepare_scratch_dir() {
  dir="$scratch_root/$1"
  rm -rf "$dir"
  mkdir -p "$dir"
  printf '%s\n' "$dir"
}

require_archive_entry() {
  archive_listing="$1"
  entry="$2"
  if ! grep -Fxq "package/$entry" "$archive_listing"; then
    echo "Swift source archive did not include $entry" >&2
    exit 1
  fi
}

reject_archive_entry_prefix() {
  archive_listing="$1"
  prefix="$2"
  if grep -Eq "^package/$prefix" "$archive_listing"; then
    echo "Swift source archive included generated or local-only files under $prefix" >&2
    exit 1
  fi
}

check_ios_xcframework_if_available() {
  if [ "$(uname -s)" != "Darwin" ]; then
    return 0
  fi
  if src/runtimes/liboliphaunt/native/bin/build-ios-xcframework.sh --check-current; then
    return 0
  fi
  if [ -n "${OLIPHAUNT_SWIFT_REQUIRE_IOS_XCFRAMEWORK:-}" ]; then
    exit 1
  fi
  cat >&2 <<MSG
warning: iOS liboliphaunt XCFramework is missing or stale; Swift package-shape
continues because source package checks do not build release artifacts by
default. Set OLIPHAUNT_SWIFT_REQUIRE_IOS_XCFRAMEWORK=1 for release artifact
verification.
MSG
}

check_swiftpm_release_asset_manifest() {
  liboliphaunt_version="$(cat src/sdks/swift/LIBOLIPHAUNT_VERSION)"
  release_manifest="$scratch_root/Package.swift.release"
  generated_tree="$scratch_root/swiftpm-release-generated"

  if [ -n "${OLIPHAUNT_SWIFT_RELEASE_ASSET_DIR:-}" ]; then
    asset_dir="$OLIPHAUNT_SWIFT_RELEASE_ASSET_DIR"
    asset_base_url="${OLIPHAUNT_SWIFT_RELEASE_ASSET_BASE_URL:-file://$asset_dir}"
    [ -d "$asset_dir" ] || {
      echo "Swift release asset directory does not exist: $asset_dir" >&2
      exit 1
    }
    [ -f "$asset_dir/liboliphaunt-$liboliphaunt_version-apple-spm-xcframework.zip" ] || {
      echo "Swift release asset directory is missing liboliphaunt-$liboliphaunt_version-apple-spm-xcframework.zip" >&2
      exit 1
    }
    [ -f "$asset_dir/liboliphaunt-$liboliphaunt_version-icu-data.tar.gz" ] || {
      echo "Swift release asset directory is missing liboliphaunt-$liboliphaunt_version-icu-data.tar.gz" >&2
      exit 1
    }
  else
    echo "Swift package-shape requires OLIPHAUNT_SWIFT_RELEASE_ASSET_DIR with the real Apple SwiftPM XCFramework asset" >&2
    exit 1
  fi

  run tools/dev/bun.sh tools/release/render_swiftpm_release_package.mjs \
    --asset-dir "$asset_dir" \
    --asset-base-url "$asset_base_url" \
    --output "$release_manifest" \
    --generated-tree "$generated_tree"
  if ! grep -Fq ".binaryTarget(" "$release_manifest"; then
    echo "SwiftPM release fixture manifest did not include a binary liboliphaunt target" >&2
    exit 1
  fi
  if ! grep -Fq "$asset_base_url/liboliphaunt-$liboliphaunt_version-apple-spm-xcframework.zip" "$release_manifest"; then
    echo "SwiftPM release fixture manifest did not resolve the release-shaped Apple XCFramework asset URL" >&2
    exit 1
  fi
  if grep -Fq "liboliphaunt.xcframework" "$release_manifest"; then
    echo "SwiftPM release fixture manifest must not point at a monorepo-local XCFramework path" >&2
    exit 1
  fi
}

check_swiftpm_extension_product_generator() {
  first="$(prepare_scratch_dir swiftpm-extension-products-first)"
  second="$(prepare_scratch_dir swiftpm-extension-products-second)"
  fixture="$package_dir/Tests/Fixtures/swiftpm-extension-input.json"
  generator="$package_dir/tools/render-extension-products.mjs"

  run node "$generator" --input "$fixture" --output-dir "$first"
  run node "$generator" --input "$fixture" --output-dir "$second"
  if ! diff -ru "$first" "$second"; then
    echo "SwiftPM exact-extension product generation is not deterministic" >&2
    exit 1
  fi
  for expected in \
    '"schema": "oliphaunt-swiftpm-extension-products-v1"' \
    '"name": "OliphauntExtensionCube"' \
    '"name": "OliphauntExtensionEarthdistance"' \
    '"name": "OliphauntExtensionPgtap"' \
    '"name": "OliphauntExtensionPostgis"' \
    '"name": "OliphauntNativeDependencyGeos"' \
    '"OliphauntExtensionSupport"' \
    '"OliphauntExtensionCube"'
  do
    if ! grep -Fq "$expected" "$first/extension-products.json"; then
      echo "SwiftPM exact-extension product manifest is missing $expected" >&2
      exit 1
    fi
  done
  if ! grep -Fq 'try OliphauntExtensionCube.register()' \
    "$first/Sources/OliphauntExtensionEarthdistance/OliphauntExtensionEarthdistance.swift"; then
    echo "SwiftPM extension wrapper must register mandatory exact-extension dependencies first" >&2
    exit 1
  fi
  if find "$first/Sources/OliphauntExtensionPgtap" -type f \
    \( -name '*.c' -o -name '*.h' \) | grep -q .; then
    echo "SwiftPM SQL-only exact-extension product unexpectedly contains native registration sources" >&2
    exit 1
  fi
  for resource in \
    "$first/Sources/OliphauntExtensionCube/Resources/extension-artifact/files/share/postgresql/extension/cube.control" \
    "$first/Sources/OliphauntExtensionEarthdistance/Resources/extension-artifact/files/share/postgresql/extension/earthdistance.control" \
    "$first/Sources/OliphauntExtensionPostgis/Resources/extension-artifact/files/share/postgresql/extension/postgis.control" \
    "$first/Sources/OliphauntExtensionPgtap/Resources/extension-artifact/files/share/postgresql/extension/pgtap.control"
  do
    if [ ! -s "$resource" ]; then
      echo "SwiftPM exact-extension resource target is missing $resource" >&2
      exit 1
    fi
  done
  if ! grep -Fq 'resources: [.copy("Resources/extension-artifact")]' \
    "$first/Package.swift"; then
    echo "SwiftPM exact-extension targets do not expose their sanitized resource fragments" >&2
    exit 1
  fi
  for base_product in COliphaunt Oliphaunt OliphauntExtensionSupport; do
    if ! grep -Fq ".product(name: \"$base_product\", package: \"oliphaunt\")" \
      "$first/Package.swift"; then
      echo "SwiftPM consumer integration does not depend on public base product $base_product" >&2
      exit 1
    fi
  done
  if ! grep -Fq 'This local package belongs to the' "$first/Package.swift" ||
    grep -Fq 'oliphauntGeneratedExtensionTargets' "$first/Package.swift"; then
    echo "SwiftPM exact-extension generator must emit a standalone consumer-owned package" >&2
    exit 1
  fi
  run swift package --package-path "$first" dump-package
  if ! grep -Fq 'oliphaunt_register_static_extensions' \
    "$package_dir/Sources/OliphauntExtensionSupport/OliphauntExtensionSupport.swift"; then
    echo "SwiftPM extension support must register the complete selected descriptor set" >&2
    exit 1
  fi
  if ! grep -Fq 'oliphaunt_extension_postgis_3_descriptor' \
    "$first/Sources/COliphauntExtensionPostgis/registration.c"; then
    echo "SwiftPM extension generator did not safely map a dashed native module stem to C" >&2
    exit 1
  fi

  invalid_input="$scratch_root/swiftpm-extension-products-missing-dependency.json"
  invalid_output="$scratch_root/swiftpm-extension-products-invalid"
  node - "$fixture" "$invalid_input" <<'NODE'
const fs = require("node:fs");
const [source, destination] = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(source, "utf8"));
fixture.extensions = fixture.extensions.filter(({ sqlName }) => sqlName !== "cube");
fs.writeFileSync(destination, `${JSON.stringify(fixture, null, 2)}\n`);
NODE
  if node "$generator" --input "$invalid_input" --output-dir "$invalid_output"; then
    echo "SwiftPM extension generator accepted a selected set with a missing dependency" >&2
    exit 1
  fi

  find "$first/Sources" -name registration.c -type f -print |
    while IFS= read -r source; do
      run cc -std=c11 -fsyntax-only \
        -I "$package_dir/Sources/COliphaunt/include" \
        -I "$(dirname "$source")/include" \
        "$source"
    done

  carrier_fixture="$(prepare_scratch_dir swift-carrier-resolver)"
  run node "$package_dir/tools/swift-carrier-resolver.test.mjs" "$carrier_fixture"
  run swift package --package-path "$carrier_fixture/sql-only" dump-package
  sql_build="$(prepare_scratch_dir swift-carrier-sql-only-build)"
  if [ "$(uname -s)" = "Linux" ]; then
    run swift build --package-path "$carrier_fixture/sql-only" \
      --scratch-path "$sql_build" -Xcc -D_GNU_SOURCE
  else
    run swift build --package-path "$carrier_fixture/sql-only" \
      --scratch-path "$sql_build"
  fi
}

require swift
require unzip
require node
require cc
for product in COliphaunt Oliphaunt OliphauntExtensionSupport; do
  if ! grep -Fq ".library(name: \"$product\"" "$package_dir/Package.swift"; then
    echo "Swift base package must expose public consumer integration product $product" >&2
    exit 1
  fi
done
check_swiftpm_extension_product_generator

if [ "$mode" = "coverage" ]; then
  exec tools/coverage/run-product oliphaunt-swift
fi

if [ "$mode" = "check-static" ]; then
  swift_build_scratch="$(prepare_scratch_dir swift-build)"
  run swift package --package-path "$package_dir" --scratch-path "$swift_build_scratch" describe
  run swift build --package-path "$package_dir" --scratch-path "$swift_build_scratch"
  swift_root_build_scratch="$(prepare_scratch_dir swift-root-build)"
  run swift package --package-path "$root" --scratch-path "$swift_root_build_scratch" describe
  run swift build --package-path "$root" --scratch-path "$swift_root_build_scratch"
  exit 0
fi

if [ -z "${LIBOLIPHAUNT_PATH:-}" ] && [ -z "${OLIPHAUNT_INSTALL_DIR:-}" ]; then
  if oliphaunt_runtime_native_host_ready basic; then
    echo "using existing native Oliphaunt runtime at $(oliphaunt_runtime_native_host_work_root)"
  else
    echo "warning: native Oliphaunt runtime unavailable or incomplete; Swift native-direct tests will skip" >&2
    oliphaunt_runtime_native_host_diagnostics basic
  fi
elif [ -n "${OLIPHAUNT_SWIFT_REQUIRE_NATIVE:-}" ]; then
  if ! oliphaunt_runtime_native_host_ready basic; then
    oliphaunt_runtime_native_host_diagnostics basic
    exit 1
  fi
fi

if [ "$mode" = "smoke-runtime" ] || [ "$mode" = "regression" ]; then
  if ! oliphaunt_runtime_native_host_ready basic; then
    oliphaunt_runtime_native_host_diagnostics basic
    exit 1
  fi
  if [ "$mode" = "smoke-runtime" ] && [ "$(uname -s)" = "Darwin" ]; then
    run tools/runtime/preflight.sh ios-simulator
  fi
  liboliphaunt="$(oliphaunt_runtime_native_host_lib)"
  install_dir="$(oliphaunt_runtime_native_host_install_dir)"
  swift_build_scratch="$(prepare_scratch_dir swift-native-runtime)"
  run env OLIPHAUNT_SWIFT_REQUIRE_NATIVE=1 \
    LIBOLIPHAUNT_PATH="$liboliphaunt" \
    OLIPHAUNT_INSTALL_DIR="$install_dir" \
    swift test --package-path "$package_dir" --scratch-path "$swift_build_scratch"
  exit 0
fi

if [ "$mode" != "package-shape" ]; then
  swift_build_scratch="$(prepare_scratch_dir swift-build)"
  run swift package --package-path "$package_dir" --scratch-path "$swift_build_scratch" describe
  run swift test --package-path "$package_dir" --scratch-path "$swift_build_scratch"
  swift_root_build_scratch="$(prepare_scratch_dir swift-root-build)"
  run swift package --package-path "$root" --scratch-path "$swift_root_build_scratch" describe
  run swift test --package-path "$root" --scratch-path "$swift_root_build_scratch"

  if [ "$mode" = "test-unit" ]; then
    exit 0
  fi
fi

archive_work_dir="$(prepare_scratch_dir swift-source-archive)"
check_ios_xcframework_if_available
archive_package_dir="$archive_work_dir/package"
mkdir -p "$archive_package_dir"
cp -R "$package_dir/." "$archive_package_dir/"
rm -rf "$archive_package_dir/.build" "$archive_package_dir/.swiftpm"
swift_source_archive="$archive_work_dir/Oliphaunt-source.zip"
run swift package --package-path "$archive_package_dir" archive-source --output "$swift_source_archive"
archive_listing="$archive_work_dir/Oliphaunt-source-files.txt"
unzip -Z -1 "$swift_source_archive" >"$archive_listing"
for required in \
  Package.swift \
  README.md \
  Sources/COliphaunt/include/COliphaunt.h \
  Sources/COliphaunt/bridge.c \
  Sources/COliphaunt/empty.c \
  Sources/Oliphaunt/Oliphaunt.swift \
  Sources/Oliphaunt/OliphauntQuery.swift \
  Sources/Oliphaunt/OliphauntRuntimeResources.swift \
  Sources/Oliphaunt/OliphauntExtensionResources.swift \
  Sources/OliphauntExtensionSupport/OliphauntExtensionSupport.swift \
  tools/render-extension-products.mjs \
  tools/swift-carrier-resolver.mjs \
  tools/swift-carrier-resolver.test.mjs \
  tools/swiftpm-extension-input.schema.json \
  Tests/Fixtures/swiftpm-extension-input.json \
  Tests/Fixtures/swiftpm-extension-resources/pgtap/manifest.properties \
  Tests/Fixtures/swiftpm-extension-resources/pgtap/files/share/postgresql/extension/pgtap.control \
  Tests/OliphauntTests/ExtensionResourceCompositionTests.swift \
  Tests/OliphauntTests/OliphauntTests.swift \
  Tests/OliphauntTests/ProtocolFixtureTests.swift
do
  require_archive_entry "$archive_listing" "$required"
done
reject_archive_entry_prefix "$archive_listing" "\\.build/"
reject_archive_entry_prefix "$archive_listing" "\\.swiftpm/"
reject_archive_entry_prefix "$archive_listing" "DerivedData/"
if [ "$mode" != "package-shape" ] || [ -n "${OLIPHAUNT_SWIFT_RELEASE_ASSET_DIR:-}" ]; then
  check_swiftpm_release_asset_manifest
fi

if [ "$(uname -s)" = "Darwin" ] && command -v xcodebuild >/dev/null 2>&1; then
  xcode_work_dir="$(prepare_scratch_dir swift-xcodebuild)"
  xcode_package_dir="$xcode_work_dir/package"
  mkdir -p "$xcode_package_dir"
  cp -R "$package_dir/." "$xcode_package_dir/"
  rm -rf "$xcode_package_dir/.build" "$xcode_package_dir/.swiftpm"
  xcode_derived_data="$scratch_root/swift-xcode-derived-data"
  xcode_source_packages="$scratch_root/swift-xcode-source-packages"
  printf '\n==> (cd %s && xcodebuild -scheme Oliphaunt -destination generic/platform=iOS\\ Simulator -derivedDataPath %s -clonedSourcePackagesDirPath %s build)\n' "$xcode_package_dir" "$xcode_derived_data" "$xcode_source_packages"
  (
    cd "$xcode_package_dir"
    xcodebuild \
      -scheme Oliphaunt \
      -destination "generic/platform=iOS Simulator" \
      -derivedDataPath "$xcode_derived_data" \
      -clonedSourcePackagesDirPath "$xcode_source_packages" \
      -skipPackagePluginValidation \
      -quiet \
      build
  )
fi
