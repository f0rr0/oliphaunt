#!/usr/bin/env sh
set -eu

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

. "$root/src/sdks/react-native/tools/android-smoke-artifacts.sh"
. "$root/tools/runtime/preflight.sh"

project_dir="src/sdks/kotlin"
scratch_root_base="${OLIPHAUNT_SDK_CHECK_SCRATCH:-$root/target/liboliphaunt-sdk-check/oliphaunt-kotlin}"
mode="${1:-release-check}"

case "$mode" in
  check-static|test-unit|package-shape|smoke-runtime|regression|coverage|release-check)
    ;;
  "")
    mode="release-check"
    ;;
  *)
    echo "usage: src/sdks/kotlin/tools/check-sdk.sh [check-static|test-unit|package-shape|smoke-runtime|regression|coverage|release-check]" >&2
    exit 2
    ;;
esac

scratch_root="$scratch_root_base/$mode"

if [ -z "${ANDROID_HOME:-}" ] && [ -d "$HOME/Library/Android/sdk" ]; then
  export ANDROID_HOME="$HOME/Library/Android/sdk"
fi
if [ -n "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ]; then
  export ANDROID_SDK_ROOT="$ANDROID_HOME"
fi

run() {
  printf '\n==> %s\n' "$*"
  "$@"
}

if [ "$mode" = "coverage" ]; then
  exec tools/coverage/run-product oliphaunt-kotlin
fi

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

require jar

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

require_jar_entry() {
  jar_file="$1"
  entry="$2"
  message="$3"
  if [ ! -f "$jar_file" ]; then
    echo "missing Kotlin package artifact: $jar_file" >&2
    exit 1
  fi
  if ! jar tf "$jar_file" | grep -Fxq "$entry"; then
    echo "$message" >&2
    echo "expected $entry in $jar_file" >&2
    exit 1
  fi
}

require_jar_entry_pattern() {
  jar_file="$1"
  pattern="$2"
  message="$3"
  if [ ! -f "$jar_file" ]; then
    echo "missing Kotlin package artifact: $jar_file" >&2
    exit 1
  fi
  if ! jar tf "$jar_file" | grep -Eq "$pattern"; then
    echo "$message" >&2
    echo "expected pattern $pattern in $jar_file" >&2
    exit 1
  fi
}

kotlin_package_version() {
  version="$(sed -n 's/^VERSION_NAME=//p' "$project_dir/gradle.properties" | tail -n 1)"
  if [ -z "$version" ]; then
    echo "missing VERSION_NAME in $project_dir/gradle.properties" >&2
    exit 1
  fi
  printf '%s\n' "$version"
}

reject_jar_entry_pattern() {
  jar_file="$1"
  pattern="$2"
  message="$3"
  if [ ! -f "$jar_file" ]; then
    echo "missing Kotlin package artifact: $jar_file" >&2
    exit 1
  fi
  if jar tf "$jar_file" | grep -Eq "$pattern"; then
    echo "$message" >&2
    echo "unexpected pattern $pattern in $jar_file" >&2
    exit 1
  fi
}

prepare_scratch_dir() {
  dir="$scratch_root/$1"
  rm -rf "$dir"
  mkdir -p "$dir"
  printf '%s\n' "$dir"
}

gradle_cmd="gradle"
if [ -x "$project_dir/gradlew" ]; then
  gradle_cmd="$root/$project_dir/gradlew"
else
  require gradle
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
        echo "unsupported OLIPHAUNT_KOTLIN_ANDROID_ABI_FILTERS value: $abi" >&2
        echo "expected comma-separated Android ABIs from: arm64-v8a, armeabi-v7a, x86, x86_64, or all" >&2
        exit 2
        ;;
    esac
  done
  printf '%s\n' "$normalized"
}

android_abi_filters="$(normalize_android_abi_filters "${OLIPHAUNT_KOTLIN_ANDROID_ABI_FILTERS:-${OLIPHAUNT_ANDROID_ABI_FILTERS:-auto}}")"
android_abi_gradle_args=""
if [ -n "$android_abi_filters" ]; then
  android_abi_gradle_args="-PoliphauntAndroidAbiFilters=$android_abi_filters"
fi
android_smoke_abi="${android_abi_filters%%,*}"
if [ -z "$android_smoke_abi" ]; then
  android_smoke_abi="$(default_android_abi_filter)"
fi
gradle_build_root="$scratch_root/gradle/oliphaunt-kotlin"
gradle_project_cache="$scratch_root/gradle-cache/oliphaunt-kotlin"
gradle_cxx_root="$scratch_root/cxx/oliphaunt-kotlin"
gradle_project_cache_source_stamp="$scratch_root/gradle-cache/project-source-root"
expected_gradle_project_source="$root/$project_dir"
if [ -d "$gradle_project_cache" ]; then
  if [ ! -f "$gradle_project_cache_source_stamp" ] ||
    [ "$(cat "$gradle_project_cache_source_stamp")" != "$expected_gradle_project_source" ]; then
    rm -rf "$gradle_project_cache"
  fi
fi
mkdir -p "$(dirname "$gradle_project_cache_source_stamp")"
printf '%s\n' "$expected_gradle_project_source" >"$gradle_project_cache_source_stamp"
gradle_scratch_args="-PoliphauntBuildRoot=$gradle_build_root -PoliphauntCxxBuildRoot=$gradle_cxx_root --project-cache-dir $gradle_project_cache"
gradle_non_coverage_args="-x :oliphaunt:koverVerify"
kotlin_build_dir="$gradle_build_root/oliphaunt"

host_native_suffix() {
  case "$(uname -s):$(uname -m)" in
    Darwin:*)
      printf '%s\n' MacosArm64
      ;;
    Linux:arm64|Linux:aarch64)
      printf '%s\n' LinuxArm64
      ;;
    *)
      printf '%s\n' LinuxX64
      ;;
  esac
}

host_native_compile_task() {
  printf ':oliphaunt:compileKotlin%s\n' "$(host_native_suffix)"
}

host_native_test_task() {
  first="$(host_native_suffix | cut -c1 | tr '[:upper:]' '[:lower:]')"
  rest="$(host_native_suffix | cut -c2-)"
  printf ':oliphaunt:%s%sTest\n' "$first" "$rest"
}

run_without_linked_native_runtime() {
  env \
    -u LIBOLIPHAUNT_PATH \
    -u OLIPHAUNT_INSTALL_DIR \
    -u OLIPHAUNT_RUNTIME_DIR \
    -u OLIPHAUNT_KOTLIN_REQUIRE_NATIVE \
    "$@"
}

run_android_runtime_smoke() {
  if [ -z "${ANDROID_HOME:-}" ]; then
    echo "Kotlin Android smoke requires ANDROID_HOME" >&2
    exit 1
  fi

  tmp_assets="$(prepare_scratch_dir kotlin-runtime-resources)"
  tmp_static_jni="$(prepare_scratch_dir kotlin-static-jni)"
  mkdir -p \
    "$tmp_assets/oliphaunt/runtime/files/share/postgresql/extension" \
    "$tmp_assets/oliphaunt/static-registry" \
    "$tmp_assets/oliphaunt/template-pgdata/files/base"
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
  printf '18\n' >"$tmp_assets/oliphaunt/template-pgdata/files/PG_VERSION"
  printf 'template smoke\n' >"$tmp_assets/oliphaunt/template-pgdata/files/base/README.liboliphaunt-smoke"
  cat >"$tmp_assets/oliphaunt/runtime/manifest.properties" <<'MANIFEST'
schema=oliphaunt-runtime-resources-v1
cacheKey=runtime-smoke
layout=postgres-runtime-files-v1
extensions=vector
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

  run "$gradle_cmd" -p "$project_dir" :oliphaunt:prepareOliphauntAndroidAssets \
    "-PoliphauntRuntimeResourcesDir=$tmp_assets" \
    $gradle_scratch_args \
    $gradle_smoke_cache_args
  generated="$kotlin_build_dir/generated/oliphaunt-android-assets"
  if [ ! -f "$generated/oliphaunt/runtime/files/share/postgresql/README.liboliphaunt-smoke" ]; then
    echo "Kotlin Android generated assets did not include runtime-resources runtime files" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  if [ ! -f "$generated/oliphaunt/runtime/files/share/postgresql/extension/vector.control" ]; then
    echo "Kotlin Android generated assets did not include selected vector extension control file" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  if [ -e "$generated/oliphaunt/runtime/files/share/postgresql/extension/hstore.control" ]; then
    echo "Kotlin Android generated assets included unselected hstore extension control file" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  if [ ! -f "$generated/oliphaunt/template-pgdata/files/PG_VERSION" ]; then
    echo "Kotlin Android generated assets did not include runtime-resources template PGDATA" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  if [ ! -f "$generated/oliphaunt/static-registry/oliphaunt_static_registry.c" ]; then
    echo "Kotlin Android generated assets did not include runtime-resources static registry source" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  if [ -e "$generated/oliphaunt/static-registry/archives" ]; then
    echo "Kotlin Android generated assets included build-only static extension archives" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  if ! grep -Fxq "extension	vector	-	3	30" "$generated/oliphaunt/package-size.tsv"; then
    echo "Kotlin Android generated assets did not preserve runtime-resources size report" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  if ! grep -Fxq "extensions=vector" "$generated/oliphaunt/runtime/manifest.properties"; then
    echo "Kotlin Android generated runtime manifest did not preserve runtime-resources extensions" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  if ! grep -Fxq "schema=oliphaunt-runtime-resources-v1" "$generated/oliphaunt/runtime/manifest.properties"; then
    echo "Kotlin Android generated runtime manifest did not preserve runtime-resources layout schema" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  if ! grep -Fxq "layout=postgres-runtime-files-v1" "$generated/oliphaunt/runtime/manifest.properties"; then
    echo "Kotlin Android generated runtime manifest did not preserve runtime resources layout" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  if ! grep -Fxq "mobileStaticRegistryState=complete" "$generated/oliphaunt/runtime/manifest.properties"; then
    echo "Kotlin Android generated runtime manifest did not preserve mobile static-registry state" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  if ! grep -Fxq "sharedPreloadLibraries=" "$generated/oliphaunt/runtime/manifest.properties"; then
    echo "Kotlin Android generated runtime manifest did not preserve shared preload metadata" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  if ! grep -Fxq "mobileStaticRegistrySource=static-registry/oliphaunt_static_registry.c" "$generated/oliphaunt/runtime/manifest.properties"; then
    echo "Kotlin Android generated runtime manifest did not preserve mobile static-registry source" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  run "$gradle_cmd" -p "$project_dir" :oliphaunt:bundleDebugAar \
    "-PoliphauntRuntimeResourcesDir=$tmp_assets" \
    "-PoliphauntAndroidJniLibsDir=$tmp_static_jni" \
    "-PoliphauntAndroidAbiFilters=$android_smoke_abi" \
    $gradle_scratch_args \
    $gradle_smoke_cache_args
  static_asset_aar="$kotlin_build_dir/outputs/aar/oliphaunt-debug.aar"
  require_jar_entry "$static_asset_aar" "jni/$android_smoke_abi/liboliphaunt.so" \
    "Kotlin Android smoke AAR must include the explicitly supplied liboliphaunt runtime for $android_smoke_abi"
  if jar tf "$static_asset_aar" | grep -Fq "assets/oliphaunt/static-registry/archives/"; then
    echo "Kotlin Android AAR included build-only static extension archives" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  rm -rf "$tmp_assets" "$tmp_static_jni"
}

oliphaunt_runtime_native_host_export_defaults

if [ -n "${OLIPHAUNT_KOTLIN_REQUIRE_NATIVE:-}" ]; then
  if ! oliphaunt_runtime_native_host_ready basic; then
    oliphaunt_runtime_native_host_diagnostics basic
    exit 1
  fi
fi

if [ "$mode" = "smoke-runtime" ]; then
  run_android_runtime_smoke
  exit 0
fi

if [ "$mode" = "check-static" ]; then
  static_tasks=":oliphaunt:spotlessCheck :oliphaunt:detekt :oliphaunt:compileKotlinJvm :oliphaunt:compileDebugKotlinAndroid :oliphaunt:compileReleaseKotlinAndroid :oliphaunt-android-gradle-plugin:check $(host_native_compile_task)"
  if [ -n "${ANDROID_HOME:-}" ]; then
    static_tasks="$static_tasks :oliphaunt:lintDebug"
  fi
  # shellcheck disable=SC2086
  run "$gradle_cmd" -p "$project_dir" \
    $static_tasks \
    $android_abi_gradle_args \
    $gradle_scratch_args \
    $gradle_cache_args
  exit 0
fi

if [ "$mode" = "test-unit" ]; then
  unit_tasks=":oliphaunt:jvmTest :oliphaunt:testDebugUnitTest :oliphaunt:testReleaseUnitTest $(host_native_test_task)"
  # shellcheck disable=SC2086
  run run_without_linked_native_runtime "$gradle_cmd" -p "$project_dir" \
    $unit_tasks \
    $gradle_non_coverage_args \
    $android_abi_gradle_args \
    $gradle_scratch_args \
    $gradle_cache_args
  exit 0
fi

if [ "$mode" = "regression" ] || [ "$mode" = "release-check" ]; then
  # Kover verification is owned by tools/coverage/run-product. Static/unit/package
  # SDK checks should still compile and run tests, but must not enforce measured
  # coverage thresholds as a side effect of Gradle's aggregate `check` task.
  # shellcheck disable=SC2086
  run "$gradle_cmd" -p "$project_dir" check $gradle_non_coverage_args $android_abi_gradle_args $gradle_scratch_args $gradle_cache_args
  if [ "$mode" = "regression" ]; then
    exit 0
  fi
fi

run cmp src/runtimes/liboliphaunt/native/include/oliphaunt.h "$project_dir/oliphaunt/src/androidMain/cpp/include/oliphaunt.h"
package_tasks=":oliphaunt:metadataSourcesJar :oliphaunt:allMetadataJar :oliphaunt:jvmJar :oliphaunt:jvmSourcesJar :oliphaunt:androidReleaseSourcesJar :oliphaunt:bundleReleaseAar"
if [ "$(uname -s)" = "Darwin" ]; then
  package_tasks="$package_tasks :oliphaunt:macosArm64SourcesJar"
fi
# shellcheck disable=SC2086
run "$gradle_cmd" -p "$project_dir" \
  $package_tasks \
  $android_abi_gradle_args \
  $gradle_scratch_args \
  $gradle_cache_args

kotlin_libs="$kotlin_build_dir/libs"
kotlin_outputs="$kotlin_build_dir/outputs"
kotlin_version="$(kotlin_package_version)"
metadata_sources="$kotlin_libs/oliphaunt-metadata-$kotlin_version-sources.jar"
metadata_jar="$kotlin_libs/oliphaunt-metadata-$kotlin_version.jar"
jvm_jar="$kotlin_libs/oliphaunt-jvm-$kotlin_version.jar"
jvm_sources="$kotlin_libs/oliphaunt-jvm-$kotlin_version-sources.jar"
android_sources="$kotlin_libs/oliphaunt-android-$kotlin_version-sources.jar"
macos_sources="$kotlin_libs/oliphaunt-macosarm64-$kotlin_version-sources.jar"
android_release_aar="$kotlin_outputs/aar/oliphaunt-release.aar"

require_jar_entry "$metadata_sources" "commonMain/dev/oliphaunt/Oliphaunt.kt" \
  "Kotlin metadata sources artifact must include the common SDK API"
require_jar_entry "$metadata_sources" "commonMain/dev/oliphaunt/Query.kt" \
  "Kotlin metadata sources artifact must include the common query helpers"
reject_jar_entry_pattern "$metadata_sources" '(^|/)commonTest/|(^|/)androidUnitTest/|(^|/)nativeTest/' \
  "Kotlin metadata sources artifact must not include test sources"

require_jar_entry "$metadata_jar" "META-INF/kotlin-project-structure-metadata.json" \
  "Kotlin metadata artifact must include project-structure metadata"
require_jar_entry_pattern "$metadata_jar" '^commonMain/default/linkdata/package_dev\.oliphaunt/[0-9]+_oliphaunt\.knm$' \
  "Kotlin metadata artifact must include common dev.oliphaunt linkdata"

require_jar_entry "$jvm_jar" "dev/oliphaunt/OliphauntDatabase.class" \
  "Kotlin JVM artifact must include the public SDK database class"
require_jar_entry "$jvm_jar" "dev/oliphaunt/RuntimeUnavailableEngine.class" \
  "Kotlin JVM artifact must preserve the explicit unavailable-runtime implementation"

require_jar_entry "$jvm_sources" "jvmMain/dev/oliphaunt/DefaultEngine.kt" \
  "Kotlin JVM sources artifact must include the JVM runtime boundary"
require_jar_entry "$jvm_sources" "commonMain/dev/oliphaunt/Oliphaunt.kt" \
  "Kotlin JVM sources artifact must include the common SDK API"

require_jar_entry "$android_sources" "androidMain/dev/oliphaunt/AndroidNativeDirectEngine.kt" \
  "Kotlin Android sources artifact must include the Android direct engine"
require_jar_entry "$android_sources" "androidMain/dev/oliphaunt/OliphauntAndroidRuntimeAssets.kt" \
  "Kotlin Android sources artifact must include Android runtime-resources handling"
require_jar_entry "$android_sources" "commonMain/dev/oliphaunt/Oliphaunt.kt" \
  "Kotlin Android sources artifact must include the common SDK API"
reject_jar_entry_pattern "$android_sources" 'androidMain/cpp/|nativeInterop/|(^|/)liboliphaunt\.so$' \
  "Kotlin Android sources artifact must not include native build outputs or bundled Oliphaunt runtime binaries"

if [ "$(uname -s)" = "Darwin" ]; then
  require_jar_entry "$macos_sources" "nativeMain/dev/oliphaunt/NativeDirectEngine.kt" \
    "Kotlin macOS/native sources artifact must include the native-direct engine"
  require_jar_entry "$macos_sources" "commonMain/dev/oliphaunt/Oliphaunt.kt" \
    "Kotlin macOS/native sources artifact must include the common SDK API"
fi

require_jar_entry "$android_release_aar" "classes.jar" \
  "Kotlin Android release AAR must include compiled classes"
if [ -n "$android_abi_filters" ]; then
  old_ifs="$IFS"
  IFS=","
  # shellcheck disable=SC2086
  set -- $android_abi_filters
  IFS="$old_ifs"
  for abi in "$@"; do
    require_jar_entry "$android_release_aar" "jni/$abi/liboliphaunt_kotlin_android.so" \
      "Kotlin Android release AAR must include the JNI adapter for selected ABI $abi"
  done
else
  require_jar_entry_pattern "$android_release_aar" '^jni/[^/]+/liboliphaunt_kotlin_android\.so$' \
    "Kotlin Android release AAR must include at least one JNI adapter binary"
fi
reject_jar_entry_pattern "$android_release_aar" '^jni/[^/]+/liboliphaunt\.so$' \
  "Kotlin Android default release AAR must not bundle the PostgreSQL runtime binary without an explicit packaged runtime input"

if [ -n "${ANDROID_HOME:-}" ]; then
  run_android_runtime_smoke

  tmp_split_runtime="$(prepare_scratch_dir kotlin-split-runtime)"
  tmp_split_template="$(prepare_scratch_dir kotlin-split-template)"
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
  run "$gradle_cmd" -p "$project_dir" :oliphaunt:prepareOliphauntAndroidAssets \
    "-PoliphauntRuntimeDir=$tmp_split_runtime" \
    "-PoliphauntTemplatePgdataDir=$tmp_split_template" \
    "-PoliphauntExtensions=vector" \
    $gradle_scratch_args \
    $gradle_smoke_cache_args
  generated="$kotlin_build_dir/generated/oliphaunt-android-assets"
  split_runtime_manifest="$generated/oliphaunt/runtime/manifest.properties"
  split_template_manifest="$generated/oliphaunt/template-pgdata/manifest.properties"
  require_manifest_line "$split_runtime_manifest" "schema=oliphaunt-runtime-resources-v1" \
    "Kotlin Android split runtime manifest did not emit the shared runtime-resources schema"
  require_manifest_line "$split_runtime_manifest" "layout=postgres-runtime-files-v1" \
    "Kotlin Android split runtime manifest did not emit the runtime resources layout"
  require_manifest_line "$split_runtime_manifest" "extensions=vector" \
    "Kotlin Android split runtime manifest did not record selected vector extension"
  require_manifest_line "$split_runtime_manifest" "sharedPreloadLibraries=" \
    "Kotlin Android split runtime manifest did not record shared preload libraries"
  require_manifest_line "$split_runtime_manifest" "mobileStaticRegistryState=pending" \
    "Kotlin Android split runtime manifest did not mark mobile static registry as pending"
  require_manifest_line "$split_runtime_manifest" "mobileStaticRegistryRegistered=" \
    "Kotlin Android split runtime manifest should not claim registered mobile static modules"
  require_manifest_line "$split_runtime_manifest" "mobileStaticRegistryPending=vector" \
    "Kotlin Android split runtime manifest did not record pending mobile static registry modules"
  require_manifest_line "$split_runtime_manifest" "nativeModuleStems=vector" \
    "Kotlin Android split runtime manifest did not record expected native module stems"
  require_manifest_line "$split_runtime_manifest" "mobileStaticRegistrySource=" \
    "Kotlin Android split runtime manifest should not claim generated mobile static-registry source"
  require_manifest_line "$split_template_manifest" "mobileStaticRegistryState=not-required" \
    "Kotlin Android split template manifest should not require mobile static registry work"
  require_manifest_line "$split_template_manifest" "mobileStaticRegistryPending=" \
    "Kotlin Android split template manifest should not list pending mobile static registry modules"
  require_manifest_line "$split_template_manifest" "sharedPreloadLibraries=" \
    "Kotlin Android split template manifest should not list shared preload libraries"
  require_manifest_line "$split_template_manifest" "nativeModuleStems=" \
    "Kotlin Android split template manifest should not list native module stems"
  require_manifest_line "$split_template_manifest" "mobileStaticRegistrySource=" \
    "Kotlin Android split template manifest should not claim generated mobile static-registry source"

  tmp_split_incomplete_runtime="$(prepare_scratch_dir kotlin-split-incomplete-extension)"
  mkdir -p "$tmp_split_incomplete_runtime/share/postgresql/extension"
  printf 'runtime split incomplete smoke\n' >"$tmp_split_incomplete_runtime/share/postgresql/README.liboliphaunt-split-incomplete-smoke"
  printf "comment = 'vector split incomplete control'\n" >"$tmp_split_incomplete_runtime/share/postgresql/extension/vector.control"
  split_incomplete_extension_log="$scratch_root/kotlin-split-incomplete-extension.log"
  rm -f "$split_incomplete_extension_log"
  printf '\n==> %s\n' "$gradle_cmd -p $project_dir :oliphaunt:prepareOliphauntAndroidAssets -PoliphauntExtensions=vector"
  if "$gradle_cmd" -p "$project_dir" :oliphaunt:prepareOliphauntAndroidAssets \
    "-PoliphauntRuntimeDir=$tmp_split_incomplete_runtime" \
    "-PoliphauntTemplatePgdataDir=$tmp_split_template" \
    "-PoliphauntExtensions=vector" \
    $gradle_scratch_args \
    $gradle_smoke_cache_args >"$split_incomplete_extension_log" 2>&1; then
    echo "Kotlin Android split runtime packaging accepted a selected extension without packaged SQL files" >&2
    cat "$split_incomplete_extension_log" >&2
    rm -f "$split_incomplete_extension_log"
    exit 1
  fi
  if ! grep -Fq "selected extension 'vector' has no packaged SQL files" "$split_incomplete_extension_log"; then
    echo "Kotlin Android split runtime packaging failed without the expected selected-extension file diagnostic" >&2
    cat "$split_incomplete_extension_log" >&2
    rm -f "$split_incomplete_extension_log"
    exit 1
  fi
  rm -f "$split_incomplete_extension_log"
  rm -rf "$tmp_split_incomplete_runtime"

  split_static_log="$scratch_root/kotlin-split-static.log"
  rm -f "$split_static_log"
  printf '\n==> %s\n' "$gradle_cmd -p $project_dir :oliphaunt:prepareOliphauntAndroidAssets -PoliphauntMobileStaticModules=vector"
  if "$gradle_cmd" -p "$project_dir" :oliphaunt:prepareOliphauntAndroidAssets \
    "-PoliphauntRuntimeDir=$tmp_split_runtime" \
    "-PoliphauntTemplatePgdataDir=$tmp_split_template" \
    "-PoliphauntExtensions=vector" \
    "-PoliphauntMobileStaticModules=vector" \
    $gradle_scratch_args \
    $gradle_smoke_cache_args >"$split_static_log" 2>&1; then
    echo "Kotlin Android split runtime packaging accepted a mobile static module declaration without generated registry source" >&2
    cat "$split_static_log" >&2
    rm -f "$split_static_log"
    exit 1
  fi
  if ! grep -Fq "split runtime packaging cannot declare mobile static module stems" "$split_static_log"; then
    echo "Kotlin Android split runtime packaging failed without the expected static-registry diagnostic" >&2
    cat "$split_static_log" >&2
    rm -f "$split_static_log"
    exit 1
  fi
  rm -f "$split_static_log"

  run "$gradle_cmd" -p "$project_dir" :oliphaunt:prepareOliphauntAndroidAssets \
    "-PoliphauntRuntimeDir=$tmp_split_runtime" \
    "-PoliphauntTemplatePgdataDir=$tmp_split_template" \
    "-PoliphauntExtensions=earthdistance" \
    $gradle_scratch_args \
    $gradle_smoke_cache_args
  require_manifest_line "$split_runtime_manifest" "extensions=cube,earthdistance" \
    "Kotlin Android split runtime manifest did not include exact extension dependencies"
  require_manifest_line "$split_runtime_manifest" "sharedPreloadLibraries=" \
    "Kotlin Android split runtime manifest should not record shared preload libraries for earthdistance"
  require_manifest_line "$split_runtime_manifest" "mobileStaticRegistryPending=cube,earthdistance" \
    "Kotlin Android split runtime manifest did not map earthdistance mobile pending extensions"
  require_manifest_line "$split_runtime_manifest" "nativeModuleStems=cube,earthdistance" \
    "Kotlin Android split runtime manifest did not map earthdistance native module stems"

  split_unknown_extension_log="$scratch_root/kotlin-split-unknown-extension.log"
  rm -f "$split_unknown_extension_log"
  printf '\n==> %s\n' "$gradle_cmd -p $project_dir :oliphaunt:prepareOliphauntAndroidAssets -PoliphauntExtensions=acme_unknown"
  if "$gradle_cmd" -p "$project_dir" :oliphaunt:prepareOliphauntAndroidAssets \
    "-PoliphauntRuntimeDir=$tmp_split_runtime" \
    "-PoliphauntTemplatePgdataDir=$tmp_split_template" \
    "-PoliphauntExtensions=acme_unknown" \
    $gradle_scratch_args \
    $gradle_smoke_cache_args >"$split_unknown_extension_log" 2>&1; then
    echo "Kotlin Android split runtime packaging accepted an extension absent from generated metadata" >&2
    cat "$split_unknown_extension_log" >&2
    rm -f "$split_unknown_extension_log"
    exit 1
  fi
  if ! grep -Fq "cannot select unknown extension 'acme_unknown'" "$split_unknown_extension_log"; then
    echo "Kotlin Android split runtime packaging failed without the expected unknown-extension diagnostic" >&2
    cat "$split_unknown_extension_log" >&2
    rm -f "$split_unknown_extension_log"
    exit 1
  fi
  rm -f "$split_unknown_extension_log"
  rm -rf "$tmp_split_runtime" "$tmp_split_template"

  tmp_jni="$(prepare_scratch_dir kotlin-jni)"
  mkdir -p "$tmp_jni/jniLibs/arm64-v8a"
  printf 'not-a-real-android-elf-for-packaging-smoke\n' >"$tmp_jni/jniLibs/arm64-v8a/liboliphaunt.so"
  run "$gradle_cmd" -p "$project_dir" :oliphaunt:prepareOliphauntAndroidJniLibs \
    "-PoliphauntAndroidJniLibsDir=$tmp_jni" \
    $gradle_scratch_args \
    $gradle_smoke_cache_args
  generated_jni="$kotlin_build_dir/generated/oliphaunt-android-jniLibs"
  if [ ! -f "$generated_jni/arm64-v8a/liboliphaunt.so" ]; then
    echo "Kotlin Android generated JNI libs did not include packaged liboliphaunt.so" >&2
    rm -rf "$tmp_jni"
    exit 1
  fi
  rm -rf "$tmp_jni"
fi
