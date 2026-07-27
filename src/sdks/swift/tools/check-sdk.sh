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
  if [ -n "${OLIPHAUNT_SWIFT_RELEASE_ASSET_DIR:-}" ]; then
    liboliphaunt_version="$(cat src/sdks/swift/LIBOLIPHAUNT_VERSION)"
    release_xcframework="$OLIPHAUNT_SWIFT_RELEASE_ASSET_DIR/liboliphaunt-$liboliphaunt_version-apple-spm-xcframework.zip"
    if [ ! -s "$release_xcframework" ]; then
      echo "Swift release asset directory is missing $release_xcframework" >&2
      exit 1
    fi
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
  first="$scratch_root/swiftpm-extension-products-first"
  second="$scratch_root/swiftpm-extension-products-second"
  rm -rf "$first" "$second"
  fixture_root="$(prepare_scratch_dir swiftpm-extension-input-fixture)"
  cp -R "$package_dir/Tests/Fixtures/." "$fixture_root/"
  fixture="$fixture_root/swiftpm-extension-input.json"
  generator="$root/$package_dir/tools/render-extension-products.mjs"

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

  invalid_input="$fixture_root/swiftpm-extension-products-missing-dependency.json"
  invalid_output="$scratch_root/swiftpm-extension-products-invalid"
  invalid_stdout="$scratch_root/missing-dependency.stdout"
  invalid_stderr="$scratch_root/missing-dependency.stderr"
  rm -rf "$invalid_output"
  node - "$fixture" "$invalid_input" <<'NODE'
const fs = require("node:fs");
const [source, destination] = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(source, "utf8"));
fixture.extensions = fixture.extensions.filter(({ sqlName }) => sqlName !== "cube");
fs.writeFileSync(destination, `${JSON.stringify(fixture, null, 2)}\n`);
NODE
  if node "$generator" --input "$invalid_input" --output-dir "$invalid_output" \
    >"$invalid_stdout" 2>"$invalid_stderr"; then
    echo "SwiftPM extension generator accepted a selected set with a missing dependency" >&2
    exit 1
  fi
  if ! grep -Fq 'earthdistance dependency cube is not present in the selected input' \
    "$invalid_stderr"; then
    echo "SwiftPM extension generator did not diagnose a missing selected dependency" >&2
    cat "$invalid_stderr" >&2
    exit 1
  fi
  if [ -e "$invalid_output" ]; then
    echo "SwiftPM extension generator left partial output for a missing dependency" >&2
    exit 1
  fi

  missing_runtime_input="$fixture_root/swiftpm-extension-products-missing-native-runtime.json"
  missing_runtime_output="$scratch_root/swiftpm-extension-products-missing-native-runtime"
  rm -rf "$missing_runtime_output"
  node - "$fixture" "$missing_runtime_input" <<'NODE'
const fs = require("node:fs");
const [source, destination] = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(source, "utf8"));
delete fixture.nativeRuntime;
fs.writeFileSync(destination, `${JSON.stringify(fixture, null, 2)}\n`);
NODE
  if node "$generator" --input "$missing_runtime_input" --output-dir "$missing_runtime_output" \
    >"$scratch_root/missing-native-runtime.stdout" \
    2>"$scratch_root/missing-native-runtime.stderr"; then
    echo "SwiftPM extension generator accepted input without a native runtime identity" >&2
    exit 1
  fi
  if ! grep -Fq 'nativeRuntime must be an object' "$scratch_root/missing-native-runtime.stderr"; then
    echo "SwiftPM extension generator did not diagnose a missing native runtime identity" >&2
    cat "$scratch_root/missing-native-runtime.stderr" >&2
    exit 1
  fi
  if [ -e "$missing_runtime_output" ]; then
    echo "SwiftPM extension generator left partial output without a native runtime identity" >&2
    exit 1
  fi

  invalid_version_input="$fixture_root/swiftpm-extension-products-invalid-version.json"
  invalid_version_output="$scratch_root/swiftpm-extension-products-invalid-version"
  rm -rf "$invalid_version_output"
  node - "$fixture" "$invalid_version_input" <<'NODE'
const fs = require("node:fs");
const [source, destination] = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(source, "utf8"));
fixture.extensions[0].version = "not-a-semver";
fs.writeFileSync(destination, `${JSON.stringify(fixture, null, 2)}\n`);
NODE
  if node "$generator" --input "$invalid_version_input" --output-dir "$invalid_version_output" \
    >"$scratch_root/invalid-extension-version.stdout" \
    2>"$scratch_root/invalid-extension-version.stderr"; then
    echo "SwiftPM extension generator accepted a non-SemVer extension release identity" >&2
    exit 1
  fi
  if ! grep -Fq 'extensions[0].version must be a stable semantic version in X.Y.Z form' \
    "$scratch_root/invalid-extension-version.stderr"; then
    echo "SwiftPM extension generator did not diagnose a non-SemVer extension release identity" >&2
    cat "$scratch_root/invalid-extension-version.stderr" >&2
    exit 1
  fi
  if [ -e "$invalid_version_output" ]; then
    echo "SwiftPM extension generator left partial output for an invalid extension version" >&2
    exit 1
  fi

  mismatched_runtime_input="$fixture_root/swiftpm-extension-products-mismatched-native-runtime.json"
  mismatched_runtime_output="$scratch_root/swiftpm-extension-products-mismatched-native-runtime"
  rm -rf "$mismatched_runtime_output"
  node - "$fixture" "$mismatched_runtime_input" <<'NODE'
const fs = require("node:fs");
const [source, destination] = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(source, "utf8"));
fixture.nativeRuntime.version = "9.9.9";
fs.writeFileSync(destination, `${JSON.stringify(fixture, null, 2)}\n`);
NODE
  if node "$generator" --input "$mismatched_runtime_input" --output-dir "$mismatched_runtime_output" \
    >"$scratch_root/mismatched-native-runtime.stdout" \
    2>"$scratch_root/mismatched-native-runtime.stderr"; then
    echo "SwiftPM extension generator accepted resources built for another native runtime" >&2
    exit 1
  fi
  if ! grep -Fq 'manifest nativeRuntimeVersion must be "9.9.9"' \
    "$scratch_root/mismatched-native-runtime.stderr"; then
    echo "SwiftPM extension generator did not diagnose a mismatched native runtime" >&2
    cat "$scratch_root/mismatched-native-runtime.stderr" >&2
    exit 1
  fi
  if [ -e "$mismatched_runtime_output" ]; then
    echo "SwiftPM extension generator left partial output for a mismatched native runtime" >&2
    exit 1
  fi

  atomic_input="$fixture_root/swiftpm-extension-products-late-copy-failure.json"
  atomic_output="$scratch_root/swiftpm-extension-products-atomic-output"
  rm -rf "$atomic_output"
  find "$(dirname "$atomic_output")" -maxdepth 1 \
    -name ".$(basename "$atomic_output").tmp-*" -exec rm -rf {} +
  node - "$fixture" "$atomic_input" "$fixture_root/missing.xcframework" <<'NODE'
const fs = require("node:fs");
const [source, destination, missingArtifact] = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(source, "utf8"));
const postgis = fixture.extensions.find(({ sqlName }) => sqlName === "postgis");
postgis.asset.localPath = missingArtifact;
fs.writeFileSync(destination, `${JSON.stringify(fixture, null, 2)}\n`);
NODE
  if node "$generator" --input "$atomic_input" --output-dir "$atomic_output" \
    >"$scratch_root/late-copy-failure.stdout" \
    2>"$scratch_root/late-copy-failure.stderr"; then
    echo "SwiftPM extension generator accepted a missing local XCFramework" >&2
    exit 1
  fi
  if ! grep -Fq 'local binary target OliphauntExtensionPostgisBinary is not a real XCFramework directory' \
    "$scratch_root/late-copy-failure.stderr"; then
    echo "SwiftPM extension generator did not diagnose a late local XCFramework copy failure" >&2
    cat "$scratch_root/late-copy-failure.stderr" >&2
    exit 1
  fi
  if [ -e "$atomic_output" ]; then
    echo "SwiftPM extension generator published partial output after a generation failure" >&2
    exit 1
  fi
  atomic_staging_count="$(find "$(dirname "$atomic_output")" -maxdepth 1 \
    -name ".$(basename "$atomic_output").tmp-*" -type d -print | wc -l | tr -d ' ')"
  if [ "$atomic_staging_count" != "1" ]; then
    echo "SwiftPM extension generator did not retain exactly one private staging tree after failure" >&2
    exit 1
  fi
  if ! grep -Fq 'private staging is retained for explicit cleanup' \
    "$scratch_root/late-copy-failure.stderr"; then
    echo "SwiftPM extension generator did not disclose retained private staging" >&2
    cat "$scratch_root/late-copy-failure.stderr" >&2
    exit 1
  fi
  find "$(dirname "$atomic_output")" -maxdepth 1 \
    -name ".$(basename "$atomic_output").tmp-*" -exec rm -rf {} +

  empty_output="$(prepare_scratch_dir swiftpm-extension-products-empty-output)"
  if node "$generator" --input "$fixture" --output-dir "$empty_output" \
    >"$scratch_root/empty-output.stdout" \
    2>"$scratch_root/empty-output.stderr"; then
    echo "SwiftPM extension generator replaced an existing empty directory" >&2
    exit 1
  fi
  if ! grep -Fq 'create-only generation refuses to replace it' \
    "$scratch_root/empty-output.stderr"; then
    echo "SwiftPM extension generator did not diagnose an existing empty output" >&2
    cat "$scratch_root/empty-output.stderr" >&2
    exit 1
  fi
  if find "$empty_output" -mindepth 1 -print | grep -q .; then
    echo "SwiftPM extension generator modified an existing empty directory" >&2
    exit 1
  fi

  unowned_output="$(prepare_scratch_dir swiftpm-extension-products-unowned-output)"
  printf '%s\n' 'unrelated-user-data' >"$unowned_output/do-not-delete.txt"
  if node "$generator" --input "$fixture" --output-dir "$unowned_output" \
    >"$scratch_root/unowned-output.stdout" \
    2>"$scratch_root/unowned-output.stderr"; then
    echo "SwiftPM extension generator replaced an unowned existing directory" >&2
    exit 1
  fi
  if ! grep -Fq 'create-only generation refuses to replace it' \
    "$scratch_root/unowned-output.stderr"; then
    echo "SwiftPM extension generator did not diagnose an unowned output directory" >&2
    cat "$scratch_root/unowned-output.stderr" >&2
    exit 1
  fi
  if [ "$(cat "$unowned_output/do-not-delete.txt")" != 'unrelated-user-data' ]; then
    echo "SwiftPM extension generator modified an unowned output directory" >&2
    exit 1
  fi

  owned_output="$scratch_root/swiftpm-extension-products-owned-output"
  rm -rf "$owned_output"
  cp -R "$first" "$owned_output"
  printf '%s\n' 'preserve-even-owned-output' >"$owned_output/preserve.txt"
  if node "$generator" --input "$fixture" --output-dir "$owned_output" \
    >"$scratch_root/owned-output.stdout" \
    2>"$scratch_root/owned-output.stderr"; then
    echo "SwiftPM extension generator replaced an existing generator-owned directory" >&2
    exit 1
  fi
  if ! grep -Fq 'create-only generation refuses to replace it' \
    "$scratch_root/owned-output.stderr"; then
    echo "SwiftPM extension generator did not diagnose its create-only output contract" >&2
    cat "$scratch_root/owned-output.stderr" >&2
    exit 1
  fi
  if [ "$(cat "$owned_output/preserve.txt")" != 'preserve-even-owned-output' ]; then
    echo "SwiftPM extension generator modified an existing generator-owned directory" >&2
    exit 1
  fi

  if (
    cd "$fixture_root"
    node "$generator" --input "$fixture" --output-dir . \
      >"$scratch_root/protected-output.stdout" \
      2>"$scratch_root/protected-output.stderr"
  ); then
    echo "SwiftPM extension generator replaced its current/input directory" >&2
    exit 1
  fi
  if ! grep -Fq 'it is equal to or contains protected working directory' \
    "$scratch_root/protected-output.stderr"; then
    echo "SwiftPM extension generator did not diagnose a protected output ancestor" >&2
    cat "$scratch_root/protected-output.stderr" >&2
    exit 1
  fi
  if [ ! -f "$fixture" ]; then
    echo "SwiftPM extension generator removed its protected input fixture" >&2
    exit 1
  fi

  symlink_output="$scratch_root/swiftpm-extension-products-symlink-output"
  rm -rf "$symlink_output"
  ln -s "$first" "$symlink_output"
  if node "$generator" --input "$fixture" --output-dir "$symlink_output" \
    >"$scratch_root/symlink-output.stdout" \
    2>"$scratch_root/symlink-output.stderr"; then
    echo "SwiftPM extension generator accepted a symbolic-link output directory" >&2
    exit 1
  fi
  if ! grep -Fq 'already exists as a symbolic link; refusing to replace it' \
    "$scratch_root/symlink-output.stderr"; then
    echo "SwiftPM extension generator did not diagnose a symbolic-link output" >&2
    cat "$scratch_root/symlink-output.stderr" >&2
    exit 1
  fi

  resource_child_output="$fixture_root/swiftpm-extension-resources/cube/generated-output"
  rm -rf "$resource_child_output"
  if node "$generator" --input "$fixture" --output-dir "$resource_child_output" \
    >"$scratch_root/resource-child-output.stdout" \
    2>"$scratch_root/resource-child-output.stderr"; then
    echo "SwiftPM extension generator accepted output inside an extension resource root" >&2
    exit 1
  fi
  if ! grep -Fq 'overlaps protected cube resource root' \
    "$scratch_root/resource-child-output.stderr"; then
    echo "SwiftPM extension generator did not diagnose output inside a resource root" >&2
    cat "$scratch_root/resource-child-output.stderr" >&2
    exit 1
  fi
  if [ -e "$resource_child_output" ]; then
    echo "SwiftPM extension generator contaminated a protected resource root" >&2
    exit 1
  fi

  resource_parent_output="$fixture_root/swiftpm-extension-resources"
  if node "$generator" --input "$fixture" --output-dir "$resource_parent_output" \
    >"$scratch_root/resource-parent-output.stdout" \
    2>"$scratch_root/resource-parent-output.stderr"; then
    echo "SwiftPM extension generator accepted output containing extension resource roots" >&2
    exit 1
  fi
  if ! grep -Fq 'overlaps protected cube resource root' \
    "$scratch_root/resource-parent-output.stderr"; then
    echo "SwiftPM extension generator did not diagnose output containing a resource root" >&2
    cat "$scratch_root/resource-parent-output.stderr" >&2
    exit 1
  fi

  base_package_root="$scratch_root/swiftpm-extension-base-package"
  base_package_output="$base_package_root/generated-output"
  rm -rf "$base_package_root"
  mkdir -p "$base_package_root"
  printf '%s\n' '// swift-tools-version: 6.0' >"$base_package_root/Package.swift"
  if node "$generator" --input "$fixture" \
    --base-package-path "$base_package_root" \
    --output-dir "$base_package_output" \
    >"$scratch_root/base-package-output.stdout" \
    2>"$scratch_root/base-package-output.stderr"; then
    echo "SwiftPM extension generator accepted output inside its base package" >&2
    exit 1
  fi
  if ! grep -Fq 'overlaps protected base package' \
    "$scratch_root/base-package-output.stderr"; then
    echo "SwiftPM extension generator did not diagnose output inside its base package" >&2
    cat "$scratch_root/base-package-output.stderr" >&2
    exit 1
  fi
  if [ -e "$base_package_output" ]; then
    echo "SwiftPM extension generator contaminated its protected base package" >&2
    exit 1
  fi

  local_xcframework="$fixture_root/postgis-local.xcframework"
  local_xcframework_input="$fixture_root/swiftpm-extension-products-local-xcframework.json"
  local_xcframework_output="$scratch_root/swiftpm-extension-products-local-xcframework"
  rm -rf "$local_xcframework" "$local_xcframework_output"
  mkdir -p \
    "$local_xcframework/ios-arm64/Postgis.framework" \
    "$local_xcframework/ios-arm64/Postgis.framework/EmptyHeaders"
  printf '%s\n' 'fixture plist' >"$local_xcframework/Info.plist"
  printf '%s\n' 'fixture Mach-O bytes' \
    >"$local_xcframework/ios-arm64/Postgis.framework/Postgis"
  chmod 0755 "$local_xcframework/ios-arm64/Postgis.framework/Postgis"
  node - "$fixture" "$local_xcframework_input" "$local_xcframework" <<'NODE'
const fs = require("node:fs");
const [source, destination, localXCFramework] = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(source, "utf8"));
const postgis = fixture.extensions.find(({ sqlName }) => sqlName === "postgis");
postgis.asset.localPath = localXCFramework;
fs.writeFileSync(destination, `${JSON.stringify(fixture, null, 2)}\n`);
NODE
  run node "$generator" --input "$local_xcframework_input" \
    --output-dir "$local_xcframework_output"
  staged_xcframework="$local_xcframework_output/Artifacts/OliphauntExtensionPostgisBinary.xcframework"
  if ! diff -ru "$local_xcframework" "$staged_xcframework"; then
    echo "SwiftPM extension generator did not reproduce the validated XCFramework bytes" >&2
    exit 1
  fi
  if [ ! -x "$staged_xcframework/ios-arm64/Postgis.framework/Postgis" ]; then
    echo "SwiftPM extension generator did not preserve XCFramework executable mode" >&2
    exit 1
  fi

  local_xcframework_overlap="$local_xcframework/generated-output"
  if node "$generator" --input "$local_xcframework_input" \
    --output-dir "$local_xcframework_overlap" \
    >"$scratch_root/local-xcframework-overlap.stdout" \
    2>"$scratch_root/local-xcframework-overlap.stderr"; then
    echo "SwiftPM extension generator accepted output inside a local XCFramework" >&2
    exit 1
  fi
  if ! grep -Fq 'overlaps protected postgis XCFramework' \
    "$scratch_root/local-xcframework-overlap.stderr"; then
    echo "SwiftPM extension generator did not diagnose output inside a local XCFramework" >&2
    cat "$scratch_root/local-xcframework-overlap.stderr" >&2
    exit 1
  fi
  if [ -e "$local_xcframework_overlap" ]; then
    echo "SwiftPM extension generator contaminated a protected local XCFramework" >&2
    exit 1
  fi

  ln -s "$fixture" "$local_xcframework/unsafe-link"
  unsafe_xcframework_output="$scratch_root/swiftpm-extension-products-unsafe-xcframework"
  rm -rf "$unsafe_xcframework_output"
  if node "$generator" --input "$local_xcframework_input" \
    --output-dir "$unsafe_xcframework_output" \
    >"$scratch_root/unsafe-xcframework.stdout" \
    2>"$scratch_root/unsafe-xcframework.stderr"; then
    echo "SwiftPM extension generator accepted a symlink in a local XCFramework" >&2
    exit 1
  fi
  if ! grep -Fq 'contains symlink unsafe-link' "$scratch_root/unsafe-xcframework.stderr"; then
    echo "SwiftPM extension generator did not diagnose an XCFramework symlink" >&2
    cat "$scratch_root/unsafe-xcframework.stderr" >&2
    exit 1
  fi
  if [ -e "$unsafe_xcframework_output" ]; then
    echo "SwiftPM extension generator published output from an unsafe XCFramework" >&2
    exit 1
  fi
  find "$(dirname "$unsafe_xcframework_output")" -maxdepth 1 \
    -name ".$(basename "$unsafe_xcframework_output").tmp-*" -exec rm -rf {} +
  rm "$local_xcframework/unsafe-link"

  find "$first/Sources" -name registration.c -type f -print |
    while IFS= read -r source; do
      run cc -std=c11 -fsyntax-only \
        -I "$package_dir/Sources/COliphaunt/include" \
        -I "$(dirname "$source")/include" \
        "$source"
    done

  carrier_fixture="$(prepare_scratch_dir swift-carrier-resolver)"
  run node "$package_dir/tools/extension-resource-inventory.test.mjs" \
    "$carrier_fixture/inventory"
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

swift_native_required=0
if [ "$mode" = "release-check" ] || [ "$mode" = "smoke-runtime" ] || [ "$mode" = "regression" ] ||
  [ -n "${OLIPHAUNT_SWIFT_REQUIRE_NATIVE:-}" ]; then
  swift_native_required=1
fi
if [ "$swift_native_required" = "1" ]; then
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
run "$root/tools/dev/bun.sh" \
  "$root/tools/release/release-notices.mjs" \
  stage \
  "$archive_package_dir" \
  --profile source-sdk
swift_source_archive="$archive_work_dir/Oliphaunt-source.zip"
run swift package --package-path "$archive_package_dir" archive-source --output "$swift_source_archive"
run "$root/tools/dev/bun.sh" \
  "$root/tools/release/release-notices.mjs" \
  check-archive \
  "$swift_source_archive" \
  --prefix package \
  --profile source-sdk
archive_listing="$archive_work_dir/Oliphaunt-source-files.txt"
unzip -Z -1 "$swift_source_archive" >"$archive_listing"
for required in \
  LICENSE \
  Package.swift \
  README.md \
  THIRD_PARTY_NOTICES.md \
  Sources/COliphaunt/include/COliphaunt.h \
  Sources/COliphaunt/bridge.c \
  Sources/COliphaunt/empty.c \
  Sources/Oliphaunt/Oliphaunt.swift \
  Sources/Oliphaunt/OliphauntQuery.swift \
  Sources/Oliphaunt/OliphauntRuntimeResources.swift \
  Sources/Oliphaunt/OliphauntExtensionResources.swift \
  Sources/OliphauntExtensionSupport/OliphauntExtensionSupport.swift \
  tools/render-extension-products.mjs \
  tools/extension-resource-inventory.mjs \
  tools/extension-resource-inventory.test.mjs \
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
