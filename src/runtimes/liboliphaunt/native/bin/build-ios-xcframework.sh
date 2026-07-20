#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$script_dir/common.sh"
. "$script_dir/build-output.bash"
script_path="$script_dir/build-ios-xcframework.sh"
repo_root="$(oliphaunt_resolve_repo_root "$script_dir")"
work_root="${OLIPHAUNT_IOS_XCFRAMEWORK_ROOT:-$repo_root/target/liboliphaunt-ios-xcframework}"
out_dir="$work_root/out"
headers_dir="$work_root/include"
xcframework_out="$out_dir/liboliphaunt.xcframework"
stamp="$work_root/.liboliphaunt-ios-xcframework.sha256"
script_mode="${1:-build}"
runtime_resources_root="${OLIPHAUNT_IOS_RUNTIME_RESOURCES_ROOT:-}"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "liboliphaunt iOS XCFramework build requires Darwin" >&2
  exit 2
fi

for cmd in install_name_tool nm plutil rg shasum xcodebuild xcrun; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "missing required command: $cmd" >&2
    exit 1
  fi
done

simulator_script="$repo_root/src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-simulator.sh"
device_script="$repo_root/src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-device.sh"
macos_script="$repo_root/src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh"
public_header="$repo_root/src/runtimes/liboliphaunt/native/include/oliphaunt.h"
default_macos_library="$repo_root/target/liboliphaunt-pg18/out/liboliphaunt.dylib"
default_simulator_library="$repo_root/target/liboliphaunt-ios-simulator/out/liboliphaunt.dylib"
default_device_library="$repo_root/target/liboliphaunt-ios-device/out/liboliphaunt.dylib"
default_simulator_static_registry="$repo_root/target/liboliphaunt-ios-simulator/out/liboliphaunt_mobile_static_registry.c"
default_device_static_registry="$repo_root/target/liboliphaunt-ios-device/out/liboliphaunt_mobile_static_registry.c"
xcframework_static_registry="$out_dir/liboliphaunt_mobile_static_registry.c"
framework_root="$work_root/frameworks"
macos_framework="$framework_root/macos-arm64/liboliphaunt.framework"
simulator_framework="$framework_root/ios-arm64-simulator/liboliphaunt.framework"
device_framework="$framework_root/ios-arm64/liboliphaunt.framework"

usage() {
  cat >&2 <<'MSG'
usage: src/runtimes/liboliphaunt/native/bin/build-ios-xcframework.sh [--check-current]
MSG
}

desired_hash() {
  {
    printf 'mobile_static_extensions=%s\n' "${OLIPHAUNT_MOBILE_STATIC_EXTENSIONS:-}"
    printf 'runtime_resources_root=%s\n' "$runtime_resources_root"
    printf 'script_sha256=%s\n' "$(shasum -a 256 "$script_path" | awk '{print $1}')"
    shasum -a 256 "$macos_script" "$simulator_script" "$device_script" "$public_header"
  if [ -d "$runtime_resources_root" ]; then
    find "$runtime_resources_root" -type f -print0 | sort -z | xargs -0 shasum -a 256
  fi
  if [ -f "$default_simulator_library" ]; then
    shasum -a 256 "$default_simulator_library"
  fi
  if [ -f "$default_device_library" ]; then
    shasum -a 256 "$default_device_library"
  fi
  if [ -f "$default_macos_library" ]; then
    shasum -a 256 "$default_macos_library"
  fi
  if [ -f "$xcframework_static_registry" ]; then
    shasum -a 256 "$xcframework_static_registry"
  fi
  } | shasum -a 256 | awk '{print $1}'
}

library_platform() {
  xcrun vtool -show-build "$1" 2>/dev/null | awk '/platform /{print $2; exit}'
}

assert_library_slice() {
  local library="$1"
  local expected_platform="$2"
  [ -f "$library" ] || {
    echo "missing liboliphaunt library: $library" >&2
    return 1
  }
  local platform
  platform="$(library_platform "$library")"
  [ "$platform" = "$expected_platform" ] || {
    echo "liboliphaunt library has platform $platform, expected $expected_platform: $library" >&2
    return 1
  }
  local symbols
  symbols="$(nm -g "$library" 2>/dev/null || true)"
  if [ "$expected_platform" != "MACOS" ]; then
    local undefined_symbols
    undefined_symbols="$(nm -u "$library" 2>/dev/null || true)"
    if printf '%s\n' "$undefined_symbols" | rg -q '_shm(get|ctl|dt)|_shm_open|_sem(get|ctl|op|open|close|unlink|wait|post|trywait|init|destroy)'; then
      echo "liboliphaunt library imports mobile-forbidden shared-memory/semaphore APIs: $library" >&2
      return 1
    fi
  fi
  local symbol
  for symbol in \
    _oliphaunt_init \
    _oliphaunt_init_ex \
    _oliphaunt_exec_protocol \
    _oliphaunt_exec_protocol_stream \
    _oliphaunt_backup \
    _oliphaunt_backup_ex \
    _oliphaunt_restore \
    _oliphaunt_cancel \
    _oliphaunt_detach \
    _oliphaunt_close \
    _oliphaunt_register_static_extensions \
    _oliphaunt_last_error \
    _oliphaunt_version \
    _oliphaunt_capabilities \
    _oliphaunt_free_response
  do
    case "$symbols" in
      *"$symbol"*) ;;
      *)
        echo "liboliphaunt library is missing symbol $symbol: $library" >&2
        return 1
        ;;
    esac
  done
}

xcframework_ready() {
  [ -d "$xcframework_out" ] || return 1
  [ -f "$xcframework_out/Info.plist" ] || return 1
  plutil -extract AvailableLibraries raw "$xcframework_out/Info.plist" >/dev/null 2>&1 || return 1

  local ios_library=""
  local simulator_library=""
  local macos_library=""
  while IFS= read -r library; do
    case "$(library_platform "$library")" in
      MACOS) macos_library="$library" ;;
      IOS) ios_library="$library" ;;
      IOSSIMULATOR) simulator_library="$library" ;;
    esac
  done < <(find "$xcframework_out" -type f \( -name 'liboliphaunt.dylib' -o -name 'liboliphaunt' \) ! -path '*/Headers/*' | sort)

  [ -n "$macos_library" ] || return 1
  [ -n "$ios_library" ] || return 1
  [ -n "$simulator_library" ] || return 1
  assert_library_slice "$macos_library" MACOS || return 1
  assert_library_slice "$ios_library" IOS || return 1
  assert_library_slice "$simulator_library" IOSSIMULATOR || return 1
}

write_framework_info_plist() {
  local plist="$1"
  local platform="$2"
  local platform_family="$3"
  if [ "$platform" = "MacOSX" ]; then
    cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>liboliphaunt</string>
  <key>CFBundleIdentifier</key>
  <string>dev.oliphaunt.liboliphaunt</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>liboliphaunt</string>
  <key>CFBundlePackageType</key>
  <string>FMWK</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleSupportedPlatforms</key>
  <array>
    <string>MacOSX</string>
  </array>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>MinimumOSVersion</key>
  <string>14.0</string>
</dict>
</plist>
PLIST
    return
  fi
  cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>liboliphaunt</string>
  <key>CFBundleIdentifier</key>
  <string>dev.oliphaunt.liboliphaunt</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>liboliphaunt</string>
  <key>CFBundlePackageType</key>
  <string>FMWK</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleSupportedPlatforms</key>
  <array>
    <string>${platform}</string>
  </array>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>MinimumOSVersion</key>
  <string>17.0</string>
  <key>UIDeviceFamily</key>
  <array>
    <integer>${platform_family}</integer>
  </array>
</dict>
</plist>
PLIST
}

expected_library_platform_for_framework_platform() {
  case "$1" in
    MacOSX) printf 'MACOS\n' ;;
    iPhoneOS) printf 'IOS\n' ;;
    iPhoneSimulator) printf 'IOSSIMULATOR\n' ;;
    *) echo "unsupported framework platform $1" >&2; return 1 ;;
  esac
}

prepare_framework_slice() {
  local library="$1"
  local framework="$2"
  local platform="$3"
  local platform_family="$4"
  rm -rf "$framework"
  mkdir -p "$framework/Headers" "$framework/Modules"
  cp "$library" "$framework/liboliphaunt"
  install_name_tool -id "@rpath/liboliphaunt.framework/liboliphaunt" "$framework/liboliphaunt"
  rsync -a --delete "$headers_dir/" "$framework/Headers/"
  if [ -n "$runtime_resources_root" ]; then
    [ -d "$runtime_resources_root" ] || {
      echo "OLIPHAUNT_IOS_RUNTIME_RESOURCES_ROOT does not exist: $runtime_resources_root" >&2
      exit 1
    }
    mkdir -p "$framework/Resources/oliphaunt"
    rsync -a --delete "$runtime_resources_root/" "$framework/Resources/oliphaunt/"
  fi
  cat >"$framework/Modules/module.modulemap" <<'MODULEMAP'
framework module liboliphaunt {
  umbrella header "oliphaunt.h"
  export *
  module * { export * }
}
MODULEMAP
  write_framework_info_plist "$framework/Info.plist" "$platform" "$platform_family"
  assert_library_slice "$framework/liboliphaunt" "$(expected_library_platform_for_framework_platform "$platform")"
}

build_xcframework() {
  mkdir -p "$out_dir" "$headers_dir"
  rsync -a --delete "$repo_root/src/runtimes/liboliphaunt/native/include/" "$headers_dir/"

  local macos_library="$default_macos_library"
  if ! "$macos_script" --check-oliphaunt-current >/dev/null 2>&1 ||
    ! assert_library_slice "$macos_library" MACOS >/dev/null 2>&1; then
    macos_library="$(oliphaunt_capture_build_artifact_path \
      "macOS liboliphaunt build" \
      "$work_root/logs/build-macos.log" \
      "$macos_script")"
  fi

  local simulator_library="$default_simulator_library"
  local device_library="$default_device_library"
  if ! OLIPHAUNT_MOBILE_STATIC_EXTENSIONS="${OLIPHAUNT_MOBILE_STATIC_EXTENSIONS:-}" \
       "$simulator_script" --check-current >/dev/null 2>&1 ||
     ! assert_library_slice "$simulator_library" IOSSIMULATOR >/dev/null 2>&1; then
    simulator_library="$(oliphaunt_capture_build_artifact_path \
      "iOS simulator liboliphaunt build" \
      "$work_root/logs/build-ios-simulator.log" \
      env OLIPHAUNT_MOBILE_STATIC_EXTENSIONS="${OLIPHAUNT_MOBILE_STATIC_EXTENSIONS:-}" "$simulator_script")"
  fi
  if ! OLIPHAUNT_MOBILE_STATIC_EXTENSIONS="${OLIPHAUNT_MOBILE_STATIC_EXTENSIONS:-}" \
       "$device_script" --check-current >/dev/null 2>&1 ||
     ! assert_library_slice "$device_library" IOS >/dev/null 2>&1; then
    device_library="$(oliphaunt_capture_build_artifact_path \
      "iOS device liboliphaunt build" \
      "$work_root/logs/build-ios-device.log" \
      env OLIPHAUNT_MOBILE_STATIC_EXTENSIONS="${OLIPHAUNT_MOBILE_STATIC_EXTENSIONS:-}" "$device_script")"
  fi
  assert_library_slice "$macos_library" MACOS
  assert_library_slice "$simulator_library" IOSSIMULATOR
  assert_library_slice "$device_library" IOS
  prepare_framework_slice "$macos_library" "$macos_framework" "MacOSX" "0"
  prepare_framework_slice "$device_library" "$device_framework" "iPhoneOS" "1"
  prepare_framework_slice "$simulator_library" "$simulator_framework" "iPhoneSimulator" "1"

  rm -rf "$xcframework_out"
  xcodebuild -create-xcframework \
    -framework "$macos_framework" \
    -framework "$device_framework" \
    -framework "$simulator_framework" \
    -output "$xcframework_out" >/dev/null

  if [ -f "$default_simulator_static_registry" ] && [ -f "$default_device_static_registry" ]; then
    if ! cmp -s "$default_simulator_static_registry" "$default_device_static_registry"; then
      echo "iOS simulator/device static registry sources differ" >&2
      exit 1
    fi
    cp "$default_simulator_static_registry" "$xcframework_static_registry"
  else
    rm -f "$xcframework_static_registry"
  fi

  xcframework_ready
  desired_hash > "$stamp"
  printf '%s\n' "$xcframework_out"
}

case "$script_mode" in
  build)
    if xcframework_ready && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$(desired_hash)" ]; then
      printf '%s\n' "$xcframework_out"
      exit 0
    fi
    build_xcframework
    ;;
  --check-current)
    if xcframework_ready && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$(desired_hash)" ]; then
      echo "iOS liboliphaunt XCFramework is current"
      exit 0
    fi
    echo "iOS liboliphaunt XCFramework is missing or stale" >&2
    exit 1
    ;;
  *)
    usage
    exit 2
    ;;
esac
