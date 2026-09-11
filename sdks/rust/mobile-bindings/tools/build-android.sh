#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
: "${ANDROID_NDK_HOME:?Set ANDROID_NDK_HOME to the Android build NDK}"
case "${1:-arm64-v8a}" in
  arm64-v8a) target=aarch64-linux-android; clang_target=aarch64-linux-android ;;
  armeabi-v7a) target=armv7-linux-androideabi; clang_target=armv7a-linux-androideabi ;;
  x86) target=i686-linux-android; clang_target=i686-linux-android ;;
  x86_64) target=x86_64-linux-android; clang_target=x86_64-linux-android ;;
  *) echo "unsupported Android ABI: $1" >&2; exit 2 ;;
esac
compiler_suffix=
tool_suffix=
case "$(uname -s)" in
  Darwin) host=darwin-x86_64 ;;
  Linux) host=linux-x86_64 ;;
  MINGW*|MSYS*|CYGWIN*) host=windows-x86_64; compiler_suffix=.cmd; tool_suffix=.exe ;;
  *) echo "unsupported NDK host: $(uname -s)" >&2; exit 2 ;;
esac
ndk_bin="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/$host/bin"
target_key="${target//-/_}"
linker_key="$(printf '%s' "$target_key" | tr '[:lower:]' '[:upper:]')"
env \
  "CARGO_TARGET_${linker_key}_LINKER=$ndk_bin/${clang_target}${OLIPHAUNT_ANDROID_API:-24}-clang$compiler_suffix" \
  "CC_${target_key}=$ndk_bin/${clang_target}${OLIPHAUNT_ANDROID_API:-24}-clang$compiler_suffix" \
  "CXX_${target_key}=$ndk_bin/${clang_target}${OLIPHAUNT_ANDROID_API:-24}-clang++$compiler_suffix" \
  "AR_${target_key}=$ndk_bin/llvm-ar$tool_suffix" \
  cargo build --locked -p oliphaunt-mobile-bindings --target "$target" --release --lib
if [[ -n "${2:-}" ]]; then
  mkdir -p "$2/${1:-arm64-v8a}"
  cp "${CARGO_TARGET_DIR:-$root/target}/$target/release/liboliphaunt_mobile_bindings.so" "$2/${1:-arm64-v8a}/"
fi
if [[ -n "${3:-}" ]]; then
  case "${1:-arm64-v8a}" in
    arm64-v8a) license_target=android-arm64 ;;
    x86_64) license_target=android-x86_64 ;;
    armeabi-v7a) license_target=android-arm ;;
    x86) license_target=android-x86 ;;
    *) echo "no mobile distribution license inventory for ABI $1" >&2; exit 2 ;;
  esac
  rm -rf -- "$3/oliphaunt-native-bindings/$license_target"
  bash tools/dev/bun.sh tools/packaging/release-notices.mts stage \
    "$3/oliphaunt-native-bindings/$license_target" --profile source-sdk
  bash tools/dev/bun.sh sdks/rust/mobile-bindings/tools/dependency-license-contract.mts stage \
    "$3/oliphaunt-native-bindings/$license_target" --target "$license_target"
fi
