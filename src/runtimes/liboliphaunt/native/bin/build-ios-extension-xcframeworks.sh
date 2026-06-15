#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
. "$script_dir/common.sh"
. "$script_dir/mobile-static-extensions.sh"
repo_root="$(oliphaunt_resolve_repo_root "$script_dir")"

simulator_out="${OLIPHAUNT_IOS_SIMULATOR_OUT:-$repo_root/target/liboliphaunt-ios-simulator/out}"
device_out="${OLIPHAUNT_IOS_DEVICE_OUT:-$repo_root/target/liboliphaunt-ios-device/out}"
work_root="${OLIPHAUNT_IOS_EXTENSION_XCFRAMEWORK_ROOT:-$repo_root/target/liboliphaunt-ios-extension-xcframeworks}"
out_dir="$work_root/out"
headers_dir="$repo_root/src/runtimes/liboliphaunt/native/include"
runtime_resources_dir="${OLIPHAUNT_IOS_RUNTIME_RESOURCES_DIR:-${OLIPHAUNT_RUNTIME_RESOURCES_DIR:-}}"
manifest_file="$out_dir/manifest.properties"

usage() {
  cat >&2 <<USAGE
usage: src/runtimes/liboliphaunt/native/bin/build-ios-extension-xcframeworks.sh [--check-current] [--runtime-resources <dir>]

Packages selected prebuilt mobile extension archives into per-extension iOS
XCFrameworks. Prefer passing the Rust runtime-resource output so the selected
native modules are derived from runtime/manifest.properties:

  src/runtimes/liboliphaunt/native/bin/build-ios-extension-xcframeworks.sh \\
    --runtime-resources target/oliphaunt-resources

For release automation, OLIPHAUNT_MOBILE_STATIC_EXTENSIONS may still provide a
comma-separated exact extension or module-stem list:

  OLIPHAUNT_MOBILE_STATIC_EXTENSIONS=vector,pg_trgm \\
    src/runtimes/liboliphaunt/native/bin/build-ios-extension-xcframeworks.sh

Inputs:
  OLIPHAUNT_IOS_SIMULATOR_OUT   default target/liboliphaunt-ios-simulator/out
  OLIPHAUNT_IOS_DEVICE_OUT      default target/liboliphaunt-ios-device/out
  OLIPHAUNT_RUNTIME_RESOURCES_DIR optional Rust runtime-resource output
  OLIPHAUNT_IOS_RUNTIME_RESOURCES_DIR optional iOS-specific runtime-resource output
Output:
  target/liboliphaunt-ios-extension-xcframeworks/out/<stem>/liboliphaunt_extension_<stem>.xcframework
  target/liboliphaunt-ios-extension-xcframeworks/out/dependencies/<name>/liboliphaunt_dependency_<name>.xcframework
  target/liboliphaunt-ios-extension-xcframeworks/out/manifest.properties
USAGE
}

mode="build"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check-current)
      mode="check"
      shift
      ;;
    --runtime-resources)
      [ "$#" -ge 2 ] || {
        usage
        exit 2
      }
      runtime_resources_dir="$2"
      shift 2
      ;;
    --runtime-resources=*)
      runtime_resources_dir="${1#--runtime-resources=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

selected_extensions=()
selected_stems=()
selected_dependencies=()

join_csv() {
  local old_ifs="$IFS"
  IFS=","
  printf '%s' "$*"
  IFS="$old_ifs"
}

runtime_resources_root() {
  local root="$1"
  if [ -f "$root/oliphaunt/runtime/manifest.properties" ]; then
    printf '%s\n' "$root/oliphaunt"
  elif [ -f "$root/runtime/manifest.properties" ]; then
    printf '%s\n' "$root"
  else
    echo "iOS extension runtime resources are not an Oliphaunt resource root: $root" >&2
    exit 2
  fi
}

resource_manifest_value() {
  local root="$1"
  local key="$2"
  local manifest="$root/runtime/manifest.properties"
  awk -F '=' -v key="$key" '$1 == key { print substr($0, length(key) + 2); found = 1; exit } END { exit found ? 0 : 1 }' "$manifest" || true
}

static_registry_manifest_value() {
  local root="$1"
  local key="$2"
  local manifest="$root/static-registry/manifest.properties"
  [ -f "$manifest" ] || return 1
  awk -F '=' -v key="$key" '$1 == key { print substr($0, length(key) + 2); found = 1; exit } END { exit found ? 0 : 1 }' "$manifest" || true
}

selected_raw_from_runtime_resources() {
  [ -n "$runtime_resources_dir" ] || return 0
  local package_root schema state raw
  package_root="$(runtime_resources_root "$runtime_resources_dir")"
  schema="$(resource_manifest_value "$package_root" "schema")"
  if [ "$schema" != "oliphaunt-runtime-resources-v1" ]; then
    echo "iOS extension runtime resources have unsupported schema '${schema:-<missing>}'; expected oliphaunt-runtime-resources-v1" >&2
    exit 2
  fi
  state="$(resource_manifest_value "$package_root" "mobileStaticRegistryState")"
  raw="$(resource_manifest_value "$package_root" "nativeModuleStems")"
  if [ "$state" = "pending" ] && [ -n "$raw" ]; then
    echo "runtime resources have pending mobile static-registry modules; rebuild them with --mobile-static-module before iOS extension packaging" >&2
    exit 2
  fi
  printf '%s\n' "$raw"
}

portable_id() {
  case "$1" in
    ""|*[!A-Za-z0-9._-]*)
      return 1
      ;;
    *)
      [ "${#1}" -le 128 ]
      ;;
  esac
}

add_selected_pair() {
  local sql_name="$1"
  local stem="$2"
  portable_id "$sql_name" || {
    echo "unsupported iOS mobile static extension name: $sql_name" >&2
    exit 2
  }
  portable_id "$stem" || {
    echo "unsupported iOS mobile static module stem: $stem" >&2
    exit 2
  }
  local index
  for index in "${!selected_extensions[@]}"; do
    if [ "${selected_extensions[$index]}" = "$sql_name" ]; then
      if [ "${selected_stems[$index]}" != "$stem" ]; then
        echo "iOS mobile static extension $sql_name maps to multiple module stems: ${selected_stems[$index]},$stem" >&2
        exit 2
      fi
      return 0
    fi
  done
  selected_extensions+=("$sql_name")
  selected_stems+=("$stem")
  local dependency
  while IFS= read -r dependency; do
    [ -n "$dependency" ] || continue
    add_selected_dependency "$dependency"
  done < <(oliphaunt_mobile_static_extension_dependencies_for_target "$sql_name" ios || true)
}

add_selected_extension() {
  local extension="$1"
  local sql_name stem
  extension="$(printf '%s\n' "$extension" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [ -n "$extension" ] || return 0
  if ! oliphaunt_mobile_static_extension_spec "$extension" >/dev/null; then
    echo "unsupported iOS mobile static extension from OLIPHAUNT_MOBILE_STATIC_EXTENSIONS: $extension" >&2
    echo "for custom prebuilt extensions, pass --runtime-resources so nativeModuleStems are read from the exact resource manifest" >&2
    printf 'supported built-in iOS mobile static extensions: ' >&2
    oliphaunt_mobile_static_supported_extensions | paste -sd ',' - >&2
    exit 2
  fi
  sql_name="$(oliphaunt_mobile_static_extension_sql_name "$extension")"
  stem="$(oliphaunt_mobile_static_extension_module_stem "$extension")"
  add_selected_pair "$sql_name" "$stem"
}

add_selected_from_runtime_resources() {
  [ -n "$runtime_resources_dir" ] || return 0
  local package_root raw old_ifs stems stem sql_name
  package_root="$(runtime_resources_root "$runtime_resources_dir")"
  raw="$(selected_raw_from_runtime_resources)"
  [ -n "$raw" ] || return 0
  old_ifs="$IFS"
  IFS=","
  read -r -a stems <<< "$raw"
  IFS="$old_ifs"
  for stem in "${stems[@]}"; do
    stem="$(printf '%s\n' "$stem" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [ -n "$stem" ] || continue
    sql_name="$(static_registry_manifest_value "$package_root" "module.$stem.extension" || true)"
    [ -n "$sql_name" ] || sql_name="$stem"
    add_selected_pair "$sql_name" "$stem"
  done
}

add_selected_dependency() {
  local dependency="$1"
  dependency="$(printf '%s\n' "$dependency" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [ -n "$dependency" ] || return 0
  portable_id "$dependency" || {
    echo "unsupported iOS mobile static dependency name: $dependency" >&2
    exit 2
  }
  local existing
  for existing in ${selected_dependencies[@]+"${selected_dependencies[@]}"}; do
    [ "$existing" = "$dependency" ] && return 0
  done
  selected_dependencies+=("$dependency")
}

add_selected_dependencies_from_runtime_resources() {
  [ -n "$runtime_resources_dir" ] || return 0
  local package_root raw old_ifs dependencies dependency
  package_root="$(runtime_resources_root "$runtime_resources_dir")"
  raw="$(static_registry_manifest_value "$package_root" "dependencyArchives" || true)"
  [ -n "$raw" ] || return 0
  old_ifs="$IFS"
  IFS=","
  read -r -a dependencies <<< "$raw"
  IFS="$old_ifs"
  for dependency in "${dependencies[@]}"; do
    add_selected_dependency "$dependency"
  done
}

parse_selected_extensions() {
  local raw="${OLIPHAUNT_MOBILE_STATIC_EXTENSIONS:-}"
  if [ -z "$raw" ]; then
    add_selected_from_runtime_resources
    return 0
  fi
  [ -n "$raw" ] || return 0
  local old_ifs="$IFS"
  IFS=","
  read -r -a requested <<< "$raw"
  IFS="$old_ifs"
  local extension
  for extension in "${requested[@]}"; do
    add_selected_extension "$extension"
  done
}

parse_selected_dependencies() {
  add_selected_dependencies_from_runtime_resources
}

stem_for_extension() {
  local extension="$1"
  local index
  for index in "${!selected_extensions[@]}"; do
    if [ "${selected_extensions[$index]}" = "$extension" ]; then
      printf '%s\n' "${selected_stems[$index]}"
      return 0
    fi
  done
  echo "internal error: missing iOS mobile static module stem for $extension" >&2
  exit 2
}

static_registry_archive_candidate() {
  local package_root="$1"
  local relative="$2"
  [ -n "$relative" ] || return 1
  local candidate="$package_root/static-registry/$relative"
  [ -f "$candidate" ] || return 1
  printf '%s\n' "$candidate"
}

archive_for() {
  local platform_out="$1"
  local extension="$2"
  local platform="$3"
  local stem
  stem="$(stem_for_extension "$extension")"
  if [ -n "$runtime_resources_dir" ]; then
    local package_root candidate target
    package_root="$(runtime_resources_root "$runtime_resources_dir")"
    case "$platform" in
      simulator)
        for target in ios-simulator iphonesimulator aarch64-apple-ios-sim x86_64-apple-ios-sim; do
          candidate="$package_root/static-registry/archives/$target/extensions/$stem/liboliphaunt_extension_$stem.a"
          if [ -f "$candidate" ]; then
            printf '%s\n' "$candidate"
            return 0
          fi
        done
        ;;
      device)
        for target in ios-device iphoneos aarch64-apple-ios; do
          candidate="$package_root/static-registry/archives/$target/extensions/$stem/liboliphaunt_extension_$stem.a"
          if [ -f "$candidate" ]; then
            printf '%s\n' "$candidate"
            return 0
          fi
        done
        ;;
    esac
  fi
  printf '%s\n' "$platform_out/extensions/$stem/liboliphaunt_extension_$stem.a"
}

dependency_archive_for() {
  local dependency="$1"
  local platform="$2"
  local package_root candidate relative target search_root platform_out
  if [ -n "$runtime_resources_dir" ]; then
    package_root="$(runtime_resources_root "$runtime_resources_dir")"
    case "$platform" in
      simulator)
        for target in ios-simulator iphonesimulator aarch64-apple-ios-sim x86_64-apple-ios-sim; do
          relative="$(static_registry_manifest_value "$package_root" "dependency.$dependency.archive.$target" || true)"
          if candidate="$(static_registry_archive_candidate "$package_root" "$relative")"; then
            printf '%s\n' "$candidate"
            return 0
          fi
          search_root="$package_root/static-registry/archives/$target/dependencies/$dependency"
          if [ -d "$search_root" ]; then
            candidate="$(find "$search_root" -maxdepth 1 -type f -name '*.a' | sort | head -n 1)"
            if [ -n "$candidate" ]; then
              printf '%s\n' "$candidate"
              return 0
            fi
          fi
        done
        ;;
      device)
        for target in ios-device iphoneos aarch64-apple-ios; do
          relative="$(static_registry_manifest_value "$package_root" "dependency.$dependency.archive.$target" || true)"
          if candidate="$(static_registry_archive_candidate "$package_root" "$relative")"; then
            printf '%s\n' "$candidate"
            return 0
          fi
          search_root="$package_root/static-registry/archives/$target/dependencies/$dependency"
          if [ -d "$search_root" ]; then
            candidate="$(find "$search_root" -maxdepth 1 -type f -name '*.a' | sort | head -n 1)"
            if [ -n "$candidate" ]; then
              printf '%s\n' "$candidate"
              return 0
            fi
          fi
        done
        ;;
    esac
  fi
  case "$platform" in
    simulator) platform_out="$simulator_out" ;;
    device) platform_out="$device_out" ;;
    *) platform_out="" ;;
  esac
  if [ -n "$platform_out" ]; then
    if candidate="$(oliphaunt_mobile_static_dependency_archive_for_root "$platform_out/dependencies" "$dependency")"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi
  echo "internal error: missing iOS mobile static dependency archive for $dependency on $platform" >&2
  exit 2
}

xcframework_for() {
  local extension="$1"
  local stem
  stem="$(stem_for_extension "$extension")"
  printf '%s\n' "$out_dir/$stem/liboliphaunt_extension_$stem.xcframework"
}

dependency_xcframework_for() {
  local dependency="$1"
  printf '%s\n' "$out_dir/dependencies/$dependency/liboliphaunt_dependency_$dependency.xcframework"
}

require_inputs() {
  local extension="$1"
  local simulator_archive device_archive
  simulator_archive="$(archive_for "$simulator_out" "$extension" simulator)"
  device_archive="$(archive_for "$device_out" "$extension" device)"
  [ -f "$simulator_archive" ] || {
    echo "missing iOS simulator extension archive for $extension: $simulator_archive" >&2
    exit 1
  }
  [ -f "$device_archive" ] || {
    echo "missing iOS device extension archive for $extension: $device_archive" >&2
    exit 1
  }
}

require_dependency_inputs() {
  local dependency="$1"
  local simulator_archive device_archive
  simulator_archive="$(dependency_archive_for "$dependency" simulator)"
  device_archive="$(dependency_archive_for "$dependency" device)"
  [ -f "$simulator_archive" ] || {
    echo "missing iOS simulator dependency archive for $dependency: $simulator_archive" >&2
    exit 1
  }
  [ -f "$device_archive" ] || {
    echo "missing iOS device dependency archive for $dependency: $device_archive" >&2
    exit 1
  }
}

xcframework_ready() {
  local extension="$1"
  local xcframework
  xcframework="$(xcframework_for "$extension")"
  [ -d "$xcframework" ] || return 1
  [ -f "$xcframework/Info.plist" ] || return 1
  plutil -extract AvailableLibraries raw "$xcframework/Info.plist" >/dev/null 2>&1 || return 1
}

dependency_xcframework_ready() {
  local dependency="$1"
  local xcframework
  xcframework="$(dependency_xcframework_for "$dependency")"
  [ -d "$xcframework" ] || return 1
  [ -f "$xcframework/Info.plist" ] || return 1
  plutil -extract AvailableLibraries raw "$xcframework/Info.plist" >/dev/null 2>&1 || return 1
}

build_extension_xcframework() {
  local extension="$1"
  local stem simulator_archive device_archive xcframework
  stem="$(stem_for_extension "$extension")"
  simulator_archive="$(archive_for "$simulator_out" "$extension" simulator)"
  device_archive="$(archive_for "$device_out" "$extension" device)"
  xcframework="$(xcframework_for "$extension")"
  rm -rf "$out_dir/$stem"
  mkdir -p "$out_dir/$stem"
  xcodebuild -create-xcframework \
    -library "$simulator_archive" -headers "$headers_dir" \
    -library "$device_archive" -headers "$headers_dir" \
    -output "$xcframework" >/dev/null
}

build_dependency_xcframework() {
  local dependency="$1"
  local simulator_archive device_archive xcframework
  simulator_archive="$(dependency_archive_for "$dependency" simulator)"
  device_archive="$(dependency_archive_for "$dependency" device)"
  xcframework="$(dependency_xcframework_for "$dependency")"
  rm -rf "$out_dir/dependencies/$dependency"
  mkdir -p "$out_dir/dependencies/$dependency"
  xcodebuild -create-xcframework \
    -library "$simulator_archive" -headers "$headers_dir" \
    -library "$device_archive" -headers "$headers_dir" \
    -output "$xcframework" >/dev/null
}

write_manifest() {
  {
    printf 'packageLayout=oliphaunt-ios-extension-xcframeworks-v1\n'
    printf 'extensions=%s\n' "$(join_csv ${selected_extensions[@]+"${selected_extensions[@]}"})"
    printf 'nativeModuleStems=%s\n' "$(join_csv ${selected_stems[@]+"${selected_stems[@]}"})"
    printf 'dependencies=%s\n' "$(join_csv ${selected_dependencies[@]+"${selected_dependencies[@]}"})"
    printf 'simulatorOut=%s\n' "$simulator_out"
    printf 'deviceOut=%s\n' "$device_out"
    printf 'runtimeResources=%s\n' "$runtime_resources_dir"
    local extension stem
    for extension in ${selected_extensions[@]+"${selected_extensions[@]}"}; do
      stem="$(stem_for_extension "$extension")"
      printf 'extension.%s.xcframework=%s/liboliphaunt_extension_%s.xcframework\n' "$extension" "$stem" "$stem"
      printf 'extension.%s.simulatorArchive=%s\n' "$extension" "$(archive_for "$simulator_out" "$extension" simulator)"
      printf 'extension.%s.deviceArchive=%s\n' "$extension" "$(archive_for "$device_out" "$extension" device)"
    done
    local dependency
    for dependency in ${selected_dependencies[@]+"${selected_dependencies[@]}"}; do
      printf 'dependency.%s.xcframework=dependencies/%s/liboliphaunt_dependency_%s.xcframework\n' "$dependency" "$dependency" "$dependency"
      printf 'dependency.%s.simulatorArchive=%s\n' "$dependency" "$(dependency_archive_for "$dependency" simulator)"
      printf 'dependency.%s.deviceArchive=%s\n' "$dependency" "$(dependency_archive_for "$dependency" device)"
    done
  } > "$manifest_file"
}

manifest_ready() {
  [ -f "$manifest_file" ] || return 1
  grep -Fx "packageLayout=oliphaunt-ios-extension-xcframeworks-v1" "$manifest_file" >/dev/null || return 1
  grep -Fx "extensions=$(join_csv ${selected_extensions[@]+"${selected_extensions[@]}"})" "$manifest_file" >/dev/null || return 1
  grep -Fx "nativeModuleStems=$(join_csv ${selected_stems[@]+"${selected_stems[@]}"})" "$manifest_file" >/dev/null || return 1
  grep -Fx "dependencies=$(join_csv ${selected_dependencies[@]+"${selected_dependencies[@]}"})" "$manifest_file" >/dev/null || return 1
}

parse_selected_extensions
parse_selected_dependencies
if [ "$mode" = "build" ]; then
  rm -rf "$out_dir"
fi
mkdir -p "$out_dir"

if [ "${#selected_extensions[@]}" -eq 0 ]; then
  case "$mode" in
    build) write_manifest ;;
    check) manifest_ready || {
      echo "iOS extension XCFramework manifest is missing or stale" >&2
      exit 1
    } ;;
  esac
  printf '%s\n' "$out_dir"
  exit 0
fi

for extension in "${selected_extensions[@]}"; do
  require_inputs "$extension"
  case "$mode" in
    check)
      xcframework_ready "$extension" || {
        echo "iOS extension XCFramework for $extension is missing or stale" >&2
        exit 1
      }
      ;;
    build)
      build_extension_xcframework "$extension"
      ;;
  esac
done

for dependency in ${selected_dependencies[@]+"${selected_dependencies[@]}"}; do
  require_dependency_inputs "$dependency"
  case "$mode" in
    check)
      dependency_xcframework_ready "$dependency" || {
        echo "iOS dependency XCFramework for $dependency is missing or stale" >&2
        exit 1
      }
      ;;
    build)
      build_dependency_xcframework "$dependency"
      ;;
  esac
done

case "$mode" in
  check)
    manifest_ready || {
      echo "iOS extension XCFramework manifest is missing or stale" >&2
      exit 1
    }
    ;;
  build)
    write_manifest
    ;;
esac

printf '%s\n' "$out_dir"
