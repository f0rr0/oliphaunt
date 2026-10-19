#!/usr/bin/env bash

# The full release consumer carries React Native, Expo, and every supported
# native extension. Expo's generated 2 GiB Gradle heap is not enough for D8 to
# merge that application reliably on GitHub-hosted runners. Keep the release
# runner's resource envelope explicit while allowing local and future hosted
# environments to override either limit.

oliphaunt_android_gradle_jvmargs() {
  local value="${OLIPHAUNT_EXPO_ANDROID_GRADLE_JVMARGS:--Xmx6g -XX:MaxMetaspaceSize=1536m -Dfile.encoding=UTF-8}"
  case "$value" in
    *$'\n'*|*$'\r'*)
      fail "OLIPHAUNT_EXPO_ANDROID_GRADLE_JVMARGS must be a single line"
      ;;
  esac
  printf '%s\n' "$value"
}

oliphaunt_android_gradle_max_workers() {
  local value="${OLIPHAUNT_EXPO_ANDROID_GRADLE_MAX_WORKERS:-2}"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    fail "OLIPHAUNT_EXPO_ANDROID_GRADLE_MAX_WORKERS must be a positive integer"
  fi
  printf '%s\n' "$value"
}
