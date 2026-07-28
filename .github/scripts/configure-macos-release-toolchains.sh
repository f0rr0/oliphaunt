#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo 'usage: configure-macos-release-toolchains.sh [--android]' >&2
  exit 2
}

configure_android=false
if [[ $# -gt 1 ]]; then
  usage
fi
if [[ $# -eq 1 ]]; then
  [[ "$1" == --android ]] || usage
  configure_android=true
fi
if [[ "${RUNNER_OS:-}" != macOS ]]; then
  echo 'macOS release toolchain configuration requires a GitHub macOS runner' >&2
  exit 1
fi
: "${GITHUB_ENV:?GitHub must provide GITHUB_ENV}"
: "${GITHUB_PATH:?GitHub must provide GITHUB_PATH}"

java_home_17="${JAVA_HOME_17_arm64:-${JAVA_HOME_17_X64:-}}"
if [[ -z "$java_home_17" || ! -x "$java_home_17/bin/java" ]]; then
  echo 'macOS release runner does not expose a usable Java 17 toolchain' >&2
  exit 1
fi
printf 'JAVA_HOME=%s\n' "$java_home_17" >> "$GITHUB_ENV"
printf '%s\n' "$java_home_17/bin" >> "$GITHUB_PATH"

if [[ "$configure_android" == true ]]; then
  android_home="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
  if [[ -z "$android_home" && -d "$HOME/Library/Android/sdk" ]]; then
    android_home="$HOME/Library/Android/sdk"
  fi
  if [[ -z "$android_home" || ! -d "$android_home" ]]; then
    echo 'macOS release runner does not expose a usable Android SDK' >&2
    exit 1
  fi
  printf 'ANDROID_HOME=%s\n' "$android_home" >> "$GITHUB_ENV"
  printf 'ANDROID_SDK_ROOT=%s\n' "$android_home" >> "$GITHUB_ENV"
fi
