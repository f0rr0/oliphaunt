#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

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

Provision a minimal Android SDK for Oliphaunt Android builder jobs.

Options:
  --sdk-root <path>                  Android SDK root. Defaults to ANDROID_HOME,
                                     ANDROID_SDK_ROOT, or $HOME/android-sdk.
  --ndk-version <version>            Android NDK side-by-side version.
  --cmake-version <version>          Android CMake package version.
  --compile-sdk <api-level>          Android platform API level.
  --cmdline-tools-version <version>  Android command-line tools build id.
  --cmdline-tools-url <url>          Override command-line tools zip URL.
  --cmdline-tools-sha1 <hex>         Override command-line tools SHA-1 checksum.
  --cmdline-tools-sha256 <hex>       Optional command-line tools SHA-256 checksum.
  -h, --help                         Show this help.
EOF
}

sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/android-sdk}}"
ndk_version="${ANDROID_NDK_VERSION:-27.0.12077973}"
cmake_version="${ANDROID_CMAKE_VERSION:-3.22.1}"
compile_sdk="${ANDROID_COMPILE_SDK:-36}"
cmdline_tools_version="${ANDROID_CMDLINE_TOOLS_VERSION:-14742923}"
cmdline_tools_url="${ANDROID_CMDLINE_TOOLS_URL:-}"
cmdline_tools_sha1="${ANDROID_CMDLINE_TOOLS_SHA1:-}"
cmdline_tools_sha256="${ANDROID_CMDLINE_TOOLS_SHA256:-}"
sdkmanager_install_attempts="${ANDROID_SDKMANAGER_INSTALL_ATTEMPTS:-4}"
sdkmanager_retry_delay="${ANDROID_SDKMANAGER_RETRY_DELAY:-5}"
tmp_dir=""
trap '[ -z "${tmp_dir:-}" ] || rm -rf "$tmp_dir"' EXIT

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
    --cmdline-tools-version)
      [ "$#" -ge 2 ] || fail "--cmdline-tools-version requires a value"
      cmdline_tools_version="$2"
      shift 2
      ;;
    --cmdline-tools-url)
      [ "$#" -ge 2 ] || fail "--cmdline-tools-url requires a value"
      cmdline_tools_url="$2"
      shift 2
      ;;
    --cmdline-tools-sha1)
      [ "$#" -ge 2 ] || fail "--cmdline-tools-sha1 requires a value"
      cmdline_tools_sha1="$2"
      shift 2
      ;;
    --cmdline-tools-sha256)
      [ "$#" -ge 2 ] || fail "--cmdline-tools-sha256 requires a value"
      cmdline_tools_sha256="$2"
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
[ -n "$ndk_version" ] || fail "Android NDK version is empty"
[ -n "$cmake_version" ] || fail "Android CMake version is empty"
[ -n "$compile_sdk" ] || fail "Android compile SDK is empty"

case "$compile_sdk" in
  *[!0-9]* | "") fail "compile SDK must be a numeric API level, got: $compile_sdk" ;;
esac
case "$sdkmanager_install_attempts" in
  *[!0-9]* | "") fail "ANDROID_SDKMANAGER_INSTALL_ATTEMPTS must be a positive integer, got: $sdkmanager_install_attempts" ;;
esac
case "$sdkmanager_retry_delay" in
  *[!0-9]* | "") fail "ANDROID_SDKMANAGER_RETRY_DELAY must be a non-negative integer, got: $sdkmanager_retry_delay" ;;
esac
[ "$sdkmanager_install_attempts" -ge 1 ] ||
  fail "ANDROID_SDKMANAGER_INSTALL_ATTEMPTS must be at least 1"

os_name="$(uname -s)"
case "$os_name" in
  Linux)
    host_tag="linux"
    default_cmdline_tools_sha1="48833c34b761c10cb20bcd16582129395d121b27"
    ;;
  Darwin)
    host_tag="mac"
    default_cmdline_tools_sha1="cc27cca4b84bfdbc7df17e3d0a01d0c640d8ee71"
    ;;
  *)
    fail "unsupported host OS for Android SDK bootstrap: $os_name"
    ;;
esac

if [ -z "$cmdline_tools_url" ]; then
  cmdline_tools_url="https://dl.google.com/android/repository/commandlinetools-${host_tag}-${cmdline_tools_version}_latest.zip"
fi
cmdline_tools_urls="$cmdline_tools_url"
if [ "${ANDROID_CMDLINE_TOOLS_URL:-}" = "" ]; then
  cmdline_tools_urls="$cmdline_tools_urls https://edgedl.me.gvt1.com/edgedl/android/repository/commandlinetools-${host_tag}-${cmdline_tools_version}_latest.zip"
fi
if [ -z "$cmdline_tools_sha1" ]; then
  cmdline_tools_sha1="$default_cmdline_tools_sha1"
fi

hash_file() {
  local algorithm="$1"
  local path="$2"
  case "$algorithm" in
    sha1)
      if command -v sha1sum >/dev/null 2>&1; then
        sha1sum "$path" | awk '{ print $1 }'
      elif command -v shasum >/dev/null 2>&1; then
        shasum -a 1 "$path" | awk '{ print $1 }'
      elif command -v openssl >/dev/null 2>&1; then
        openssl dgst -sha1 "$path" | awk '{ print $NF }'
      else
        fail "cannot verify SHA-1 checksum; install sha1sum, shasum, or openssl"
      fi
      ;;
    sha256)
      if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$path" | awk '{ print $1 }'
      elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$path" | awk '{ print $1 }'
      elif command -v openssl >/dev/null 2>&1; then
        openssl dgst -sha256 "$path" | awk '{ print $NF }'
      else
        fail "cannot verify SHA-256 checksum; install sha256sum, shasum, or openssl"
      fi
      ;;
    *) fail "unsupported checksum algorithm: $algorithm" ;;
  esac
}

verify_checksum() {
  local algorithm="$1"
  local expected="$2"
  local path="$3"
  [ -n "$expected" ] || return 0
  local actual
  actual="$(hash_file "$algorithm" "$path")"
  if [ "$actual" != "$expected" ]; then
    fail "Android command-line tools $algorithm mismatch for $path: expected $expected, got $actual"
  fi
}

install_cmdline_tools() {
  require curl
  require unzip

  local archive extracted_tools url downloaded
  tmp_dir="$(mktemp -d)"
  archive="$tmp_dir/commandline-tools.zip"

  downloaded=0
  for url in $cmdline_tools_urls; do
    echo "Downloading Android command-line tools: $url"
    if curl -L --fail --retry 3 --retry-delay 2 --output "$archive" "$url"; then
      downloaded=1
      break
    fi
  done
  [ "$downloaded" -eq 1 ] || fail "could not download Android command-line tools from configured URLs"

  verify_checksum sha1 "$cmdline_tools_sha1" "$archive"
  verify_checksum sha256 "$cmdline_tools_sha256" "$archive"

  unzip -q "$archive" -d "$tmp_dir/unpacked"
  extracted_tools="$tmp_dir/unpacked/cmdline-tools"
  [ -d "$extracted_tools/bin" ] || fail "Android command-line tools archive did not contain cmdline-tools/bin"

  mkdir -p "$sdk_root/cmdline-tools"
  rm -rf "$sdk_root/cmdline-tools/latest"
  mkdir -p "$sdk_root/cmdline-tools/latest"
  cp -R "$extracted_tools"/. "$sdk_root/cmdline-tools/latest/"
}

cleanup_partial_sdk_packages() {
  rm -rf \
    "$sdk_root/.temp" \
    "$sdk_root/build-tools/${compile_sdk}.0.0" \
    "$sdk_root/cmake/$cmake_version" \
    "$sdk_root/ndk/$ndk_version" \
    "$sdk_root/platforms/android-${compile_sdk}"
}

install_sdk_packages() {
  local attempt
  attempt=1
  while [ "$attempt" -le "$sdkmanager_install_attempts" ]; do
    echo "Installing Android SDK packages into $sdk_root (attempt $attempt/$sdkmanager_install_attempts)"
    if "$sdkmanager_bin" --sdk_root="$sdk_root" --install \
      "platform-tools" \
      "platforms;android-${compile_sdk}" \
      "build-tools;${compile_sdk}.0.0" \
      "cmake;${cmake_version}" \
      "ndk;${ndk_version}"; then
      return 0
    fi
    if [ "$attempt" -eq "$sdkmanager_install_attempts" ]; then
      break
    fi
    echo "Android SDK package install failed; removing partial packages before retry" >&2
    cleanup_partial_sdk_packages
    sleep "$sdkmanager_retry_delay"
    attempt=$((attempt + 1))
  done
  fail "could not install Android SDK packages after $sdkmanager_install_attempts attempts"
}

mkdir -p "$sdk_root"
sdkmanager_bin="$sdk_root/cmdline-tools/latest/bin/sdkmanager"
if [ ! -x "$sdkmanager_bin" ]; then
  install_cmdline_tools
fi
[ -x "$sdkmanager_bin" ] || fail "sdkmanager is not executable at $sdkmanager_bin"

require java
mkdir -p "$HOME/.android"
touch "$HOME/.android/repositories.cfg"

echo "Accepting Android SDK licenses"
yes | "$sdkmanager_bin" --sdk_root="$sdk_root" --licenses >/dev/null || true

install_sdk_packages

[ -d "$sdk_root/ndk/$ndk_version" ] ||
  fail "Android NDK $ndk_version was not installed under $sdk_root/ndk"
[ -d "$sdk_root/cmake/$cmake_version" ] ||
  fail "Android CMake $cmake_version was not installed under $sdk_root/cmake"
[ -x "$sdk_root/platform-tools/adb" ] ||
  fail "Android platform-tools adb was not installed under $sdk_root/platform-tools"

echo "ANDROID_HOME=$sdk_root"
echo "ANDROID_NDK_HOME=$sdk_root/ndk/$ndk_version"
