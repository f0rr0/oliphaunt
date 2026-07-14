#!/usr/bin/env sh
set -eu

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

. "$root/src/sdks/react-native/tools/android-smoke-artifacts.sh"

scratch_root_base="${OLIPHAUNT_SDK_CHECK_SCRATCH:-$root/target/liboliphaunt-sdk-check/oliphaunt-react-native}"
source_package_dir="src/sdks/react-native"
mode="${1:-release-check}"

case "$mode" in
  check-static|build-android-bridge|build-ios-bridge|test-unit|package-shape|smoke-runtime|regression|coverage|release-check)
    ;;
  "")
    mode="release-check"
    ;;
  *)
    echo "usage: src/sdks/react-native/tools/check-sdk.sh [check-static|build-android-bridge|build-ios-bridge|test-unit|package-shape|smoke-runtime|regression|coverage|release-check]" >&2
    exit 2
    ;;
esac

scratch_root="$scratch_root_base/$mode"
package_dir="$scratch_root/$source_package_dir"
android_dir="$package_dir/android"

if [ -z "${ANDROID_HOME:-}" ] && [ -d "$HOME/Library/Android/sdk" ]; then
  export ANDROID_HOME="$HOME/Library/Android/sdk"
fi
if [ -n "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ]; then
  export ANDROID_SDK_ROOT="$ANDROID_HOME"
fi
if [ -z "${JAVA_HOME:-}" ] &&
  [ -d /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ]; then
  export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
  export PATH="$JAVA_HOME/bin:$PATH"
fi
java_major="$(
  java -version 2>&1 |
    awk -F '[\".]' '/version/ { print $2; exit }' || true
)"
case "$java_major" in
  2[4-9]|[3-9][0-9]*)
    case " ${JAVA_TOOL_OPTIONS:-} " in
      *" --enable-native-access=ALL-UNNAMED "*)
        ;;
      *)
        export JAVA_TOOL_OPTIONS="--enable-native-access=ALL-UNNAMED ${JAVA_TOOL_OPTIONS:-}"
        ;;
    esac
    ;;
esac

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

require_manifest_line() {
  manifest="$1"
  expected="$2"
  message="$3"
  if ! grep -Fxq "$expected" "$manifest"; then
    echo "$message" >&2
    echo "expected '$expected' in $manifest" >&2
    exit 1
  fi
}

require_source_text() {
  file="$1"
  expected="$2"
  message="$3"
  if ! grep -Fq "$expected" "$file"; then
    echo "$message" >&2
    echo "expected '$expected' in $file" >&2
    exit 1
  fi
}

link_required_header() {
  destination="$1"
  shift
  for candidate in "$@"; do
    if [ -f "$candidate" ]; then
      ln -sf "$candidate" "$destination"
      return 0
    fi
  done
  echo "missing required React Native header for syntax check: $destination" >&2
  for candidate in "$@"; do
    echo "  tried: $candidate" >&2
  done
  exit 1
}

prepare_scratch_dir() {
  dir="$scratch_root/$1"
  rm -rf "$dir"
  mkdir -p "$dir"
  printf '%s\n' "$dir"
}

prepare_react_native_package_worktree() {
  require rsync
  rm -rf "$package_dir"
  mkdir -p "$package_dir"
  cat >"$scratch_root/package.json" <<'JSON'
{
  "name": "oliphaunt-react-native-sdk-check-workspace",
  "private": true,
  "packageManager": "pnpm@11.5.0"
}
JSON
  run node "$root/tools/dev/write-scoped-pnpm-workspace.mjs" \
    --source "$root/pnpm-workspace.yaml" \
    --output "$scratch_root/pnpm-workspace.yaml" \
    --package "src/sdks/react-native"
  # Generate a package-scoped scratch lockfile. The root lockfile includes
  # example importers that intentionally resolve unpublished local-registry
  # @oliphaunt/* packages and should not be fetched by the SDK package check.
  rm -f "$scratch_root/pnpm-lock.yaml"
  mkdir -p "$scratch_root/fixtures"
  mkdir -p "$scratch_root/tools/test"
  rsync -a --delete src/shared/fixtures/ "$scratch_root/fixtures/"
  rsync -a --delete tools/test/ "$scratch_root/tools/test/"
  rsync -a --delete \
    --exclude node_modules \
    --exclude lib \
    --exclude .build \
    --exclude android/.gradle \
    --exclude android/.cxx \
    --exclude android/build \
    --exclude ios/vendor \
    "$source_package_dir/" "$package_dir/"
  rm -rf "$scratch_root/node_modules" "$package_dir/node_modules"
  # PNPM_CONFIG_LOCKFILE=false remains honored by pnpm for callers that need to
  # disable scratch lockfile writes, but the normal path records one.
  run pnpm --dir "$scratch_root" install --no-frozen-lockfile --trust-lockfile
  if [ ! -e "$package_dir/node_modules" ]; then
    ln -s "$scratch_root/node_modules" "$package_dir/node_modules"
  fi
}

node_package_dir() {
  node - "$package_dir" "$1" <<'NODE'
const path = require("node:path");
const { createRequire } = require("node:module");

const packageDir = process.argv[2];
const packageName = process.argv[3];
const requireFromPackage = createRequire(path.join(packageDir, "package.json"));
process.stdout.write(path.dirname(requireFromPackage.resolve(`${packageName}/package.json`)));
NODE
}

require node
require pnpm
export CI="${CI:-1}"
gradle_cmd="gradle"
if [ -x "$root/src/sdks/kotlin/gradlew" ]; then
  gradle_cmd="$root/src/sdks/kotlin/gradlew"
else
  require gradle
fi

if [ "$mode" = "coverage" ]; then
  exec tools/coverage/run-product oliphaunt-react-native
fi

if [ "$mode" = "smoke-runtime" ]; then
  exec pnpm --dir src/sdks/react-native/examples/expo run smoke
fi

case "${OLIPHAUNT_GRADLE_CONFIGURATION_CACHE:-1}" in
  1|true|TRUE|yes|YES)
    gradle_cache_args="--configuration-cache"
    ;;
  0|false|FALSE|no|NO)
    gradle_cache_args=""
    ;;
  *)
    echo "OLIPHAUNT_GRADLE_CONFIGURATION_CACHE must be 0 or 1" >&2
    exit 2
    ;;
esac
case "${OLIPHAUNT_GRADLE_SMOKE_CONFIGURATION_CACHE:-0}" in
  1|true|TRUE|yes|YES)
    gradle_smoke_cache_args="--configuration-cache"
    ;;
  0|false|FALSE|no|NO)
    gradle_smoke_cache_args="--no-configuration-cache"
    ;;
  *)
    echo "OLIPHAUNT_GRADLE_SMOKE_CONFIGURATION_CACHE must be 0 or 1" >&2
    exit 2
    ;;
esac

default_android_abi_filter() {
  machine="$(uname -m 2>/dev/null || true)"
  case "$machine" in
    arm64|aarch64)
      printf '%s\n' arm64-v8a
      ;;
    *)
      printf '%s\n' x86_64
      ;;
  esac
}

normalize_android_abi_filters() {
  raw="$1"
  case "$raw" in
    ""|all|ALL|All)
      return 0
      ;;
    auto|AUTO|Auto)
      default_android_abi_filter
      return 0
      ;;
  esac
  normalized=""
  old_ifs="$IFS"
  IFS=","
  # shellcheck disable=SC2086
  set -- $raw
  IFS="$old_ifs"
  for abi in "$@"; do
    abi="$(printf '%s\n' "$abi" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [ -n "$abi" ] || continue
    case "$abi" in
      arm64-v8a|armeabi-v7a|x86|x86_64)
        case ",$normalized," in
          *",$abi,"*)
            ;;
          *)
            if [ -n "$normalized" ]; then
              normalized="$normalized,$abi"
            else
              normalized="$abi"
            fi
            ;;
        esac
        ;;
      *)
        echo "unsupported OLIPHAUNT_REACT_NATIVE_ANDROID_ABI_FILTERS value: $abi" >&2
        echo "expected comma-separated Android ABIs from: arm64-v8a, armeabi-v7a, x86, x86_64, or all" >&2
        exit 2
        ;;
    esac
  done
  printf '%s\n' "$normalized"
}

android_abi_filters="$(normalize_android_abi_filters "${OLIPHAUNT_REACT_NATIVE_ANDROID_ABI_FILTERS:-${OLIPHAUNT_ANDROID_ABI_FILTERS:-auto}}")"
android_abi_gradle_args=""
if [ -n "$android_abi_filters" ]; then
  android_abi_gradle_args="-PoliphauntAndroidAbiFilters=$android_abi_filters"
fi
android_smoke_abi="${android_abi_filters%%,*}"
if [ -z "$android_smoke_abi" ]; then
  android_smoke_abi="$(default_android_abi_filter)"
fi
gradle_build_root="$scratch_root/gradle/oliphaunt-react-native"
gradle_project_cache="$scratch_root/gradle-cache/oliphaunt-react-native"
gradle_cxx_root="$scratch_root/cxx/oliphaunt-react-native"
node_executable="$(node -p 'process.execPath')"
gradle_scratch_args="-PoliphauntBuildRoot=$gradle_build_root -PoliphauntCxxBuildRoot=$gradle_cxx_root --project-cache-dir $gradle_project_cache -PoliphauntKotlinSdkDir=$root/src/sdks/kotlin/oliphaunt -PnodeExecutable=$node_executable"
android_build_dir="$gradle_build_root/root"
kotlin_build_dir="$gradle_build_root/oliphaunt"

prepare_react_native_package_worktree
if [ "$mode" = "test-unit" ]; then
  run pnpm --dir "$package_dir" test --if-present
  exit 0
fi

run pnpm --dir "$package_dir" run build
if [ "$mode" != "package-shape" ]; then
  run pnpm --dir "$package_dir" run typecheck
fi
require_source_text "$package_dir/package.json" '"react-native": "lib/module/index.js"' \
  "React Native package must expose its compiled module build to Metro instead of raw TypeScript source"
require_source_text "$package_dir/OliphauntReactNative.podspec" 's.dependency "Oliphaunt", native_sdk_version' \
  "React Native iOS package must consume the published Swift SDK pod instead of vendoring Swift sources"
require_source_text "$package_dir/package.json" '"tools/verify-ios-package.mjs"' \
  "React Native package must publish its clean-install iOS payload verifier"
require_source_text "$package_dir/package.json" '"package:verify-ios"' \
  "React Native package must expose its selection-neutral iOS package verification contract"
require_source_text "$package_dir/tools/expo-ios-runner.sh" 'verify_installed_ios_package' \
  "React Native iOS smoke must verify the installed npm package without repairing node_modules"
require_source_text "$package_dir/tools/expo-ios-runner.sh" 'configure_ios_carrier_inputs' \
  "React Native iOS smoke must configure the app-owned checksum-pinned carrier resolver"
if grep -Fq 'install_ios_mobile_assets_into_react_native_package' "$package_dir/tools/expo-ios-runner.sh"; then
  echo "React Native iOS smoke must not mutate an installed npm package to repair missing release payloads" >&2
  exit 1
fi
require_source_text "$package_dir/android/build.gradle" '?: "dev.oliphaunt:oliphaunt-android:${kotlinSdkVersion}"' \
  "React Native Android package must default to the published Kotlin SDK Maven coordinate"
require_source_text "$package_dir/android/build.gradle" 'layout.projectDirectory.dir(".cxx").asFile' \
  "React Native Android CMake staging must default outside Gradle's temporary build directory"
require_source_text "$package_dir/android/build.gradle" 'buildStagingDirectory = cxxBuildRoot' \
  "React Native Android must assign the validated CMake staging directory explicitly"
if grep -Fq 'layout.buildDirectory.get().asFile}/cxx' "$package_dir/android/build.gradle"; then
  echo "React Native Android CMake staging must not default under the temporary build directory" >&2
  exit 1
fi
require_source_text "$package_dir/android/settings.gradle" "if (configuredKotlinSdkDir != null && !configuredKotlinSdkDir.isBlank())" \
  "React Native Android local Kotlin SDK composite builds must be explicit development overrides"
require_source_text "$package_dir/tools/expo-android-runner.sh" "kotlin_sdk_dependency_from_maven_repo" \
  "React Native Android mobile runner must derive the Kotlin SDK dependency from staged Maven artifacts"
require_source_text "$package_dir/src/client.ts" "generatedExtensionBySqlName(trimmed)" \
  "React Native JS boundary must validate selected extensions against the generated extension catalog before crossing the bridge"
require_source_text "$package_dir/src/client.ts" "unknown React Native Oliphaunt extension id" \
  "React Native JS boundary must fail clearly for unknown selected extensions"
if grep -Fq "dev.oliphaunt:oliphaunt-android:0.1.0" "$package_dir/tools/expo-android-runner.sh"; then
  echo "React Native Android mobile runner must not hardcode the Kotlin SDK version" >&2
  exit 1
fi
if [ "$mode" = "release-check" ] || [ "$mode" = "regression" ]; then
  run pnpm --dir "$package_dir" test --if-present
fi
if [ "$mode" != "package-shape" ]; then
  run pnpm --dir "$package_dir" run codegen:check
fi
base64_runtime_hits="$(
  if command -v rg >/dev/null 2>&1; then
    rg -n -i --glob '!**/README.md' --glob '!**/node_modules/**' \
      --glob '!**/__tests__/**' \
      'base64|atob|btoa|Buffer\.from|Buffer\.alloc' \
      "$package_dir/src" \
      "$package_dir/ios" \
      "$package_dir/android/src/main" \
      "$package_dir/OliphauntReactNative.podspec" \
      "$package_dir/react-native.config.js" \
      "$package_dir/package.json" || true
  else
    grep -RInEi \
      --exclude='README.md' \
      --exclude-dir='node_modules' \
      --exclude-dir='__tests__' \
      'base64|atob|btoa|Buffer\.from|Buffer\.alloc' \
      "$package_dir/src" \
      "$package_dir/ios" \
      "$package_dir/android/src/main" \
      "$package_dir/OliphauntReactNative.podspec" \
      "$package_dir/react-native.config.js" \
      "$package_dir/package.json" || true
  fi
)"
if [ -n "$base64_runtime_hits" ]; then
  echo "React Native runtime must not use base64 or Node Buffer binary transport:" >&2
  echo "$base64_runtime_hits" >&2
  exit 1
fi

codegen_binary_hits="$(
  if command -v rg >/dev/null 2>&1; then
    rg -n 'execProtocolRaw|execProtocolStream|backup\(|restore\(' \
      "$package_dir/src/specs/NativeOliphaunt.ts" || true
  else
    grep -nE 'execProtocolRaw|execProtocolStream|backup\(|restore\(' \
      "$package_dir/src/specs/NativeOliphaunt.ts" || true
  fi
)"
if [ -n "$codegen_binary_hits" ]; then
  echo "React Native Codegen spec must stay lifecycle/control-only; binary protocol, backup, and restore bytes belong to the JSI ArrayBuffer transport:" >&2
  echo "$codegen_binary_hits" >&2
  exit 1
fi

for jsi_source in \
  "$package_dir/ios/Oliphaunt.mm" \
  "$package_dir/android/src/main/cpp/OliphauntJsiBindings.cpp"
do
  require_source_text "$jsi_source" "std::isfinite" \
    "React Native JSI numeric arguments must reject non-finite values before native casts"
  require_source_text "$jsi_source" "typed-array byteOffset" \
    "React Native JSI typed-array offsets must be validated before native casts"
  require_source_text "$jsi_source" "typed-array byteLength" \
    "React Native JSI typed-array lengths must be validated before native casts"
  require_source_text "$jsi_source" "positive safe integer" \
    "React Native JSI handles must be validated as positive safe integers before native calls"
done

if [ "$mode" = "check-static" ]; then
  exit 0
fi

if command -v ruby >/dev/null 2>&1; then
  run ruby -c "$package_dir/OliphauntReactNative.podspec"
  run ruby -c "$package_dir/ios/podspecs/COliphaunt.podspec"
  run ruby -c "$package_dir/ios/podspecs/Oliphaunt.podspec"
fi

mkdir -p "$scratch_root"
tmp_pack="$scratch_root/react-native-npm-pack.json"
rm -f "$tmp_pack"
printf '\n==> pnpm --dir %s pack --dry-run --json\n' "$package_dir"
# The source-shape listing does not need lifecycle scripts. The real pack below
# runs the fail-closed verifier and must remain selection-neutral.
PNPM_CONFIG_IGNORE_SCRIPTS=true pnpm --dir "$package_dir" pack --dry-run --json >"$tmp_pack"
cat "$tmp_pack"

for required in \
  "android/settings.gradle" \
  "android/src/main/cpp/CMakeLists.txt" \
  "android/src/main/cpp/include/oliphaunt.h" \
  "android/src/main/cpp/OliphauntJsiBindings.cpp" \
  "android/src/main/java/dev/oliphaunt/reactnative/OliphauntJsiPromiseCallback.kt" \
  "android/src/main/java/dev/oliphaunt/reactnative/OliphauntModule.kt" \
  "android/src/main/java/dev/oliphaunt/reactnative/OliphauntPackage.kt" \
  "ios/Oliphaunt.mm" \
  "ios/OliphauntReactNative.h" \
  "ios/OliphauntAdapter.h" \
  "ios/OliphauntAdapter.swift" \
  "ios/podspecs/COliphaunt.podspec" \
  "ios/podspecs/Oliphaunt.podspec" \
  "tools/stage-ios-app.mjs" \
  "tools/verify-ios-package.mjs" \
  "lib/commonjs/index.js" \
  "lib/commonjs/protocol.js" \
  "lib/module/index.js" \
  "lib/module/protocol.js" \
  "lib/typescript/index.d.ts" \
  "lib/typescript/smoke.d.ts" \
  "src/smoke.ts" \
  "lib/typescript/specs/NativeOliphaunt.d.ts"
do
  if ! grep -Fq "$required" "$tmp_pack"; then
    echo "React Native package dry-run did not include $required" >&2
    rm -f "$tmp_pack"
    exit 1
  fi
done

for removed in \
  "android/CMakeLists.txt" \
  "android/src/main/cpp/oliphaunt_android_bridge.cpp" \
  "android/src/main/java/dev/oliphaunt/reactnative/OliphauntAndroidRuntimeAssets.kt" \
  "android/src/main/java/dev/oliphaunt/reactnative/OliphauntAndroidSession.kt" \
  "android/src/main/java/dev/oliphaunt/reactnative/OliphauntNativeBridge.kt" \
  "ios/Oliphaunt.h" \
  "ios/OliphauntAssets.h" \
  "ios/OliphauntAssets.mm" \
  "ios/vendor/oliphaunt-swift" \
  "ios/vendor/liboliphaunt.xcframework" \
  "Sources/COliphaunt/include/oliphaunt.h" \
  "Sources/Oliphaunt/Oliphaunt.swift" \
  "Sources/Oliphaunt/OliphauntNativeDirect.swift" \
  "liboliphaunt.dylib" \
  "liboliphaunt.xcframework"
do
  if grep -Fq "$removed" "$tmp_pack"; then
    echo "React Native package dry-run still included duplicate Android native runtime file $removed" >&2
    rm -f "$tmp_pack"
    exit 1
  fi
done

if grep -Eq '"path"[[:space:]]*:[[:space:]]*"android/(\.gradle|\.cxx|build|src/test)/' "$tmp_pack"; then
  echo "React Native package dry-run included Android build artifacts or test fixtures" >&2
  rm -f "$tmp_pack"
  exit 1
fi
rm -f "$tmp_pack"

case "$mode" in
  package-shape|release-check|regression)
    require tar
    require zip
    ios_package_fixture="$(prepare_scratch_dir react-native-ios-package-fixture)"
    ios_fixture_package="$ios_package_fixture/package-source"
    ios_fixture_pack="$ios_package_fixture/pack"
    ios_clean_install="$ios_package_fixture/consumer/node_modules/@oliphaunt/react-native"
    mkdir -p "$ios_fixture_package" "$ios_fixture_pack" "$ios_clean_install"
    rsync -a --delete --exclude node_modules "$package_dir/" "$ios_fixture_package/"

    run node "$ios_fixture_package/tools/stage-ios-app.test.mjs"

    run pnpm --dir "$ios_fixture_package" pack --pack-destination "$ios_fixture_pack"
    ios_fixture_tarball="$(find "$ios_fixture_pack" -maxdepth 1 -type f -name '*.tgz' -print -quit)"
    if [ -z "$ios_fixture_tarball" ]; then
      echo "React Native clean-install package test did not produce an npm tarball" >&2
      exit 1
    fi
    run tar -xzf "$ios_fixture_tarball" -C "$ios_clean_install" --strip-components=1
    run node "$ios_clean_install/tools/verify-ios-package.mjs" \
      --package-dir "$ios_clean_install"
    if tar -tzf "$ios_fixture_tarball" | grep -Eq \
      '^package/ios/(resources|frameworks|extension-frameworks|generated)/'; then
      echo "selection-neutral React Native npm tarball contains app-specific iOS payload" >&2
      exit 1
    fi
    ;;
esac

if [ -d "$android_dir/src/main/cpp" ]; then
  unexpected_android_cpp="$(
    find "$android_dir/src/main/cpp" -type f |
      sed "s#^$android_dir/##" |
      grep -Ev '^(src/main/cpp/CMakeLists\.txt|src/main/cpp/OliphauntJsiBindings\.cpp|src/main/cpp/include/oliphaunt\.h)$' || true
  )"
  if [ -n "$unexpected_android_cpp" ]; then
    echo "React Native Android should only carry the JSI installer and must delegate the native runtime to the Kotlin SDK; found:" >&2
    echo "$unexpected_android_cpp" >&2
    exit 1
  fi
fi

if [ -n "${JAVA_HOME:-}" ]; then
  java_home="$JAVA_HOME"
elif command -v /usr/libexec/java_home >/dev/null 2>&1; then
  java_home="$(/usr/libexec/java_home)"
else
  java_home=""
fi

if [ -n "$java_home" ] && [ -f "$java_home/include/jni.h" ]; then
  jni_platform_dir="$(find "$java_home/include" -mindepth 1 -maxdepth 1 -type d | head -n 1 || true)"
  cxx="${CXX:-c++}"
  if command -v xcrun >/dev/null 2>&1; then
    cxx="xcrun clang++"
  elif ! command -v "$cxx" >/dev/null 2>&1; then
    cxx="clang++"
  fi
  # shellcheck disable=SC2086
  run $cxx -fsyntax-only -std=c++17 \
    -I "$java_home/include" \
    ${jni_platform_dir:+-I "$jni_platform_dir"} \
    -I "src/sdks/kotlin/oliphaunt/src/androidMain/cpp/include" \
    "src/sdks/kotlin/oliphaunt/src/androidMain/cpp/oliphaunt_android_bridge.cpp"
else
  echo "warning: skipping Android JNI syntax check because JAVA_HOME/JDK headers are unavailable" >&2
fi

if [ "$mode" = "package-shape" ]; then
  rm -rf "$package_dir/node_modules"
  find "$package_dir" -path "*/node_modules" -prune -exec rm -rf {} +
  exit 0
fi

run_ios_platform_checks=0
case "$mode" in
  build-ios-bridge|release-check|regression)
    run_ios_platform_checks=1
    ;;
esac

ios_platform_checks=0
if [ "$run_ios_platform_checks" = "1" ] &&
  [ "$(uname -s)" = "Darwin" ] &&
  command -v xcrun >/dev/null 2>&1; then
  tmp_swift_adapter="$(prepare_scratch_dir react-native-swift-adapter)"
  mkdir -p "$tmp_swift_adapter/Sources/RNAdapterCheck"
  cp "$package_dir/ios/OliphauntAdapter.swift" \
    "$tmp_swift_adapter/Sources/RNAdapterCheck/OliphauntAdapter.swift"
  cat >"$tmp_swift_adapter/Package.swift" <<SWIFTPACKAGE
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "RNAdapterCheck",
  platforms: [
    .iOS(.v17),
    .macOS(.v14)
  ],
  products: [
    .library(name: "RNAdapterCheck", targets: ["RNAdapterCheck"])
  ],
  dependencies: [
    .package(name: "Oliphaunt", path: "$root/src/sdks/swift")
  ],
  targets: [
    .target(
      name: "RNAdapterCheck",
      dependencies: [
        .product(name: "Oliphaunt", package: "Oliphaunt")
      ]
    )
  ]
)
SWIFTPACKAGE
  tmp_swift_adapter_build="$(prepare_scratch_dir react-native-swift-adapter-build)"
  run swift build --package-path "$tmp_swift_adapter" \
    --scratch-path "$tmp_swift_adapter_build"
  rm -rf "$tmp_swift_adapter"

  rn_headers="$(prepare_scratch_dir react-native-ios-headers)"
  mkdir -p \
    "$rn_headers/FBLazyVector" \
    "$rn_headers/React" \
    "$rn_headers/RCTDeprecation" \
    "$rn_headers/RCTRequired" \
    "$rn_headers/RCTTypeSafety"
  react_native_dir="$(node_package_dir react-native)"
  react_native_codegen_dir="$(node_package_dir @react-native/codegen)"

  find "$react_native_dir/React" -name '*.h' |
    while IFS= read -r header; do
      ln -sf "$header" "$rn_headers/React/$(basename "$header")"
    done
  link_required_header "$rn_headers/RCTDeprecation/RCTDeprecation.h" \
    "$react_native_dir/ReactApple/Libraries/RCTFoundation/RCTDeprecation/Exported/RCTDeprecation.h" \
    "$react_native_dir/ReactCommon/RCTDeprecation/RCTDeprecation.h"
  link_required_header "$rn_headers/FBLazyVector/FBLazyIterator.h" \
    "$react_native_dir/Libraries/FBLazyVector/FBLazyVector/FBLazyIterator.h"
  link_required_header "$rn_headers/FBLazyVector/FBLazyVector.h" \
    "$react_native_dir/Libraries/FBLazyVector/FBLazyVector/FBLazyVector.h"
  link_required_header "$rn_headers/RCTRequired/RCTRequired.h" \
    "$react_native_dir/Libraries/Required/RCTRequired.h"
  link_required_header "$rn_headers/RCTTypeSafety/RCTConvertHelpers.h" \
    "$react_native_dir/Libraries/TypeSafety/RCTConvertHelpers.h"
  link_required_header "$rn_headers/RCTTypeSafety/RCTTypedModuleConstants.h" \
    "$react_native_dir/Libraries/TypeSafety/RCTTypedModuleConstants.h"
  ios_codegen_dir="$(prepare_scratch_dir react-native-ios-codegen)"
  ios_codegen_schema="$ios_codegen_dir/schema.json"
  ios_codegen_output="$ios_codegen_dir/generated"
  run node "$react_native_codegen_dir/lib/cli/combine/combine-js-to-schema-cli.js" \
    "$ios_codegen_schema" \
    "$package_dir/src/specs/NativeOliphaunt.ts"
  run node - "$react_native_dir/scripts/codegen/generate-specs-cli-executor.js" \
    "$ios_codegen_schema" \
    "$ios_codegen_output" <<'NODE'
const generator = require(process.argv[2]);
generator.execute(
  'ios',
  process.argv[3],
  process.argv[4],
  'OliphauntReactNativeSpec',
  'dev.oliphaunt.reactnative',
  'modules'
);
NODE
  sdkroot="$(xcrun --sdk iphonesimulator --show-sdk-path)"
  for objcxx_source in "$package_dir"/ios/*.mm; do
    run xcrun --sdk iphonesimulator clang++ -fsyntax-only -x objective-c++ \
      -std=c++20 -fobjc-arc -mios-simulator-version-min=17.0 \
      -isysroot "$sdkroot" \
      -I "$package_dir/ios" \
      -I "$rn_headers" \
      -I "$react_native_dir/React" \
      -I "$react_native_dir/React/Base" \
      -I "$react_native_dir/ReactCommon" \
      -I "$react_native_dir/ReactCommon/yoga" \
      "$objcxx_source"
    run xcrun --sdk iphonesimulator clang++ -fsyntax-only -x objective-c++ \
      -std=c++20 -fobjc-arc -mios-simulator-version-min=17.0 \
      -DRCT_NEW_ARCH_ENABLED=1 \
      -isysroot "$sdkroot" \
      -I "$package_dir/ios" \
      -I "$rn_headers" \
      -I "$ios_codegen_output" \
      -I "$ios_codegen_output/OliphauntReactNativeSpec" \
      -I "$react_native_dir/React" \
      -I "$react_native_dir/React/Base" \
      -I "$react_native_dir/ReactCommon" \
      -I "$react_native_dir/ReactCommon/callinvoker" \
      -I "$react_native_dir/ReactCommon/jsi" \
      -I "$react_native_dir/ReactCommon/react/nativemodule/core" \
      -I "$react_native_dir/ReactCommon/react/nativemodule/core/platform/ios" \
      -I "$react_native_dir/ReactCommon/yoga" \
      -I "$react_native_dir/Libraries/FBLazyVector" \
      -I "$react_native_dir/Libraries/Required" \
      -I "$react_native_dir/Libraries/TypeSafety" \
      "$objcxx_source"
  done
  ios_platform_checks=1
fi

if [ "$mode" = "build-ios-bridge" ]; then
  if [ "$ios_platform_checks" != "1" ]; then
    echo "React Native iOS platform checks require macOS with Xcode/xcrun" >&2
    exit 1
  fi
  exit 0
fi

run_android_platform_checks=0
case "$mode" in
  build-android-bridge|release-check|regression)
    run_android_platform_checks=1
    ;;
esac

if [ "$run_android_platform_checks" = "1" ]; then
  [ -n "${ANDROID_HOME:-}" ] || {
    echo "React Native Android adapter checks require ANDROID_HOME" >&2
    exit 1
  }
  run "$gradle_cmd" -p "$android_dir" $android_abi_gradle_args $gradle_scratch_args $gradle_cache_args --quiet help
  run "$gradle_cmd" -p "$android_dir" assembleDebug $android_abi_gradle_args $gradle_scratch_args $gradle_cache_args

  tmp_split_runtime="$(prepare_scratch_dir react-native-split-runtime)"
  tmp_split_template="$(prepare_scratch_dir react-native-split-template)"
  mkdir -p \
    "$tmp_split_runtime/share/postgresql/extension" \
    "$tmp_split_runtime/lib/postgresql" \
    "$tmp_split_template/base"
  printf 'runtime split smoke\n' >"$tmp_split_runtime/share/postgresql/README.liboliphaunt-split-smoke"
  printf "comment = 'vector split smoke control'\n" >"$tmp_split_runtime/share/postgresql/extension/vector.control"
  printf "select 'vector split smoke sql';\n" >"$tmp_split_runtime/share/postgresql/extension/vector--1.0.sql"
  printf "comment = 'cube split smoke control'\n" >"$tmp_split_runtime/share/postgresql/extension/cube.control"
  printf "select 'cube split smoke sql';\n" >"$tmp_split_runtime/share/postgresql/extension/cube--1.0.sql"
  printf "comment = 'earthdistance split smoke control'\n" >"$tmp_split_runtime/share/postgresql/extension/earthdistance.control"
  printf "select 'earthdistance split smoke sql';\n" >"$tmp_split_runtime/share/postgresql/extension/earthdistance--1.0.sql"
  printf '18\n' >"$tmp_split_template/PG_VERSION"
  printf 'template split smoke\n' >"$tmp_split_template/base/README.liboliphaunt-split-smoke"
  run "$gradle_cmd" -p "$android_dir" prepareOliphauntAndroidAssets \
    "-PoliphauntRuntimeDir=$tmp_split_runtime" \
    "-PoliphauntTemplatePgdataDir=$tmp_split_template" \
    "-PoliphauntExtensions=vector" \
    $gradle_scratch_args \
    $gradle_smoke_cache_args
  generated_assets="$android_build_dir/generated/liboliphaunt-assets"
  split_runtime_manifest="$generated_assets/oliphaunt/runtime/manifest.properties"
  split_template_manifest="$generated_assets/oliphaunt/template-pgdata/manifest.properties"
  require_manifest_line "$split_runtime_manifest" "schema=oliphaunt-runtime-resources-v1" \
    "React Native Android split runtime manifest did not emit the shared runtime-resources schema"
  require_manifest_line "$split_runtime_manifest" "layout=postgres-runtime-files-v1" \
    "React Native Android split runtime manifest did not emit the runtime resources layout"
  require_manifest_line "$split_runtime_manifest" "extensions=vector" \
    "React Native Android split runtime manifest did not record selected vector extension"
  require_manifest_line "$split_runtime_manifest" "runtimeFeatures=" \
    "React Native Android split runtime manifest did not record runtime feature metadata"
  require_manifest_line "$split_runtime_manifest" "sharedPreloadLibraries=" \
    "React Native Android split runtime manifest did not record shared preload libraries"
  require_manifest_line "$split_runtime_manifest" "mobileStaticRegistryState=pending" \
    "React Native Android split runtime manifest did not mark mobile static registry as pending"
  require_manifest_line "$split_runtime_manifest" "mobileStaticRegistryRegistered=" \
    "React Native Android split runtime manifest should not claim registered mobile static modules"
  require_manifest_line "$split_runtime_manifest" "mobileStaticRegistryPending=vector" \
    "React Native Android split runtime manifest did not record pending mobile static registry modules"
  require_manifest_line "$split_runtime_manifest" "nativeModuleStems=vector" \
    "React Native Android split runtime manifest did not record expected native module stems"
  require_manifest_line "$split_runtime_manifest" "mobileStaticRegistrySource=" \
    "React Native Android split runtime manifest should not claim generated mobile static-registry source"
  require_manifest_line "$split_template_manifest" "mobileStaticRegistryState=not-required" \
    "React Native Android split template manifest should not require mobile static registry work"
  require_manifest_line "$split_template_manifest" "mobileStaticRegistryPending=" \
    "React Native Android split template manifest should not list pending mobile static registry modules"
  require_manifest_line "$split_template_manifest" "runtimeFeatures=" \
    "React Native Android split template manifest should not list runtime features"
  require_manifest_line "$split_template_manifest" "sharedPreloadLibraries=" \
    "React Native Android split template manifest should not list shared preload libraries"
  require_manifest_line "$split_template_manifest" "nativeModuleStems=" \
    "React Native Android split template manifest should not list native module stems"
  require_manifest_line "$split_template_manifest" "mobileStaticRegistrySource=" \
    "React Native Android split template manifest should not claim generated mobile static-registry source"

  tmp_split_incomplete_runtime="$(prepare_scratch_dir react-native-split-incomplete-extension)"
  mkdir -p "$tmp_split_incomplete_runtime/share/postgresql/extension"
  printf 'runtime split incomplete smoke\n' >"$tmp_split_incomplete_runtime/share/postgresql/README.liboliphaunt-split-incomplete-smoke"
  printf "comment = 'vector split incomplete control'\n" >"$tmp_split_incomplete_runtime/share/postgresql/extension/vector.control"
  split_incomplete_extension_log="$scratch_root/react-native-split-incomplete-extension.log"
  rm -f "$split_incomplete_extension_log"
  printf '\n==> %s\n' "$gradle_cmd -p $android_dir prepareOliphauntAndroidAssets -PoliphauntExtensions=vector"
  if "$gradle_cmd" -p "$android_dir" prepareOliphauntAndroidAssets \
    "-PoliphauntRuntimeDir=$tmp_split_incomplete_runtime" \
    "-PoliphauntTemplatePgdataDir=$tmp_split_template" \
    "-PoliphauntExtensions=vector" \
    $gradle_scratch_args \
    $gradle_smoke_cache_args >"$split_incomplete_extension_log" 2>&1; then
    echo "React Native Android split runtime packaging accepted a selected extension without packaged SQL files" >&2
    cat "$split_incomplete_extension_log" >&2
    rm -f "$split_incomplete_extension_log"
    exit 1
  fi
  if ! grep -Fq "selected extension 'vector' has no packaged SQL files" "$split_incomplete_extension_log"; then
    echo "React Native Android split runtime packaging failed without the expected selected-extension file diagnostic" >&2
    cat "$split_incomplete_extension_log" >&2
    rm -f "$split_incomplete_extension_log"
    exit 1
  fi
  rm -f "$split_incomplete_extension_log"
  rm -rf "$tmp_split_incomplete_runtime"

  split_static_log="$scratch_root/react-native-split-static.log"
  rm -f "$split_static_log"
  printf '\n==> %s\n' "$gradle_cmd -p $android_dir prepareOliphauntAndroidAssets -PoliphauntMobileStaticModules=vector"
  if "$gradle_cmd" -p "$android_dir" prepareOliphauntAndroidAssets \
    "-PoliphauntRuntimeDir=$tmp_split_runtime" \
    "-PoliphauntTemplatePgdataDir=$tmp_split_template" \
    "-PoliphauntExtensions=vector" \
    "-PoliphauntMobileStaticModules=vector" \
    $gradle_scratch_args \
    $gradle_smoke_cache_args >"$split_static_log" 2>&1; then
    echo "React Native Android split runtime packaging accepted a mobile static module declaration without generated registry source" >&2
    cat "$split_static_log" >&2
    rm -f "$split_static_log"
    exit 1
  fi
  if ! grep -Fq "split runtime packaging cannot declare mobile static module stems" "$split_static_log"; then
    echo "React Native Android split runtime packaging failed without the expected static-registry diagnostic" >&2
    cat "$split_static_log" >&2
    rm -f "$split_static_log"
    exit 1
  fi
  rm -f "$split_static_log"

  run "$gradle_cmd" -p "$android_dir" prepareOliphauntAndroidAssets \
    "-PoliphauntRuntimeDir=$tmp_split_runtime" \
    "-PoliphauntTemplatePgdataDir=$tmp_split_template" \
    "-PoliphauntExtensions=earthdistance" \
    $gradle_scratch_args \
    $gradle_smoke_cache_args
  require_manifest_line "$split_runtime_manifest" "extensions=cube,earthdistance" \
    "React Native Android split runtime manifest did not include exact extension dependencies"
  require_manifest_line "$split_runtime_manifest" "sharedPreloadLibraries=" \
    "React Native Android split runtime manifest should not record shared preload libraries for earthdistance"
  require_manifest_line "$split_runtime_manifest" "mobileStaticRegistryPending=cube,earthdistance" \
    "React Native Android split runtime manifest did not map earthdistance mobile pending extensions"
  require_manifest_line "$split_runtime_manifest" "nativeModuleStems=cube,earthdistance" \
    "React Native Android split runtime manifest did not map earthdistance native module stems"

  split_unknown_extension_log="$scratch_root/react-native-split-unknown-extension.log"
  rm -f "$split_unknown_extension_log"
  printf '\n==> %s\n' "$gradle_cmd -p $android_dir prepareOliphauntAndroidAssets -PoliphauntExtensions=acme_unknown"
  if "$gradle_cmd" -p "$android_dir" prepareOliphauntAndroidAssets \
    "-PoliphauntRuntimeDir=$tmp_split_runtime" \
    "-PoliphauntTemplatePgdataDir=$tmp_split_template" \
    "-PoliphauntExtensions=acme_unknown" \
    $gradle_scratch_args \
    $gradle_smoke_cache_args >"$split_unknown_extension_log" 2>&1; then
    echo "React Native Android split runtime packaging accepted an extension absent from generated metadata" >&2
    cat "$split_unknown_extension_log" >&2
    rm -f "$split_unknown_extension_log"
    exit 1
  fi
  if ! grep -Fq "cannot select unknown extension 'acme_unknown'" "$split_unknown_extension_log"; then
    echo "React Native Android split runtime packaging failed without the expected unknown-extension diagnostic" >&2
    cat "$split_unknown_extension_log" >&2
    rm -f "$split_unknown_extension_log"
    exit 1
  fi
  rm -f "$split_unknown_extension_log"
  rm -rf "$tmp_split_runtime" "$tmp_split_template"

  tmp_assets="$(prepare_scratch_dir react-native-runtime-resources)"
  tmp_static_jni="$(prepare_scratch_dir react-native-static-jni)"
  mkdir -p \
    "$tmp_assets/oliphaunt/runtime/files/share/postgresql/extension" \
    "$tmp_assets/oliphaunt/runtime/files/lib/postgresql" \
    "$tmp_assets/oliphaunt/static-registry" \
    "$tmp_assets/oliphaunt/template-pgdata/files/base"
  printf '18\n' >"$tmp_assets/oliphaunt/template-pgdata/files/PG_VERSION"
  printf 'runtime smoke\n' >"$tmp_assets/oliphaunt/runtime/files/share/postgresql/README.liboliphaunt-smoke"
  printf "comment = 'vector smoke control'\n" >"$tmp_assets/oliphaunt/runtime/files/share/postgresql/extension/vector.control"
  printf "select 'vector smoke sql';\n" >"$tmp_assets/oliphaunt/runtime/files/share/postgresql/extension/vector--1.0.sql"
  printf '/* static registry smoke */\n' >"$tmp_assets/oliphaunt/static-registry/oliphaunt_static_registry.c"
  cat >"$tmp_assets/oliphaunt/static-registry/manifest.properties" <<MANIFEST
packageLayout=oliphaunt-static-registry-v1
abiVersion=1
state=complete
source=oliphaunt_static_registry.c
registeredExtensions=vector
pendingExtensions=
nativeModuleStems=vector
modules=vector
archiveTargets=$android_smoke_abi
module.vector.extension=vector
module.vector.symbolPrefix=vector
module.vector.sqlSymbols=
module.vector.archiveTargets=$android_smoke_abi
module.vector.archive.$android_smoke_abi=archives/$android_smoke_abi/extensions/vector/liboliphaunt_extension_vector.a
MANIFEST
  oliphaunt_android_create_static_extension_smoke_artifacts \
    "$scratch_root" \
    "$android_smoke_abi" \
    "$tmp_assets" \
    "$tmp_static_jni" \
    vector
  printf 'template smoke\n' >"$tmp_assets/oliphaunt/template-pgdata/files/base/README.liboliphaunt-smoke"
  cat >"$tmp_assets/oliphaunt/runtime/manifest.properties" <<'MANIFEST'
schema=oliphaunt-runtime-resources-v1
cacheKey=runtime-smoke
layout=postgres-runtime-files-v1
extensions=vector
runtimeFeatures=
sharedPreloadLibraries=
mobileStaticRegistryState=complete
mobileStaticRegistryRegistered=vector
mobileStaticRegistryPending=
nativeModuleStems=vector
mobileStaticRegistrySource=static-registry/oliphaunt_static_registry.c
MANIFEST
  cat >"$tmp_assets/oliphaunt/template-pgdata/manifest.properties" <<'MANIFEST'
schema=oliphaunt-runtime-resources-v1
cacheKey=template-smoke
layout=postgres-template-pgdata-v1
extensions=
runtimeFeatures=
sharedPreloadLibraries=
mobileStaticRegistryState=not-required
mobileStaticRegistryRegistered=
mobileStaticRegistryPending=
nativeModuleStems=
mobileStaticRegistrySource=
MANIFEST
  cat >"$tmp_assets/oliphaunt/package-size.tsv" <<'REPORT'
kind	id	extensions	files	bytes
package	total	-	-	185
package	runtime	-	-	100
package	template-pgdata	-	-	40
package	static-registry	-	-	45
extensions	selected	-	-	30
extension	vector	-	3	30
REPORT
  tmp_assets_incomplete="$(prepare_scratch_dir react-native-runtime-resources-incomplete-extension)"
  cp -R "$tmp_assets/." "$tmp_assets_incomplete/"
  rm -f "$tmp_assets_incomplete/oliphaunt/runtime/files/share/postgresql/extension/vector--1.0.sql"
  runtime_resources_incomplete_log="$scratch_root/react-native-runtime-resources-incomplete-extension.log"
  rm -f "$runtime_resources_incomplete_log"
  printf '\n==> %s\n' "$gradle_cmd -p $android_dir prepareOliphauntAndroidAssets -PoliphauntRuntimeResourcesDir=<incomplete> -PoliphauntExtensions=vector"
  if "$gradle_cmd" -p "$android_dir" prepareOliphauntAndroidAssets \
    "-PoliphauntRuntimeResourcesDir=$tmp_assets_incomplete" \
    "-PoliphauntExtensions=vector" \
    $gradle_scratch_args \
    $gradle_smoke_cache_args >"$runtime_resources_incomplete_log" 2>&1; then
    echo "React Native Android prebuilt runtime resources accepted a selected extension without packaged SQL files" >&2
    cat "$runtime_resources_incomplete_log" >&2
    rm -f "$runtime_resources_incomplete_log"
    rm -rf "$tmp_assets_incomplete"
    exit 1
  fi
  if ! grep -Fq "selected extension 'vector' has no packaged SQL files" "$runtime_resources_incomplete_log"; then
    echo "React Native Android prebuilt runtime resources failed without the expected selected-extension file diagnostic" >&2
    cat "$runtime_resources_incomplete_log" >&2
    rm -f "$runtime_resources_incomplete_log"
    rm -rf "$tmp_assets_incomplete"
    exit 1
  fi
  rm -f "$runtime_resources_incomplete_log"
  rm -rf "$tmp_assets_incomplete"

  android_link_evidence="$scratch_root/android-static-extension-link-$android_smoke_abi-$$.tsv"
  rm -f "$android_link_evidence"
  run "$gradle_cmd" -p "$android_dir" assembleDebug \
    "-PoliphauntRuntimeResourcesDir=$tmp_assets" \
    "-PoliphauntAndroidJniLibsDir=$tmp_static_jni" \
    "-PoliphauntAndroidAbiFilters=$android_smoke_abi" \
    "-PoliphauntReactNativePackageRuntime=true" \
    "-PoliphauntAndroidLinkEvidenceFile=$android_link_evidence" \
    $gradle_scratch_args \
    $gradle_smoke_cache_args
  require_manifest_line "$android_link_evidence" "schema	oliphaunt-android-static-extension-link-v1" \
    "Android static extension link evidence did not record schema"
  require_manifest_line "$android_link_evidence" "abi	$android_smoke_abi" \
    "Android static extension link evidence did not record ABI"
  if ! grep -Fq "extension	vector	" "$android_link_evidence"; then
    echo "Android static extension link evidence did not record selected vector extension" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  if ! grep -Fq "liboliphaunt_extension_vector.a" "$android_link_evidence"; then
    echo "Android static extension link evidence did not record selected vector archive" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  aar="$android_build_dir/outputs/aar/android-debug.aar"
  kotlin_aar="$kotlin_build_dir/outputs/aar/oliphaunt-debug.aar"
  asset_aar="$aar"
  if [ -f "$kotlin_aar" ] &&
    jar tf "$kotlin_aar" | grep -Fxq "assets/oliphaunt/runtime/manifest.properties"; then
    asset_aar="$kotlin_aar"
  fi
  for required_asset in \
    "assets/oliphaunt/runtime/manifest.properties" \
    "assets/oliphaunt/runtime/files/share/postgresql/README.liboliphaunt-smoke" \
    "assets/oliphaunt/runtime/files/share/postgresql/extension/vector.control" \
    "assets/oliphaunt/runtime/files/share/postgresql/extension/vector--1.0.sql" \
    "assets/oliphaunt/package-size.tsv" \
    "assets/oliphaunt/static-registry/oliphaunt_static_registry.c" \
    "assets/oliphaunt/static-registry/manifest.properties" \
    "assets/oliphaunt/template-pgdata/manifest.properties" \
    "assets/oliphaunt/template-pgdata/files/PG_VERSION"
  do
    if ! jar tf "$asset_aar" | grep -Fxq "$required_asset"; then
      echo "Android AAR did not include generated asset $required_asset" >&2
      rm -rf "$tmp_assets" "$tmp_static_jni"
      exit 1
    fi
  done
  if jar tf "$asset_aar" | grep -Fxq "assets/oliphaunt/runtime/files/share/postgresql/extension/hstore.control"; then
    echo "Android AAR included unselected hstore extension control file" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  if jar tf "$asset_aar" | grep -Fq "assets/oliphaunt/static-registry/archives/"; then
    echo "Android AAR included build-only static extension archives" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  tmp_aar_extract="$tmp_assets/aar"
  mkdir -p "$tmp_aar_extract"
  (cd "$tmp_aar_extract" && jar xf "$asset_aar" assets/oliphaunt/runtime/manifest.properties assets/oliphaunt/package-size.tsv)
  if ! grep -Fxq "schema=oliphaunt-runtime-resources-v1" "$tmp_aar_extract/assets/oliphaunt/runtime/manifest.properties"; then
    echo "Android AAR runtime manifest did not preserve runtime-resources layout schema" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  if ! grep -Fxq "layout=postgres-runtime-files-v1" "$tmp_aar_extract/assets/oliphaunt/runtime/manifest.properties"; then
    echo "Android AAR runtime manifest did not preserve runtime resources layout" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  if ! grep -Fxq "extensions=vector" "$tmp_aar_extract/assets/oliphaunt/runtime/manifest.properties"; then
    echo "Android AAR runtime manifest did not record selected extensions" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  if ! grep -Fxq "mobileStaticRegistryState=complete" "$tmp_aar_extract/assets/oliphaunt/runtime/manifest.properties"; then
    echo "Android AAR runtime manifest did not preserve mobile static-registry state" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  if ! grep -Fxq "sharedPreloadLibraries=" "$tmp_aar_extract/assets/oliphaunt/runtime/manifest.properties"; then
    echo "Android AAR runtime manifest did not preserve shared preload metadata" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  if ! grep -Fxq "runtimeFeatures=" "$tmp_aar_extract/assets/oliphaunt/runtime/manifest.properties"; then
    echo "Android AAR runtime manifest did not preserve runtime feature metadata" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  if ! grep -Fxq "mobileStaticRegistrySource=static-registry/oliphaunt_static_registry.c" "$tmp_aar_extract/assets/oliphaunt/runtime/manifest.properties"; then
    echo "Android AAR runtime manifest did not preserve mobile static-registry source" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  if ! grep -Fxq "extension	vector	-	3	30" "$tmp_aar_extract/assets/oliphaunt/package-size.tsv"; then
    echo "Android AAR did not preserve runtime-resources size report" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  rm -rf "$tmp_assets" "$tmp_static_jni"

  tmp_jni="$(prepare_scratch_dir react-native-jni)"
  mkdir -p "$tmp_jni/jniLibs/arm64-v8a"
  printf 'not-a-real-android-elf-for-packaging-smoke\n' >"$tmp_jni/jniLibs/arm64-v8a/liboliphaunt.so"
  run "$gradle_cmd" -p "$android_dir" prepareOliphauntAndroidJniLibs \
    "-PoliphauntAndroidJniLibsDir=$tmp_jni" \
    $gradle_scratch_args \
    $gradle_smoke_cache_args
  generated_jni="$android_build_dir/generated/liboliphaunt-jniLibs"
  if [ ! -f "$generated_jni/arm64-v8a/liboliphaunt.so" ]; then
    echo "React Native Android generated JNI libs did not include packaged liboliphaunt.so" >&2
    rm -rf "$tmp_jni"
    exit 1
  fi
  rm -rf "$tmp_jni"

  # Android Lint can report a Kotlin analyzer/compiler mismatch while returning
  # success, so retain and inspect its combined output before accepting the run.
  # shellcheck disable=SC2086
  run sh "$root/tools/policy/run-gradle-lint-checked.sh" "$scratch_root/android-lint.log" -- \
    "$gradle_cmd" -p "$android_dir" \
    testDebugUnitTest \
    lintAnalyzeDebug --rerun \
    lintAnalyzeDebugUnitTest --rerun \
    lintAnalyzeDebugAndroidTest --rerun \
    lintDebug \
    $android_abi_gradle_args \
    $gradle_scratch_args \
    $gradle_cache_args
fi

if [ "$mode" = "build-android-bridge" ]; then
  exit 0
fi
