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

check_maven_publication_graph() {
  graph_log="$scratch_root/maven-publication-graph.log"
  mkdir -p "$scratch_root"
  printf '\n==> verify Android-only Maven publication graph\n'
  if ! "$gradle_cmd" -q -p "$project_dir" \
    :oliphaunt:publishToMavenLocal \
    :oliphaunt:publishToMavenCentral \
    :oliphaunt:publishAndReleaseToMavenCentral \
    --dry-run \
    --no-configuration-cache >"$graph_log" 2>&1; then
    cat "$graph_log" >&2
    echo "Kotlin Maven publication graph dry-run failed" >&2
    exit 1
  fi
  publication_tasks="$(
    grep -E ':(publish|sign|generatePomFileFor|generateMetadataFileFor)[A-Za-z0-9]*Publication' "$graph_log" |
      grep -v ':publishAllPublications' || true
  )"
  if ! printf '%s\n' "$publication_tasks" | grep -q 'AndroidReleasePublication'; then
    cat "$graph_log" >&2
    echo "Kotlin Maven publication graph did not include the supported Android release publication" >&2
    exit 1
  fi
  unsupported_publication_tasks="$(printf '%s\n' "$publication_tasks" | grep -v 'AndroidReleasePublication' || true)"
  if [ -n "$unsupported_publication_tasks" ]; then
    printf '%s\n' "$unsupported_publication_tasks" >&2
    echo "Kotlin Maven aggregate entry points include unsupported non-Android publications" >&2
    exit 1
  fi
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

require_jar_entry() {
  jar_file="$1"
  entry="$2"
  message="$3"
  if [ ! -f "$jar_file" ]; then
    echo "missing Kotlin package artifact: $jar_file" >&2
    exit 1
  fi
  if ! jar tf "$jar_file" | grep -Fx "$entry" >/dev/null; then
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
  if ! jar tf "$jar_file" | grep -E "$pattern" >/dev/null; then
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
  if jar tf "$jar_file" | grep -E "$pattern" >/dev/null; then
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

run_without_runtime_environment() {
  env \
    -u LIBOLIPHAUNT_PATH \
    -u OLIPHAUNT_INSTALL_DIR \
    -u OLIPHAUNT_INITDB \
    -u OLIPHAUNT_RUNTIME_DIR \
    "$@"
}

run_with_repository_retry() {
  attempt=1
  max_attempts=2
  attempt_log="$scratch_root/gradle-repository-attempt.log"
  mkdir -p "$scratch_root"
  while [ "$attempt" -le "$max_attempts" ]; do
    printf '\n==> repository-bounded attempt %s/%s: %s\n' "$attempt" "$max_attempts" "$*"
    if run_without_runtime_environment "$@" >"$attempt_log" 2>&1; then
      cat "$attempt_log"
      rm -f "$attempt_log"
      return 0
    else
      status=$?
    fi
    cat "$attempt_log" >&2
    if [ "$attempt" -ge "$max_attempts" ] ||
      ! grep -Eq "Could not (GET|HEAD) 'https://(repo[.]maven[.]apache[.]org|repo1[.]maven[.]org|plugins[.]gradle[.]org|dl[.]google[.]com|maven[.]google[.]com)/" "$attempt_log" ||
      ! grep -Eq 'Received status code (403|408|425|429|500|502|503|504)|Read timed out|Connection reset|Remote host terminated|Temporary failure in name resolution' "$attempt_log"; then
      return "$status"
    fi
    echo "public Gradle repository returned a transient transport response; retrying once after 10 seconds" >&2
    attempt=$((attempt + 1))
    sleep 10
  done
  return 1
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
    "$tmp_assets/oliphaunt/cluster-seed/files/base" \
    "$tmp_assets/oliphaunt/cluster-seed/files/global" \
    "$tmp_assets/oliphaunt/cluster-seed-icu/files/global"
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
  printf '18\n' >"$tmp_assets/oliphaunt/cluster-seed/files/PG_VERSION"
  printf 'control\n' >"$tmp_assets/oliphaunt/cluster-seed/files/global/pg_control"
  printf '18\n' >"$tmp_assets/oliphaunt/cluster-seed-icu/files/PG_VERSION"
  printf 'control\n' >"$tmp_assets/oliphaunt/cluster-seed-icu/files/global/pg_control"
  printf 'cluster seed smoke\n' >"$tmp_assets/oliphaunt/cluster-seed/files/base/README.liboliphaunt-smoke"
  cat >"$tmp_assets/oliphaunt/manifest.properties" <<'MANIFEST'
schema=oliphaunt-native-runtime-carrier-v1
clusterSeedTarget=android-datum64
clusterSeedRelativePath=cluster-seed
icuClusterSeedRelativePath=cluster-seed-icu
MANIFEST
  cat >"$tmp_assets/oliphaunt/runtime/manifest.properties" <<'MANIFEST'
schema=oliphaunt-runtime-resources-v1
cacheKey=runtime-smoke
layout=postgres-runtime-files-v1
artifactRole=runtime
catalogProfile=
clusterSeedTarget=android-datum64
icuDataTreeSha256=
mode=native-direct
selectedExtensions=vector
extensions=vector
runtimeFeatures=
sharedPreloadLibraries=
mobileStaticRegistryState=complete
mobileStaticRegistryRegistered=vector
mobileStaticRegistryPending=
nativeModuleStems=vector
mobileStaticRegistrySource=static-registry/oliphaunt_static_registry.c
MANIFEST
  cat >"$tmp_assets/oliphaunt/cluster-seed/manifest.properties" <<'MANIFEST'
schema=oliphaunt-runtime-resources-v1
layout=oliphaunt-cluster-seed-v1
artifactRole=cluster-seed-standard
catalogProfile=standard
postgresMajor=18
physicalFormat=native-pg18-v1
target=android-datum64
compatibilityKey=native-pg18-android-datum64-v1
initialSuperuser=postgres
runtimeFeatures=
icuDataVersion=
icuDataForm=
icuDataTreeSha256=
cacheKey=cluster-seed-standard-smoke
MANIFEST
  cat >"$tmp_assets/oliphaunt/cluster-seed-icu/manifest.properties" <<'MANIFEST'
schema=oliphaunt-runtime-resources-v1
layout=oliphaunt-cluster-seed-v1
artifactRole=cluster-seed-icu
catalogProfile=icu
postgresMajor=18
physicalFormat=native-pg18-v1
target=android-datum64
compatibilityKey=native-pg18-android-datum64-v1
initialSuperuser=postgres
runtimeFeatures=icu
icuDataVersion=76.1
icuDataForm=files-le
icuDataTreeSha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
cacheKey=cluster-seed-icu-smoke
MANIFEST
  cat >"$tmp_assets/oliphaunt/package-size.tsv" <<'REPORT'
kind	id	extensions	files	bytes
package	total	-	-	205
package	runtime	-	-	100
package	cluster-seed	-	-	40
package	cluster-seed-icu	-	-	20
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
  if [ ! -f "$generated/oliphaunt/cluster-seed/files/PG_VERSION" ]; then
    echo "Kotlin Android generated assets did not include the runtime-resource cluster seed" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  if [ ! -f "$generated/oliphaunt/cluster-seed-icu/files/global/pg_control" ]; then
    echo "Kotlin Android generated assets did not include the target-matched ICU cluster seed" >&2
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
  if ! grep -Fxq "selectedExtensions=vector" "$generated/oliphaunt/runtime/manifest.properties"; then
    echo "Kotlin Android generated runtime manifest did not preserve the full selected-extension domain" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  if ! grep -Fxq "extensions=vector" "$generated/oliphaunt/runtime/manifest.properties"; then
    echo "Kotlin Android generated runtime manifest did not preserve createable runtime-resources extensions" >&2
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
  if ! grep -Fxq "runtimeFeatures=" "$generated/oliphaunt/runtime/manifest.properties"; then
    echo "Kotlin Android generated runtime manifest did not preserve runtime feature metadata" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  if ! grep -Fxq "catalogProfile=standard" "$generated/oliphaunt/cluster-seed/manifest.properties" ||
    ! grep -Fxq "catalogProfile=icu" "$generated/oliphaunt/cluster-seed-icu/manifest.properties"; then
    echo "Kotlin Android generated assets did not preserve both exact cluster-seed profiles" >&2
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
  if jar tf "$static_asset_aar" | grep -F "assets/oliphaunt/static-registry/archives/" >/dev/null; then
    echo "Kotlin Android AAR included build-only static extension archives" >&2
    rm -rf "$tmp_assets" "$tmp_static_jni"
    exit 1
  fi
  rm -rf "$tmp_assets" "$tmp_static_jni"
}

oliphaunt_runtime_native_host_export_defaults

for coordinate in \
  'maven:dev.oliphaunt:oliphaunt-android' \
  'maven:dev.oliphaunt:oliphaunt-android-gradle-plugin' \
  'maven:dev.oliphaunt.android:dev.oliphaunt.android.gradle.plugin'
do
  if ! grep -Fq "\"$coordinate\"" "$project_dir/release.toml"; then
    echo "Kotlin release metadata is missing supported publication $coordinate" >&2
    exit 1
  fi
done
if grep -Fq '"maven:dev.oliphaunt:oliphaunt"' "$project_dir/release.toml"; then
  echo "Kotlin release metadata still advertises the unsupported KMP root coordinate dev.oliphaunt:oliphaunt" >&2
  exit 1
fi

if [ "$mode" = "smoke-runtime" ]; then
  run_android_runtime_smoke
  exit 0
fi

if [ "$mode" = "check-static" ]; then
  static_tasks=":oliphaunt:spotlessCheck :oliphaunt:detekt :oliphaunt:checkMavenPublicationContract :oliphaunt:compileKotlinJvm :oliphaunt:compileDebugKotlinAndroid :oliphaunt:compileReleaseKotlinAndroid :oliphaunt-android-gradle-plugin:check"
  if [ -n "${ANDROID_HOME:-}" ]; then
    # Force only the analyzer tasks so an earlier incompatible result cannot be
    # accepted from Gradle's up-to-date/build caches without replaying its fatal
    # diagnostics. Other compilation and packaging work remains cacheable.
    static_tasks="$static_tasks :oliphaunt:lintAnalyzeDebug --rerun :oliphaunt:lintAnalyzeDebugUnitTest --rerun :oliphaunt:lintAnalyzeDebugAndroidTest --rerun :oliphaunt:lintDebug"
    # shellcheck disable=SC2086
    run sh "$root/tools/policy/run-gradle-lint-checked.sh" "$scratch_root/gradle-lint.log" -- \
      "$gradle_cmd" -p "$project_dir" \
      $static_tasks \
      $android_abi_gradle_args \
      $gradle_scratch_args \
      $gradle_cache_args
  else
    # shellcheck disable=SC2086
    run "$gradle_cmd" -p "$project_dir" \
      $static_tasks \
      $android_abi_gradle_args \
      $gradle_scratch_args \
      $gradle_cache_args
  fi
  check_maven_publication_graph
  exit 0
fi

if [ "$mode" = "test-unit" ]; then
  unit_tasks=":oliphaunt:jvmTest :oliphaunt:testDebugUnitTest :oliphaunt:testReleaseUnitTest"
  # shellcheck disable=SC2086
  run run_with_repository_retry "$gradle_cmd" -p "$project_dir" \
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
  run sh "$root/tools/policy/run-gradle-lint-checked.sh" "$scratch_root/gradle-check.log" -- \
    "$gradle_cmd" -p "$project_dir" \
    check \
    :oliphaunt:lintAnalyzeDebug --rerun \
    :oliphaunt:lintAnalyzeDebugUnitTest --rerun \
    :oliphaunt:lintAnalyzeDebugAndroidTest --rerun \
    :oliphaunt:lintDebug \
    $gradle_non_coverage_args \
    $android_abi_gradle_args \
    $gradle_scratch_args \
    $gradle_cache_args
  if [ "$mode" = "regression" ]; then
    exit 0
  fi
fi

run cmp src/runtimes/liboliphaunt/native/include/oliphaunt.h "$project_dir/oliphaunt/src/androidMain/cpp/include/oliphaunt.h"
package_tasks=":oliphaunt:checkMavenPublicationContract :oliphaunt:metadataSourcesJar :oliphaunt:allMetadataJar :oliphaunt:jvmJar :oliphaunt:jvmSourcesJar :oliphaunt:androidReleaseSourcesJar :oliphaunt:bundleReleaseAar :oliphaunt-android-gradle-plugin:jar"
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
android_release_aar="$kotlin_outputs/aar/oliphaunt-release.aar"
android_gradle_plugin_jar="$gradle_build_root/oliphaunt-android-gradle-plugin/libs/oliphaunt-android-gradle-plugin-$kotlin_version.jar"

require_jar_entry "$metadata_sources" "commonMain/dev/oliphaunt/Oliphaunt.kt" \
  "Kotlin metadata sources artifact must include the common SDK API"
require_jar_entry "$metadata_sources" "commonMain/dev/oliphaunt/Query.kt" \
  "Kotlin metadata sources artifact must include the common query helpers"
reject_jar_entry_pattern "$metadata_sources" '(^|/)commonTest/|(^|/)androidUnitTest/' \
  "Kotlin metadata sources artifact must not include test sources"

require_jar_entry "$metadata_jar" "META-INF/kotlin-project-structure-metadata.json" \
  "Kotlin metadata artifact must include project-structure metadata"
# The SDK's Android and JVM targets are both JVM-like, so Kotlin skips the
# common metadata compilation. Common API contents are covered by the sources
# and compiled target artifacts checked above and below.

require_jar_entry "$jvm_jar" "dev/oliphaunt/OliphauntDatabase.class" \
  "Kotlin JVM artifact must include the public SDK database class"
reject_jar_entry_pattern "$jvm_jar" 'dev/oliphaunt/(ProtocolRequest|ProtocolResponse|RuntimeUnavailableEngine)\.class' \
  "Kotlin JVM artifact must not expose removed protocol wrappers or the generic unavailable-runtime abstraction"

require_jar_entry "$jvm_sources" "commonMain/dev/oliphaunt/Oliphaunt.kt" \
  "Kotlin JVM sources artifact must include the common SDK API"

require_jar_entry "$android_sources" "androidMain/dev/oliphaunt/AndroidNativeDirectEngine.kt" \
  "Kotlin Android sources artifact must include the Android direct engine"
require_jar_entry "$android_sources" "androidMain/dev/oliphaunt/OliphauntAndroidRuntimeAssets.kt" \
  "Kotlin Android sources artifact must include Android runtime-resources handling"
require_jar_entry "$android_sources" "commonMain/dev/oliphaunt/Oliphaunt.kt" \
  "Kotlin Android sources artifact must include the common SDK API"
reject_jar_entry_pattern "$android_sources" 'androidMain/cpp/|(^|/)liboliphaunt\.so$' \
  "Kotlin Android sources artifact must not include native build outputs or bundled Oliphaunt runtime binaries"

require_jar_entry "$android_gradle_plugin_jar" "dev/oliphaunt/android/extension-legal-catalog.json" \
  "Kotlin Android Gradle plugin must ship the canonical extension legal catalog used for offline verification"

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
