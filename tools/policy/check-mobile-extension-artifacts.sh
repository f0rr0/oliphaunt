#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

if [ -z "${ANDROID_HOME:-}" ] && [ -d "$HOME/Library/Android/sdk" ]; then
  export ANDROID_HOME="$HOME/Library/Android/sdk"
fi
if [ -n "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ]; then
  export ANDROID_SDK_ROOT="$ANDROID_HOME"
fi

source src/runtimes/liboliphaunt/native/bin/mobile-static-extensions.sh

selected_raw="${OLIPHAUNT_MOBILE_EXTENSION_CHECK_EXTENSIONS:-vector}"
scratch_root="${OLIPHAUNT_MOBILE_EXTENSION_CHECK_SCRATCH:-$root/target/liboliphaunt-mobile-extension-check}"
resource_output="$scratch_root/resources"
jni_root="$scratch_root/android-jni"
kotlin_build_root="$scratch_root/kotlin-gradle"
kotlin_cxx_root="$scratch_root/kotlin-cxx"
kotlin_cache_root="$scratch_root/kotlin-gradle-cache"
rn_build_root="$scratch_root/react-native-gradle"
rn_cxx_root="$scratch_root/react-native-cxx"
rn_cache_root="$scratch_root/react-native-gradle-cache"
native_resource_work_root="$scratch_root/native-resource-runtime"

selected_extensions=()
selected_module_extensions=()
selected_stems=()
selected_ios_dependencies=()
native_resource_env=()
mobile_catalog_cache=""

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

mobile_catalog() {
  if [ -z "$mobile_catalog_cache" ]; then
    mobile_catalog_cache="$(cargo run -p oliphaunt --bin oliphaunt-resources --locked -- --list-extensions)"
  fi
  printf '%s\n' "$mobile_catalog_cache"
}

mobile_prebuilt_extensions() {
  mobile_catalog | awk -F '\t' 'NR > 1 && $8 == "yes" { print $1 }'
}

mobile_catalog_native_module_stem() {
  local extension="$1"
  mobile_catalog | awk -F '\t' -v extension="$extension" '
    NR > 1 && $1 == extension && $8 == "yes" {
      print $4
      found = 1
      exit
    }
    END {
      if (!found) {
        exit 1
      }
    }
  '
}

array_contains() {
  local value="$1"
  shift || true
  case " $* " in
    *" $value "*) ;;
    *) return 1 ;;
  esac
}

add_ios_dependency() {
  local dependency="$1"
  [ -n "$dependency" ] || return 0
  array_contains "$dependency" "${selected_ios_dependencies[@]}" || selected_ios_dependencies+=("$dependency")
}

add_extension() {
  local requested="$1"
  local extension stem catalog_stem
  requested="$(printf '%s\n' "$requested" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [ -n "$requested" ] || return 0
  if oliphaunt_mobile_static_extension_spec "$requested" >/dev/null; then
    extension="$(oliphaunt_mobile_static_extension_sql_name "$requested")"
    stem="$(oliphaunt_mobile_static_extension_module_stem "$requested")"
    array_contains "$extension" "${selected_extensions[@]}" || selected_extensions+=("$extension")
    array_contains "$extension" "${selected_module_extensions[@]}" || selected_module_extensions+=("$extension")
    array_contains "$stem" "${selected_stems[@]}" || selected_stems+=("$stem")
    local dependency
    while IFS= read -r dependency; do
      [ -n "$dependency" ] || continue
      add_ios_dependency "$dependency"
    done < <(oliphaunt_mobile_static_extension_dependencies_for_target "$extension" ios || true)
    return 0
  fi

  if ! catalog_stem="$(mobile_catalog_native_module_stem "$requested")"; then
    echo "unsupported mobile extension artifact check extension: $requested" >&2
    printf 'supported mobile-prebuilt exact extensions: ' >&2
    mobile_prebuilt_extensions | paste -sd ',' - >&2
    exit 2
  fi

  if [ "$catalog_stem" != "-" ]; then
    echo "mobile-prebuilt extension $requested is missing a mobile static build spec for native module $catalog_stem" >&2
    exit 2
  fi

  array_contains "$requested" "${selected_extensions[@]}" || selected_extensions+=("$requested")
}

join_csv() {
  local old_ifs="$IFS"
  IFS=","
  printf '%s' "$*"
  IFS="$old_ifs"
}

join_sorted_csv() {
  if [ "$#" -eq 0 ]; then
    return 0
  fi
  printf '%s\n' "$@" | LC_ALL=C sort -u | paste -sd ',' -
}

prepare_native_resource_runtime() {
  native_resource_env=()
  if ! array_contains postgis "${selected_extensions[@]}"; then
    return 0
  fi
  local native_resource_log="$scratch_root/native-resource-runtime.log"
  printf '\n==> env OLIPHAUNT_WORK_ROOT=%s OLIPHAUNT_BUILD_EXTENSIONS=1 OLIPHAUNT_POSTGIS_USE_PINNED_DEPS=1 src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh (log: %s)\n' \
    "$native_resource_work_root" \
    "$native_resource_log"
  if ! env \
    OLIPHAUNT_WORK_ROOT="$native_resource_work_root" \
    OLIPHAUNT_BUILD_EXTENSIONS=1 \
    OLIPHAUNT_POSTGIS_USE_PINNED_DEPS=1 \
    src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh > "$native_resource_log" 2>&1; then
    echo "native PostGIS resource runtime build failed; tail of $native_resource_log:" >&2
    tail -n 120 "$native_resource_log" >&2 || true
    exit 1
  fi
  native_resource_env=(
    "OLIPHAUNT_INSTALL_DIR=$native_resource_work_root/install"
    "LIBOLIPHAUNT_PATH=$native_resource_work_root/out/liboliphaunt.dylib"
  )
}

require_text() {
  local file="$1"
  local text="$2"
  local message="$3"
  if ! grep -Fq "$text" "$file"; then
    echo "$message" >&2
    echo "expected '$text' in $file" >&2
    exit 1
  fi
}

require_manifest_line() {
  local file="$1"
  local line="$2"
  local message="$3"
  if ! grep -Fxq "$line" "$file"; then
    echo "$message" >&2
    echo "expected exact line '$line' in $file" >&2
    exit 1
  fi
}

reject_zip_entry() {
  local archive="$1"
  local pattern="$2"
  local message="$3"
  local entries
  entries="$(unzip -Z1 "$archive")"
  if grep -Eq "$pattern" <<< "$entries"; then
    echo "$message" >&2
    echo "unexpected pattern '$pattern' in $archive" >&2
    exit 1
  fi
}

require_zip_entry() {
  local archive="$1"
  local pattern="$2"
  local message="$3"
  local entries
  entries="$(unzip -Z1 "$archive")"
  if ! grep -Eq "$pattern" <<< "$entries"; then
    echo "$message" >&2
    echo "expected pattern '$pattern' in $archive" >&2
    exit 1
  fi
}

regex_escape() {
  printf '%s' "$1" | sed -e 's/[][(){}.^$*+?|\\]/\\&/g'
}

require_selected_extension_controls() {
  local archive="$1"
  local label="$2"
  local extension escaped
  for extension in "${selected_extensions[@]}"; do
    if [ "$extension" = "auto_explain" ]; then
      continue
    fi
    escaped="$(regex_escape "$extension")"
    require_zip_entry "$archive" "assets/oliphaunt/runtime/files/share/postgresql/extension/$escaped\\.control$" \
      "$label must include selected $extension extension assets"
  done
}

reject_unselected_extension_controls() {
  local archive="$1"
  local label="$2"
  local extension escaped
  while IFS= read -r extension; do
    [ -n "$extension" ] || continue
    [ "$extension" != "auto_explain" ] || continue
    array_contains "$extension" "${selected_extensions[@]}" && continue
    escaped="$(regex_escape "$extension")"
    reject_zip_entry "$archive" "assets/oliphaunt/runtime/files/share/postgresql/extension/$escaped\\.control$" \
      "$label must not leak unselected $extension assets"
  done < <(mobile_prebuilt_extensions)
}

require_library_symbol() {
  local library="$1"
  local symbol="$2"
  local symbols
  if ! symbols="$(nm -D --defined-only "$library" 2>/dev/null)"; then
    echo "could not inspect symbols in $library" >&2
    exit 1
  fi
  if ! grep -Eq "[[:space:]]$symbol$" <<< "$symbols"; then
    echo "missing required symbol $symbol in $library" >&2
    exit 1
  fi
}

require cargo
require unzip
require nm
require xcodebuild

IFS=","
read -r -a requested_extensions <<< "$selected_raw"
IFS=$' \t\n'
for requested in "${requested_extensions[@]}"; do
  case "$(printf '%s\n' "$requested" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')" in
    all-mobile)
      while IFS= read -r extension; do
        add_extension "$extension"
      done < <(mobile_prebuilt_extensions)
      ;;
    all-mobile-modules)
      while IFS= read -r extension; do
        add_extension "$extension"
      done < <(oliphaunt_mobile_static_supported_extensions)
      ;;
    *)
      add_extension "$requested"
      ;;
  esac
done

if [ "${#selected_extensions[@]}" -eq 0 ]; then
  echo "no mobile extension artifact check extensions selected" >&2
  exit 2
fi

selected_csv="$(join_csv "${selected_extensions[@]}")"
module_extensions_csv="$(join_csv "${selected_module_extensions[@]}")"
stems_csv="$(join_csv "${selected_stems[@]}")"
manifest_stems_csv="$(join_sorted_csv "${selected_stems[@]}")"

printf 'checking mobile extension artifacts for extensions=%s stems=%s\n' "$selected_csv" "$stems_csv"

rm -rf \
  "$resource_output" \
  "$jni_root" \
  "$kotlin_build_root" \
  "$kotlin_cxx_root" \
  "$rn_build_root" \
  "$rn_cxx_root"

mobile_static_args=()
for stem in "${selected_stems[@]}"; do
  mobile_static_args+=(--mobile-static-module "$stem")
done

run env OLIPHAUNT_MOBILE_STATIC_EXTENSIONS="$module_extensions_csv" \
  src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-simulator.sh
run env OLIPHAUNT_MOBILE_STATIC_EXTENSIONS="$module_extensions_csv" \
  src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-device.sh
run env OLIPHAUNT_MOBILE_STATIC_EXTENSIONS="$module_extensions_csv" \
  src/runtimes/liboliphaunt/native/bin/build-postgres18-android-arm64.sh

prepare_native_resource_runtime

run env "${native_resource_env[@]}" cargo run -p oliphaunt --bin oliphaunt-resources --locked -- \
  --output "$resource_output" \
  --extension "$selected_csv" \
  "${mobile_static_args[@]}" \
  --require-mobile-static-registry \
  --force

runtime_manifest="$resource_output/oliphaunt/runtime/manifest.properties"
static_registry_source="$resource_output/oliphaunt/static-registry/oliphaunt_static_registry.c"
require_manifest_line "$runtime_manifest" "extensions=$selected_csv" \
  "Rust runtime resources must record exact selected extensions"
require_manifest_line "$runtime_manifest" "nativeModuleStems=$manifest_stems_csv" \
  "Rust runtime resources must record selected native module stems"
if [ "${#selected_stems[@]}" -eq 0 ]; then
  require_manifest_line "$runtime_manifest" "mobileStaticRegistryState=not-required" \
    "SQL-only mobile runtime resources must not invent a static registry"
else
  require_manifest_line "$runtime_manifest" "mobileStaticRegistryState=complete" \
    "Rust runtime resources must prove mobile static registry completion"
  require_text "$static_registry_source" "liboliphaunt_selected_static_extensions" \
    "Rust runtime resources must emit static extension registry glue"
  for stem in "${selected_stems[@]}"; do
    require_text "$static_registry_source" "$(oliphaunt_static_symbol_prefix "$stem")_Pg_magic_func" \
      "Rust runtime resources must strongly reference selected extension magic symbols"
  done
  case " ${selected_extensions[*]} " in
    *" vector "*)
      require_text "$static_registry_source" "vector_in" \
        "Rust runtime resources must strongly reference selected vector SQL symbols"
      require_text "$static_registry_source" "pg_finfo_vector_in" \
        "Rust runtime resources must strongly reference selected vector SQL finfo symbols"
      ;;
  esac
fi

run src/runtimes/liboliphaunt/native/bin/build-ios-extension-xcframeworks.sh \
  --runtime-resources "$resource_output"
run src/runtimes/liboliphaunt/native/bin/build-ios-extension-xcframeworks.sh \
  --check-current \
  --runtime-resources "$resource_output"

for index in "${!selected_module_extensions[@]}"; do
  extension="${selected_module_extensions[$index]}"
  stem="${selected_stems[$index]}"
  xcframework="target/liboliphaunt-ios-extension-xcframeworks/out/$stem/liboliphaunt_extension_$stem.xcframework"
  [ -d "$xcframework" ] || {
    echo "missing iOS extension XCFramework for $extension: $xcframework" >&2
    exit 1
  }
  plutil -extract AvailableLibraries raw "$xcframework/Info.plist" >/dev/null
done

for dependency in "${selected_ios_dependencies[@]}"; do
  xcframework="target/liboliphaunt-ios-extension-xcframeworks/out/dependencies/$dependency/liboliphaunt_dependency_$dependency.xcframework"
  [ -d "$xcframework" ] || {
    echo "missing iOS dependency XCFramework for $dependency: $xcframework" >&2
    exit 1
  }
  plutil -extract AvailableLibraries raw "$xcframework/Info.plist" >/dev/null
done

mkdir -p "$jni_root/arm64-v8a"
cp target/liboliphaunt-pg18-android-arm64/out/liboliphaunt.so "$jni_root/arm64-v8a/liboliphaunt.so"

kotlin_gradle="src/sdks/kotlin/gradlew"
run "$kotlin_gradle" -p src/sdks/kotlin :oliphaunt:bundleReleaseAar \
  -PoliphauntRuntimeResourcesDir="$resource_output" \
  -PoliphauntAndroidJniLibsDir="$jni_root" \
  -PoliphauntAndroidExtensionArchivesDir="$root/target/liboliphaunt-pg18-android-arm64/out" \
  -PoliphauntAndroidAbiFilters=arm64-v8a \
  -PoliphauntBuildRoot="$kotlin_build_root" \
  -PoliphauntCxxBuildRoot="$kotlin_cxx_root" \
  --project-cache-dir "$kotlin_cache_root" \
  --no-configuration-cache

kotlin_aar="$kotlin_build_root/oliphaunt/outputs/aar/oliphaunt-release.aar"
if [ "${#selected_stems[@]}" -gt 0 ]; then
  require_zip_entry "$kotlin_aar" 'jni/arm64-v8a/liboliphaunt_extensions\.so$' \
    "Kotlin Android release AAR must include selected-extension support library"
fi
require_selected_extension_controls "$kotlin_aar" "Kotlin Android release AAR"
reject_unselected_extension_controls "$kotlin_aar" "Kotlin Android release AAR"
reject_zip_entry "$kotlin_aar" 'assets/oliphaunt/static-registry/archives/' \
  "Kotlin Android release AAR must not ship build-only static extension archives"

if [ "${#selected_stems[@]}" -gt 0 ]; then
  kotlin_extension_library="$kotlin_build_root/oliphaunt/intermediates/cxx/RelWithDebInfo"
  kotlin_extension_library="$(find "$kotlin_extension_library" -path '*/obj/arm64-v8a/liboliphaunt_extensions.so' -print -quit)"
  require_library_symbol "$kotlin_extension_library" liboliphaunt_selected_static_extensions
fi

run "$kotlin_gradle" -p src/sdks/react-native/android assembleDebug \
  -PoliphauntReactNativePackageRuntime=true \
  -PoliphauntRuntimeResourcesDir="$resource_output" \
  -PoliphauntAndroidJniLibsDir="$jni_root" \
  -PoliphauntAndroidExtensionArchivesDir="$root/target/liboliphaunt-pg18-android-arm64/out" \
  -PoliphauntAndroidAbiFilters=arm64-v8a \
  -PoliphauntKotlinSdkDir="$root/src/sdks/kotlin/oliphaunt" \
  -PoliphauntBuildRoot="$rn_build_root" \
  -PoliphauntCxxBuildRoot="$rn_cxx_root" \
  --project-cache-dir "$rn_cache_root" \
  --no-configuration-cache

rn_aar="$rn_build_root/root/outputs/aar/oliphaunt-react-native-android-debug.aar"
require_selected_extension_controls "$rn_aar" "React Native Android AAR"
reject_unselected_extension_controls "$rn_aar" "React Native Android AAR"
if [ "${#selected_stems[@]}" -gt 0 ]; then
  require_zip_entry "$rn_aar" 'jni/arm64-v8a/liboliphaunt_extensions\.so$' \
    "React Native Android AAR must include selected-extension support library"
  reject_zip_entry "$rn_aar" 'assets/oliphaunt/static-registry/archives/' \
    "React Native Android AAR must not ship build-only static extension archives"
  rn_extension_library="$rn_build_root/root/intermediates/cxx/Debug"
  rn_extension_library="$(find "$rn_extension_library" -path '*/obj/arm64-v8a/liboliphaunt_extensions.so' -print -quit)"
  require_library_symbol "$rn_extension_library" liboliphaunt_selected_static_extensions
fi

printf '\nmobile extension artifact checks passed for %s\n' "$selected_csv"
