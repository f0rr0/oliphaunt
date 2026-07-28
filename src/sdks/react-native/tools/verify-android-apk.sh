#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "verify-android-apk.sh: $*" >&2
  exit 1
}

usage() {
  echo "usage: src/sdks/react-native/tools/verify-android-apk.sh <apk>" >&2
}

[ "$#" -eq 1 ] || {
  usage
  exit 2
}

root="$(git rev-parse --show-toplevel 2>/dev/null)" ||
  fail "must run inside the Oliphaunt git checkout"
manifest="${OLIPHAUNT_ANDROID_TOOLCHAIN_MANIFEST:-$root/src/sources/toolchains/android-sdk.toml}"
if [ ! -f "$manifest" ] || [ -L "$manifest" ]; then
  fail "missing regular Android toolchain manifest: $manifest"
fi

manifest_value() {
  local section="$1"
  local key="$2"
  awk -v wanted_section="$section" -v wanted_key="$key" '
    /^[[:space:]]*\[[^]]+\][[:space:]]*$/ {
      current=$0
      gsub(/^[[:space:]]*\[|\][[:space:]]*$/, "", current)
      next
    }
    current == wanted_section && $0 ~ "^[[:space:]]*" wanted_key "[[:space:]]*=" {
      count++
      line=$0
      sub(/^[^=]*=[[:space:]]*"/, "", line)
      sub(/"[[:space:]]*$/, "", line)
      value=line
    }
    END {
      if (count != 1 || value == "") exit 1
      print value
    }
  ' "$manifest"
}

property_value() {
  local file="$1"
  local key="$2"
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  awk -F= -v wanted="$key" '
    {
      candidate=$1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", candidate)
    }
    candidate == wanted {
      count++
      value=substr($0, index($0, "=") + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
    }
    END { if (count != 1 || value == "") exit 1; print value }
  ' "$file"
}

build_tools_version="$(manifest_value packages build_tools)" ||
  fail "$manifest must contain exactly one quoted packages.build_tools value"
case "$build_tools_version" in
  ''|.*|*.|*..*|*[!0-9.]*)
    fail "manifest build-tools version must be non-empty dot-separated numbers"
    ;;
esac

sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[ -n "$sdk_root" ] || fail "ANDROID_HOME or ANDROID_SDK_ROOT must identify the Android SDK"
[ -d "$sdk_root" ] || fail "Android SDK root does not exist: $sdk_root"
sdk_root="$(cd "$sdk_root" && pwd -P)" || fail "cannot resolve Android SDK root: $sdk_root"

if [ -n "${ANDROID_HOME:-}" ] && [ -n "${ANDROID_SDK_ROOT:-}" ]; then
  [ -d "$ANDROID_HOME" ] || fail "ANDROID_HOME does not exist: $ANDROID_HOME"
  [ -d "$ANDROID_SDK_ROOT" ] || fail "ANDROID_SDK_ROOT does not exist: $ANDROID_SDK_ROOT"
  android_home="$(cd "$ANDROID_HOME" && pwd -P)" || fail "cannot resolve ANDROID_HOME"
  android_sdk_root="$(cd "$ANDROID_SDK_ROOT" && pwd -P)" || fail "cannot resolve ANDROID_SDK_ROOT"
  [ "$android_home" = "$android_sdk_root" ] ||
    fail "ANDROID_HOME and ANDROID_SDK_ROOT resolve to different SDKs"
fi

build_tools_dir="$sdk_root/build-tools/$build_tools_version"
if [ ! -d "$build_tools_dir" ] || [ -L "$build_tools_dir" ]; then
  fail "manifest-pinned Android build-tools directory is missing or a symlink: $build_tools_dir"
fi
installed_revision="$(property_value "$build_tools_dir/source.properties" Pkg.Revision)" ||
  fail "manifest-pinned Android build-tools have invalid source.properties"
[ "$installed_revision" = "$build_tools_version" ] ||
  fail "installed Android build-tools revision $installed_revision does not match manifest pin $build_tools_version"

zipalign="$build_tools_dir/zipalign"
apksigner="$build_tools_dir/apksigner"
for tool in "$zipalign" "$apksigner"; do
  if [ ! -f "$tool" ] || [ -L "$tool" ] || [ ! -s "$tool" ] || [ ! -x "$tool" ]; then
    fail "missing regular executable manifest-pinned Android tool: $tool"
  fi
done

apk="$1"
if [ ! -f "$apk" ] || [ -L "$apk" ] || [ ! -s "$apk" ]; then
  fail "APK must be a non-empty regular file, not a symlink: $apk"
fi
apk_dir="$(cd "$(dirname "$apk")" && pwd -P)" || fail "cannot resolve APK parent directory"
apk="$apk_dir/$(basename "$apk")"

echo "Checking APK alignment with Android build-tools $build_tools_version: $apk"
if ! "$zipalign" -c -P 16 -v 4 "$apk"; then
  fail "manifest-pinned zipalign rejected the APK: $apk"
fi
echo "Checking APK signature with Android build-tools $build_tools_version: $apk"
if ! "$apksigner" verify --verbose "$apk"; then
  fail "manifest-pinned apksigner rejected the APK: $apk"
fi
echo "Verified APK with manifest-pinned zipalign and apksigner: $apk"
