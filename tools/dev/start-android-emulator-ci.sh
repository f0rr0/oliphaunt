#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "error: $*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

ensure_kvm_access() {
  [ "$abi" = "x86_64" ] || return 0
  [ -e /dev/kvm ] || fail "x86_64 Android emulator requires /dev/kvm on Linux CI"
  [ -r /dev/kvm ] && [ -w /dev/kvm ] && return 0
  need_cmd sudo
  sudo chmod a+rw /dev/kvm ||
    fail "failed to make /dev/kvm readable and writable for Android emulator"
  if [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
    fail "x86_64 Android emulator still cannot access /dev/kvm after permission fix"
  fi
}

[ -n "${ANDROID_HOME:-}" ] || fail "ANDROID_HOME is not set"

api="${OLIPHAUNT_ANDROID_EMULATOR_API:-${OLIPHAUNT_ANDROID_COMPILE_SDK:-36}}"
name="${OLIPHAUNT_ANDROID_EMULATOR_NAME:-oliphaunt-ci}"
target="${OLIPHAUNT_ANDROID_EMULATOR_TARGET:-google_atd}"
timeout_seconds="${OLIPHAUNT_ANDROID_EMULATOR_TIMEOUT_SECONDS:-900}"
partition_size_mb="${OLIPHAUNT_ANDROID_EMULATOR_PARTITION_SIZE_MB:-6144}"
disk_headroom_mb="${OLIPHAUNT_ANDROID_EMULATOR_DISK_HEADROOM_MB:-2048}"
avd_home="${OLIPHAUNT_ANDROID_AVD_HOME:-${ANDROID_AVD_HOME:-${RUNNER_TEMP:-${HOME:-/tmp}}/android-avd}}"
case "$timeout_seconds" in
  ''|*[!0-9]*) fail "OLIPHAUNT_ANDROID_EMULATOR_TIMEOUT_SECONDS must be a positive integer" ;;
esac
[ "$timeout_seconds" -ge 1 ] ||
  fail "OLIPHAUNT_ANDROID_EMULATOR_TIMEOUT_SECONDS must be at least 1"
case "$partition_size_mb" in
  ''|*[!0-9]*) fail "OLIPHAUNT_ANDROID_EMULATOR_PARTITION_SIZE_MB must be an integer" ;;
esac
if [ "$partition_size_mb" -lt 6144 ] || [ "$partition_size_mb" -gt 8192 ]; then
  fail "OLIPHAUNT_ANDROID_EMULATOR_PARTITION_SIZE_MB must be between 6144 and 8192 for modern Android images"
fi
case "$disk_headroom_mb" in
  ''|*[!0-9]*) fail "OLIPHAUNT_ANDROID_EMULATOR_DISK_HEADROOM_MB must be an integer" ;;
esac
if [ "$disk_headroom_mb" -lt 512 ] || [ "$disk_headroom_mb" -gt 16384 ]; then
  fail "OLIPHAUNT_ANDROID_EMULATOR_DISK_HEADROOM_MB must be between 512 and 16384"
fi
host_arch="$(uname -m)"
case "$host_arch" in
  arm64|aarch64) abi="arm64-v8a" ;;
  x86_64|amd64) abi="x86_64" ;;
  *) fail "unsupported Android emulator host architecture: $host_arch" ;;
esac
image="${OLIPHAUNT_ANDROID_EMULATOR_IMAGE:-system-images;android-${api};${target};${abi}}"

export PATH="$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
export ANDROID_AVD_HOME="$avd_home"
need_cmd sdkmanager
need_cmd avdmanager
need_cmd adb
ensure_kvm_access

yes | sdkmanager --licenses >/dev/null || true
sdkmanager --install "emulator" "$image"
need_cmd emulator

mkdir -p "$ANDROID_AVD_HOME"
available_kb="$(df -Pk "$ANDROID_AVD_HOME" | awk 'END { print $4 }')"
case "$available_kb" in
  ''|*[!0-9]*) fail "could not determine available disk space for ANDROID_AVD_HOME=$ANDROID_AVD_HOME" ;;
esac
# Emulator 36.6 applies a 6 GiB floor to API 24+ userdata and requires 120%
# of that size to be free before creating the image. Model that upstream
# check explicitly, then retain independent space for the APK and reports.
emulator_required_mb=$(((partition_size_mb * 6 + 4) / 5))
required_mb=$((emulator_required_mb + disk_headroom_mb))
required_kb=$((required_mb * 1024))
available_mb=$((available_kb / 1024))
echo "Android emulator disk preflight: ${available_mb} MB available; ${required_mb} MB required (${partition_size_mb} MB data partition x 120% emulator reserve + ${disk_headroom_mb} MB job headroom)"
[ "$available_kb" -ge "$required_kb" ] || {
  df -h "$ANDROID_AVD_HOME" >&2 || true
  fail "insufficient Android emulator disk: ${available_mb} MB available, need at least ${required_mb} MB; reclaim runner disk before starting the emulator"
}
if ! emulator -list-avds | grep -Fxq "$name"; then
  echo "no" | avdmanager create avd \
    --force \
    --name "$name" \
    --package "$image" \
    --device "pixel_5" \
    --path "$ANDROID_AVD_HOME/${name}.avd"
fi
emulator -list-avds | grep -Fxq "$name" ||
  fail "Android AVD $name was not visible under ANDROID_AVD_HOME=$ANDROID_AVD_HOME after creation"

adb kill-server >/dev/null 2>&1 || true
adb start-server >/dev/null

log_dir="${RUNNER_TEMP:-/tmp}"
mkdir -p "$log_dir"
log_file="$log_dir/oliphaunt-android-emulator.log"
echo "Starting Android emulator $name with image $image and ${timeout_seconds}s boot timeout"
emulator -avd "$name" \
  -partition-size "$partition_size_mb" \
  -no-window \
  -no-audio \
  -no-boot-anim \
  -no-snapshot \
  -no-snapshot-load \
  -no-snapshot-save \
  -wipe-data \
  -no-cache \
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
