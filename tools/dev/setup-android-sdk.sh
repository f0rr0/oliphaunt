#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "setup-android-sdk.sh: $*" >&2
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

usage() {
  cat <<'EOF'
usage: tools/dev/setup-android-sdk.sh [options]

Provision the manifest-pinned Android SDK required by Oliphaunt Android jobs.

Options:
  --sdk-root <path>          Android SDK root. Defaults to ANDROID_HOME,
                             ANDROID_SDK_ROOT, or $HOME/android-sdk.
  --ndk-version <version>    Must match the authoritative toolchain manifest.
  --cmake-version <version>  Must match the authoritative toolchain manifest.
  --compile-sdk <api-level>  Must match the authoritative toolchain manifest.
  -h, --help                 Show this help.

The command-line-tools URLs and SHA-256 checksums are intentionally not
overridable. Update src/sources/toolchains/android-sdk.toml to change them.
EOF
}

root="$(git rev-parse --show-toplevel 2>/dev/null)" ||
  fail "must run inside the Oliphaunt git checkout"
cd "$root"

manifest="${OLIPHAUNT_ANDROID_TOOLCHAIN_MANIFEST:-$root/src/sources/toolchains/android-sdk.toml}"
extractor="${OLIPHAUNT_ANDROID_ZIP_EXTRACTOR:-$root/tools/dev/extract-pinned-zip.sh}"
curl_bin="${OLIPHAUNT_ANDROID_CURL:-curl}"
[ -f "$manifest" ] || fail "missing Android toolchain manifest: $manifest"
[ -x "$extractor" ] || fail "missing executable pinned ZIP extractor: $extractor"

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

manifest_package() {
  manifest_value packages "$1" ||
    fail "$manifest must contain exactly one quoted packages.$1 value"
}

pinned_cmdline_build="$(manifest_package command_line_tools_build)"
pinned_cmdline_revision="$(manifest_package command_line_tools_revision)"
pinned_ndk="$(manifest_package ndk)"
pinned_cmake="$(manifest_package cmake)"
pinned_compile_sdk="$(manifest_package compile_sdk)"
pinned_build_tools="$(manifest_package build_tools)"

sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/android-sdk}}"
ndk_version="$pinned_ndk"
cmake_version="$pinned_cmake"
compile_sdk="$pinned_compile_sdk"
sdkmanager_install_attempts="${ANDROID_SDKMANAGER_INSTALL_ATTEMPTS:-4}"
sdkmanager_retry_delay="${ANDROID_SDKMANAGER_RETRY_DELAY:-5}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --sdk-root)
      [ "$#" -ge 2 ] || fail "--sdk-root requires a value"
      sdk_root="$2"
      shift 2
      ;;
    --ndk-version)
      [ "$#" -ge 2 ] || fail "--ndk-version requires a value"
      ndk_version="$2"
      shift 2
      ;;
    --cmake-version)
      [ "$#" -ge 2 ] || fail "--cmake-version requires a value"
      cmake_version="$2"
      shift 2
      ;;
    --compile-sdk)
      [ "$#" -ge 2 ] || fail "--compile-sdk requires a value"
      compile_sdk="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

[ -n "$sdk_root" ] || fail "Android SDK root is empty"
case "$sdk_root" in /|.|..) fail "unsafe Android SDK root: $sdk_root" ;; esac
[ "$ndk_version" = "$pinned_ndk" ] ||
  fail "requested NDK $ndk_version does not match manifest pin $pinned_ndk"
[ "$cmake_version" = "$pinned_cmake" ] ||
  fail "requested CMake $cmake_version does not match manifest pin $pinned_cmake"
[ "$compile_sdk" = "$pinned_compile_sdk" ] ||
  fail "requested compile SDK $compile_sdk does not match manifest pin $pinned_compile_sdk"
case "$pinned_compile_sdk" in
  *[!0-9]*|'') fail "manifest compile SDK must be numeric, got: $pinned_compile_sdk" ;;
esac
case "$pinned_cmdline_build" in *[!0-9]*|'') fail "command-line-tools build pin must be numeric" ;; esac
for dotted_pin in "$pinned_cmdline_revision" "$pinned_ndk" "$pinned_cmake" "$pinned_build_tools"; do
  case "$dotted_pin" in
    ''|.*|*.|*..*|*[!0-9.]*) fail "Android version pins must be non-empty dot-separated numbers" ;;
  esac
done
case "$sdkmanager_install_attempts" in
  *[!0-9]*|'') fail "ANDROID_SDKMANAGER_INSTALL_ATTEMPTS must be a positive integer" ;;
esac
case "$sdkmanager_retry_delay" in
  *[!0-9]*|'') fail "ANDROID_SDKMANAGER_RETRY_DELAY must be a non-negative integer" ;;
esac
[ "$sdkmanager_install_attempts" -ge 1 ] ||
  fail "ANDROID_SDKMANAGER_INSTALL_ATTEMPTS must be at least 1"
[ "$sdkmanager_install_attempts" -le 8 ] ||
  fail "ANDROID_SDKMANAGER_INSTALL_ATTEMPTS must be at most 8"
[ "$sdkmanager_retry_delay" -le 60 ] ||
  fail "ANDROID_SDKMANAGER_RETRY_DELAY must be at most 60 seconds"

case "$(uname -s)" in
  Linux) host_tag="linux" ;;
  Darwin) host_tag="mac" ;;
  *) fail "unsupported host OS for Android SDK bootstrap: $(uname -s)" ;;
esac
asset="commandlinetools-${host_tag}-${pinned_cmdline_build}_latest.zip"
section="command_line_tools.$host_tag"
cmdline_url="$(manifest_value "$section" url)" || fail "$manifest is missing $section.url"
cmdline_mirror_url="$(manifest_value "$section" mirror_url)" || fail "$manifest is missing $section.mirror_url"
cmdline_sha256="$(manifest_value "$section" sha256)" || fail "$manifest is missing $section.sha256"
cmdline_entry_count="$(manifest_value "$section" entry_count)" || fail "$manifest is missing $section.entry_count"
expected_url="https://dl.google.com/android/repository/$asset"
expected_mirror_url="https://edgedl.me.gvt1.com/edgedl/android/repository/$asset"
[ "$cmdline_url" = "$expected_url" ] || fail "$manifest $section.url must be $expected_url"
[ "$cmdline_mirror_url" = "$expected_mirror_url" ] ||
  fail "$manifest $section.mirror_url must be $expected_mirror_url"
[ "${#cmdline_sha256}" -eq 64 ] && [[ ! "$cmdline_sha256" =~ [^0-9a-f] ]] ||
  fail "$manifest $section.sha256 must be 64 lowercase hexadecimal characters"
case "$cmdline_entry_count" in
  *[!0-9]*|'') fail "$manifest $section.entry_count must be numeric" ;;
esac

require java
require mktemp
command -v "$curl_bin" >/dev/null 2>&1 || fail "missing required command: $curl_bin"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "sha256sum or shasum is required"
  fi
}

property_value() {
  local path="$1"
  local key="$2"
  [ -f "$path" ] && [ ! -L "$path" ] || return 1
  awk -F= -v wanted="$key" '
    {
      key=$1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
    }
    key == wanted {
      count++
      value=substr($0, index($0, "=") + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
    }
    END { if (count != 1 || value == "") exit 1; print value }
  ' "$path"
}

sdkmanager_version() {
  local binary="$1"
  local output
  [ -f "$binary" ] && [ ! -L "$binary" ] && [ -x "$binary" ] || return 1
  output="$("$binary" --sdk_root="$sdk_root" --version 2>/dev/null)" || return 1
  printf '%s\n' "$output" | awk '
    {
      sub(/\r$/, "")
      gsub(/^[[:space:]]+|[[:space:]]+$/, "")
      if ($0 != "") { count++; value=$0 }
    }
    END { if (count != 1) exit 1; print value }
  '
}

cmdline_tools_valid() {
  local directory="$1"
  local revision version
  [ -d "$directory" ] && [ ! -L "$directory" ] || return 1
  revision="$(property_value "$directory/source.properties" Pkg.Revision)" || return 1
  [ "$revision" = "$pinned_cmdline_revision" ] || return 1
  [ -f "$directory/lib/sdkmanager-classpath.jar" ] &&
    [ ! -L "$directory/lib/sdkmanager-classpath.jar" ] || return 1
  [ -f "$directory/bin/avdmanager" ] &&
    [ ! -L "$directory/bin/avdmanager" ] &&
    [ -x "$directory/bin/avdmanager" ] || return 1
  version="$(sdkmanager_version "$directory/bin/sdkmanager")" || return 1
  [ "$version" = "$pinned_cmdline_revision" ]
}

mkdir -p "$sdk_root/cmdline-tools" "$HOME/.android"
touch "$HOME/.android/repositories.cfg"
cmdline_parent="$sdk_root/cmdline-tools"
cmdline_final="$cmdline_parent/latest"

install_cmdline_tools() {
  local archive work staged candidate_url actual downloaded backup old_moved new_promoted status
  umask 077
  archive="$(mktemp "$cmdline_parent/.command-line-tools.archive.XXXXXX")"
  work="$(mktemp -d "$cmdline_parent/.command-line-tools.install.XXXXXX")"
  backup=""
  old_moved=0
  new_promoted=0
  cleanup_cmdline_install() {
    status="$?"
    trap - EXIT HUP INT TERM
    rm -f "$archive"
    rm -rf "$work"
    if [ "$new_promoted" = "1" ]; then
      rm -rf "$cmdline_final"
    fi
    if [ "$old_moved" = "1" ] && [ -n "$backup" ] && [ -e "$backup" ] && [ ! -e "$cmdline_final" ]; then
      mv "$backup" "$cmdline_final" || status=1
    elif [ -n "$backup" ]; then
      rm -rf "$backup"
    fi
    exit "$status"
  }
  trap cleanup_cmdline_install EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  downloaded=0
  for candidate_url in "$cmdline_url" "$cmdline_mirror_url"; do
    rm -f "$archive"
    echo "Downloading pinned Android command-line tools: $candidate_url"
    if "$curl_bin" \
      --fail --location --silent --show-error \
      --proto '=https' --proto-redir '=https' \
      --retry 5 --retry-all-errors --retry-delay 2 --retry-max-time 180 \
      --connect-timeout 20 --max-time 300 --max-filesize 220000000 \
      --remove-on-error --output "$archive" "$candidate_url"; then
      actual="$(sha256_file "$archive")"
      if [ "$actual" = "$cmdline_sha256" ]; then
        downloaded=1
        break
      fi
      echo "Android command-line-tools checksum mismatch from $candidate_url; trying the next pinned origin" >&2
    fi
  done
  [ "$downloaded" = "1" ] ||
    fail "could not download the verified Android command-line-tools $pinned_cmdline_build archive"

  "$extractor" \
    --archive "$archive" \
    --destination "$work/extracted" \
    --prefix cmdline-tools \
    --entry-count "$cmdline_entry_count" \
    --required cmdline-tools/bin/sdkmanager \
    --required cmdline-tools/bin/avdmanager \
    --required cmdline-tools/source.properties \
    --required cmdline-tools/lib/sdkmanager-classpath.jar \
    --executable cmdline-tools/bin/sdkmanager \
    --executable cmdline-tools/bin/avdmanager
  staged="$work/extracted/cmdline-tools"
  cmdline_tools_valid "$staged" ||
    fail "staged Android command-line-tools failed exact revision or executable validation"

  if [ -e "$cmdline_final" ] || [ -L "$cmdline_final" ]; then
    backup="$(mktemp -d "$cmdline_parent/.command-line-tools.backup.XXXXXX")"
    rmdir "$backup"
    mv "$cmdline_final" "$backup"
    old_moved=1
  fi
  if [ "${OLIPHAUNT_ANDROID_TEST_INTERRUPT_AFTER_BACKUP:-0}" = "1" ]; then
    [ "${OLIPHAUNT_ANDROID_TESTING:-0}" = "1" ] ||
      fail "OLIPHAUNT_ANDROID_TEST_INTERRUPT_AFTER_BACKUP requires OLIPHAUNT_ANDROID_TESTING=1"
    kill -TERM "$$"
  fi
  mv "$staged" "$cmdline_final"
  new_promoted=1
  cmdline_tools_valid "$cmdline_final" ||
    fail "promoted Android command-line-tools failed validation"

  new_promoted=0
  if [ "$old_moved" = "1" ]; then
    rm -rf "$backup"
    backup=""
    old_moved=0
  fi
  rm -rf "$work"
  work=""
  rm -f "$archive"
  archive=""
  trap - EXIT HUP INT TERM
}

if ! cmdline_tools_valid "$cmdline_final"; then
  echo "Installing manifest-pinned Android command-line-tools $pinned_cmdline_build ($pinned_cmdline_revision)"
  install_cmdline_tools
fi
cmdline_tools_valid "$cmdline_final" || fail "Android command-line-tools cache is invalid after repair"
sdkmanager_bin="$cmdline_final/bin/sdkmanager"

package_revision_valid() {
  local directory="$1"
  local expected="$2"
  local actual
  [ -d "$directory" ] && [ ! -L "$directory" ] || return 1
  actual="$(property_value "$directory/source.properties" Pkg.Revision)" || return 1
  [ "$actual" = "$expected" ]
}

usable_file() {
  [ -f "$1" ] && [ -s "$1" ]
}

usable_executable() {
  usable_file "$1" && [ -x "$1" ]
}

platform_valid() {
  local directory="$sdk_root/platforms/android-$pinned_compile_sdk"
  local actual
  [ -d "$directory" ] && [ ! -L "$directory" ] || return 1
  actual="$(property_value "$directory/source.properties" AndroidVersion.ApiLevel)" || return 1
  [ "$actual" = "$pinned_compile_sdk" ] && usable_file "$directory/android.jar"
}

platform_tools_valid() {
  [ -d "$sdk_root/platform-tools" ] && [ ! -L "$sdk_root/platform-tools" ] &&
    usable_executable "$sdk_root/platform-tools/adb"
}

build_tools_valid() {
  local directory="$sdk_root/build-tools/$pinned_build_tools"
  package_revision_valid "$directory" "$pinned_build_tools" &&
    usable_executable "$directory/aapt2" &&
    usable_executable "$directory/zipalign" &&
    usable_executable "$directory/apksigner"
}

cmake_valid() {
  local directory="$sdk_root/cmake/$pinned_cmake"
  package_revision_valid "$directory" "$pinned_cmake" &&
    usable_executable "$directory/bin/cmake"
}

ndk_valid() {
  local directory="$sdk_root/ndk/$pinned_ndk"
  local clang count=0
  package_revision_valid "$directory" "$pinned_ndk" || return 1
  for clang in "$directory"/toolchains/llvm/prebuilt/*/bin/clang; do
    [ -e "$clang" ] || continue
    usable_executable "$clang" || return 1
    count=$((count + 1))
  done
  [ "$count" -eq 1 ]
}

sdk_packages_valid() {
  platform_tools_valid &&
    platform_valid &&
    build_tools_valid &&
    cmake_valid &&
    ndk_valid
}

cleanup_invalid_sdk_packages() {
  rm -rf "$sdk_root/.temp"
  platform_tools_valid || rm -rf "$sdk_root/platform-tools"
  platform_valid || rm -rf "$sdk_root/platforms/android-$pinned_compile_sdk"
  build_tools_valid ||
    rm -rf "$sdk_root/build-tools/$pinned_build_tools"
  cmake_valid ||
    rm -rf "$sdk_root/cmake/$pinned_cmake"
  ndk_valid ||
    rm -rf "$sdk_root/ndk/$pinned_ndk"
}

install_sdk_packages() {
  local attempt=1
  while [ "$attempt" -le "$sdkmanager_install_attempts" ]; do
    cleanup_invalid_sdk_packages
    echo "Installing exact Android SDK package identities (attempt $attempt/$sdkmanager_install_attempts)"
    if "$sdkmanager_bin" --sdk_root="$sdk_root" --install \
      "platform-tools" \
      "platforms;android-$pinned_compile_sdk" \
      "build-tools;$pinned_build_tools" \
      "cmake;$pinned_cmake" \
      "ndk;$pinned_ndk" && sdk_packages_valid; then
      return 0
    fi
    if [ "$attempt" -lt "$sdkmanager_install_attempts" ]; then
      echo "Android SDK package install or validation failed; repairing before retry" >&2
      sleep "$sdkmanager_retry_delay"
    fi
    attempt=$((attempt + 1))
  done
  fail "could not install and validate the exact Android SDK packages after $sdkmanager_install_attempts attempts"
}

if ! sdk_packages_valid; then
  echo "Accepting Android SDK licenses"
  yes | "$sdkmanager_bin" --sdk_root="$sdk_root" --licenses >/dev/null || true
  install_sdk_packages
fi
sdk_packages_valid || fail "Android SDK package cache is invalid after repair"

echo "ANDROID_HOME=$sdk_root"
echo "ANDROID_NDK_HOME=$sdk_root/ndk/$pinned_ndk"
