#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "error: $*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

[ -n "${ANDROID_HOME:-}" ] || fail "ANDROID_HOME is not set"

api="${OLIPHAUNT_ANDROID_EMULATOR_API:-${OLIPHAUNT_ANDROID_COMPILE_SDK:-36}}"
name="${OLIPHAUNT_ANDROID_EMULATOR_NAME:-oliphaunt-ci}"
target="${OLIPHAUNT_ANDROID_EMULATOR_TARGET:-google_atd}"
timeout_seconds="${OLIPHAUNT_ANDROID_EMULATOR_TIMEOUT_SECONDS:-900}"
host_arch="$(uname -m)"
case "$host_arch" in
  arm64|aarch64) abi="arm64-v8a" ;;
  x86_64|amd64) abi="x86_64" ;;
  *) fail "unsupported Android emulator host architecture: $host_arch" ;;
esac
image="${OLIPHAUNT_ANDROID_EMULATOR_IMAGE:-system-images;android-${api};${target};${abi}}"

export PATH="$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
need_cmd sdkmanager
need_cmd avdmanager
need_cmd adb

yes | sdkmanager --licenses >/dev/null || true
sdkmanager --install "emulator" "$image"
need_cmd emulator

if ! emulator -list-avds | grep -Fxq "$name"; then
  echo "no" | avdmanager create avd --force --name "$name" --package "$image" --device "pixel_5"
fi

adb kill-server >/dev/null 2>&1 || true
adb start-server >/dev/null

log_dir="${RUNNER_TEMP:-/tmp}"
mkdir -p "$log_dir"
log_file="$log_dir/oliphaunt-android-emulator.log"
echo "Starting Android emulator $name with image $image and ${timeout_seconds}s boot timeout"
emulator -avd "$name" \
  -no-window \
  -no-audio \
  -no-boot-anim \
  -no-snapshot \
  -no-snapshot-load \
  -no-snapshot-save \
  -wipe-data \
  -no-metrics \
  -accel on \
  -gpu swiftshader_indirect \
  >"$log_file" 2>&1 &
emulator_pid="$!"

cleanup_on_error() {
  status=$?
  if [ "$status" -ne 0 ]; then
    tail -200 "$log_file" >&2 || true
    kill "$emulator_pid" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup_on_error EXIT

booted=0
deadline=$((SECONDS + timeout_seconds))
while [ "$SECONDS" -lt "$deadline" ]; do
  if ! kill -0 "$emulator_pid" >/dev/null 2>&1; then
    tail -200 "$log_file" >&2 || true
    fail "Android emulator process exited before boot completed"
  fi
  if ! adb devices | grep -Eq 'device$'; then
    sleep 2
    continue
  fi
  boot_completed="$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
  if [ "$boot_completed" = "1" ]; then
    booted=1
    break
  fi
  sleep 2
done
[ "$booted" = "1" ] || fail "Android emulator did not finish booting within ${timeout_seconds}s"

adb shell input keyevent 82 >/dev/null 2>&1 || true
adb shell settings put global window_animation_scale 0 >/dev/null 2>&1 || true
adb shell settings put global transition_animation_scale 0 >/dev/null 2>&1 || true
adb shell settings put global animator_duration_scale 0 >/dev/null 2>&1 || true

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "abi=$abi"
    echo "avd=$name"
  } >>"$GITHUB_OUTPUT"
fi

echo "Android emulator $name is ready for ABI $abi"
