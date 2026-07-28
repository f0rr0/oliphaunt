#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}

. "$root/src/sdks/react-native/tools/expo-runner-common.sh"
. "$root/src/sdks/react-native/tools/expo-android-gradle-limits.sh"

assert_equal() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if [ "$actual" != "$expected" ]; then
    printf '%s: expected %q, got %q\n' "$label" "$expected" "$actual" >&2
    exit 1
  fi
}

assert_source_text() {
  local file="$1"
  local expected="$2"
  local label="$3"
  if ! grep -Fq "$expected" "$file"; then
    printf '%s: expected %q in %s\n' "$label" "$expected" "$file" >&2
    exit 1
  fi
}

unset OLIPHAUNT_EXPO_ANDROID_GRADLE_JVMARGS
unset OLIPHAUNT_EXPO_ANDROID_GRADLE_MAX_WORKERS
assert_equal \
  "-Xmx6g -XX:MaxMetaspaceSize=1536m -Dfile.encoding=UTF-8" \
  "$(oliphaunt_android_gradle_jvmargs)" \
  "default Gradle JVM arguments"
assert_equal "2" "$(oliphaunt_android_gradle_max_workers)" "default Gradle workers"

OLIPHAUNT_EXPO_ANDROID_GRADLE_JVMARGS="-Xmx4g -XX:MaxMetaspaceSize=1g"
OLIPHAUNT_EXPO_ANDROID_GRADLE_MAX_WORKERS="7"
assert_equal \
  "-Xmx4g -XX:MaxMetaspaceSize=1g" \
  "$(oliphaunt_android_gradle_jvmargs)" \
  "overridden Gradle JVM arguments"
assert_equal "7" "$(oliphaunt_android_gradle_max_workers)" "overridden Gradle workers"

if (
  OLIPHAUNT_EXPO_ANDROID_GRADLE_JVMARGS=$'-Xmx4g\n-Dunexpected=true'
  oliphaunt_android_gradle_jvmargs >/dev/null 2>&1
); then
  echo "multiline Gradle JVM arguments must fail closed" >&2
  exit 1
fi
if (
  OLIPHAUNT_EXPO_ANDROID_GRADLE_MAX_WORKERS="0"
  oliphaunt_android_gradle_max_workers >/dev/null 2>&1
); then
  echo "non-positive Gradle worker limits must fail closed" >&2
  exit 1
fi
if (
  OLIPHAUNT_EXPO_ANDROID_GRADLE_MAX_WORKERS="two"
  oliphaunt_android_gradle_max_workers >/dev/null 2>&1
); then
  echo "non-numeric Gradle worker limits must fail closed" >&2
  exit 1
fi

runner="$root/src/sdks/react-native/tools/expo-android-runner.sh"
# shellcheck disable=SC2016 # These are literal source fragments, not shell expressions.
assert_source_text \
  "$runner" \
  '. "$root/src/sdks/react-native/tools/expo-android-gradle-limits.sh"' \
  "Android runner Gradle limits import"
# shellcheck disable=SC2016 # These are literal source fragments, not shell expressions.
assert_source_text \
  "$runner" \
  '"-Dorg.gradle.jvmargs=$gradle_jvmargs"' \
  "Android runner Gradle heap integration"
# shellcheck disable=SC2016 # These are literal source fragments, not shell expressions.
assert_source_text \
  "$runner" \
  '"--max-workers=$gradle_max_workers"' \
  "Android runner Gradle worker integration"

echo "expo-android-gradle-limits.test.sh: defaults, overrides, validation, and runner integration passed"
