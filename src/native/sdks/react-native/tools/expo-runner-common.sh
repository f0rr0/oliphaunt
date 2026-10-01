#!/usr/bin/env bash

# Shared primitives for the React Native Expo mobile runners. Platform-specific
# packaging, build, and launch logic stays in the platform runner scripts.

run() {
  printf '\n==> %s\n' "$*"
  "$@"
}

fail() {
  echo "error: $*" >&2
  exit 1
}

is_truthy() {
  case "${1:-}" in
    1 | true | TRUE | yes | YES | on | ON)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_falsey() {
  case "${1:-}" in
    0 | false | FALSE | no | NO | off | OFF)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

expo_allows_native_builds() {
  is_truthy "${OLIPHAUNT_EXPO_ALLOW_NATIVE_BUILDS:-1}"
}

expo_requires_sdk_artifacts() {
  is_truthy "${OLIPHAUNT_EXPO_REQUIRE_SDK_ARTIFACTS:-0}"
}

expo_sdk_artifact_product_root() {
  local product="$1"
  local base="${OLIPHAUNT_EXPO_SDK_ARTIFACT_ROOT:-$root/target/sdk-artifacts}"
  printf '%s/%s\n' "$base" "$product"
}

expo_single_sdk_artifact_file() {
  local product="$1"
  local pattern="$2"
  local product_root
  product_root="$(expo_sdk_artifact_product_root "$product")"
  [ -d "$product_root" ] ||
    fail "required SDK artifact directory is missing for $product: $product_root"
  local matches
  matches="$(find "$product_root" -maxdepth 1 -type f -name "$pattern" | LC_ALL=C sort)"
  [ -n "$matches" ] ||
    fail "required SDK artifact for $product did not match $pattern under $product_root"
  local count
  count="$(printf '%s\n' "$matches" | wc -l | tr -d '[:space:]')"
  [ "$count" = "1" ] ||
    fail "required SDK artifact for $product matched $count files under $product_root; expected exactly one $pattern"
  printf '%s\n' "$matches"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

# The app owns SDK assertions. Read only the continuous capture started for this
# launch, and reject failures/dead processes before accepting its receipt.
mobile_log_has_failure() {
  grep -Eq "$failure_tag|Fatal error|FATAL EXCEPTION|terminating with uncaught exception" "$1"
}

wait_for_mobile_receipt() {
  local log_file="$1" capture_pid="$2"
  local deadline=$((SECONDS + timeout_seconds)) logs pass
  while :; do
    logs="$(cat "$log_file")" || return 3
    if mobile_log_has_failure "$log_file"; then tail -20 "$log_file" >&2; return 2; fi
    kill -0 "$capture_pid" 2>/dev/null || return 3
    mobile_app_is_alive || return 4
    pass="$(printf '%s\n' "$logs" | grep -F "$success_tag" | tail -1 || true)"
    if [ -n "$pass" ]; then printf '%s\n' "$pass"; return 0; fi
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 1
  done
}

stop_mobile_log_capture() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 0
  kill -TERM "$pid" 2>/dev/null || true
  local attempts=20
  while kill -0 "$pid" 2>/dev/null && [ "$attempts" -gt 0 ]; do
    sleep 0.1
    attempts=$((attempts - 1))
  done
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

stat_mtime() {
  stat -f '%m' "$1" 2>/dev/null || stat -c '%Y' "$1"
}

directory_bytes() {
  local total=0
  local file size
  while IFS= read -r -d '' file; do
    size="$(wc -c <"$file" | tr -d '[:space:]')"
    total=$((total + size))
  done < <(find "$1" -type f -print0)
  printf '%s\n' "$total"
}

directory_files() {
  find "$1" -type f | wc -l | tr -d '[:space:]'
}

file_bytes() {
  if [ -f "$1" ]; then
    wc -c <"$1" | tr -d '[:space:]'
  else
    printf '0\n'
  fi
}

file_from_offset() {
  local file="$1"
  local offset="$2"
  [ -f "$file" ] || return 0
  tail -c "+$((offset + 1))" "$file" 2>/dev/null || true
}

urlencode() {
  bun "$root/src/native/sdks/react-native/tools/expo-runner-common.mts" urlencode "$1"
}

react_native_package_tarball_name() {
  bun "$root/src/native/sdks/react-native/tools/expo-runner-common.mts" tarball-name "$1/package.json"
}
