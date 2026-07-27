#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
launcher="$root/tools/dev/start-android-emulator-ci.sh"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-android-emulator-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

sdk="$tmp/sdk"
mock_bin="$tmp/bin"
mkdir -p \
  "$mock_bin" \
  "$sdk/emulator" \
  "$sdk/platform-tools" \
  "$sdk/cmdline-tools/latest/bin" \
  "$tmp/runner-temp"

cat >"$mock_bin/uname" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = "-m" ] || exit 2
printf '%s\n' aarch64
EOF

cat >"$mock_bin/df" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  -Pk)
    printf '%s\n' \
      'Filesystem 1024-blocks Used Available Capacity Mounted on' \
      "mock 40000000 1000000 ${MOCK_DF_AVAILABLE_KB:?} 3% /"
    ;;
  -h)
    printf '%s\n' \
      'Filesystem Size Used Avail Use% Mounted on' \
      'mock 40G 37G 3G 93% /'
    ;;
  *)
    exit 2
    ;;
esac
EOF

cat >"$sdk/cmdline-tools/latest/bin/sdkmanager" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat >"$sdk/cmdline-tools/latest/bin/avdmanager" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
avd_path=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--path" ]; then
    avd_path="${2:?--path requires a value}"
    shift 2
  else
    shift
  fi
done
[ -n "$avd_path" ] || exit 2
mkdir -p "$avd_path"
printf '%s\n' 'disk.dataPartition.size=6G' >"$avd_path/config.ini"
EOF

cat >"$sdk/emulator/emulator" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "-list-avds" ]; then
  [ -d "${ANDROID_AVD_HOME:?}/oliphaunt-ci.avd" ] && printf '%s\n' oliphaunt-ci
  exit 0
fi
printf '%s\n' "$@" >"${MOCK_EMULATOR_ARGS:?}"
sleep 2
EOF

cat >"$sdk/platform-tools/adb" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  kill-server|start-server)
    exit 0
    ;;
  devices)
    printf 'List of devices attached\nemulator-5554\tdevice\n'
    ;;
  shell)
    if [ "${2:-}" = "getprop" ] && [ "${3:-}" = "sys.boot_completed" ]; then
      printf '%s\n' 1
    fi
    ;;
  *)
    exit 2
    ;;
esac
EOF

chmod +x \
  "$mock_bin/uname" \
  "$mock_bin/df" \
  "$sdk/cmdline-tools/latest/bin/sdkmanager" \
  "$sdk/cmdline-tools/latest/bin/avdmanager" \
  "$sdk/emulator/emulator" \
  "$sdk/platform-tools/adb"

run_launcher() {
  PATH="$mock_bin:$PATH" \
    ANDROID_HOME="$sdk" \
    ANDROID_AVD_HOME="$tmp/runner-temp/android-avd" \
    RUNNER_TEMP="$tmp/runner-temp" \
    MOCK_DF_AVAILABLE_KB="${MOCK_DF_AVAILABLE_KB:-12582912}" \
    MOCK_EMULATOR_ARGS="$tmp/emulator.args" \
    bash "$launcher"
}

run_launcher >"$tmp/success.log" 2>&1
grep -Fq '9421 MB required (6144 MB data partition x 120% emulator reserve + 2048 MB job headroom)' "$tmp/success.log"
awk '
  previous == "-partition-size" && $0 == "6144" { partition = 1 }
  $0 == "-no-cache" { no_cache = 1 }
  { previous = $0 }
  END { exit !(partition && no_cache) }
' "$tmp/emulator.args"

if MOCK_DF_AVAILABLE_KB=8388608 run_launcher >"$tmp/low-disk.log" 2>&1; then
  echo "low-disk Android emulator preflight unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'insufficient Android emulator disk: 8192 MB available, need at least 9421 MB' \
  "$tmp/low-disk.log"

if OLIPHAUNT_ANDROID_EMULATOR_PARTITION_SIZE_MB=2048 \
  run_launcher >"$tmp/invalid-partition.log" 2>&1; then
  echo "undersized Android emulator partition unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'OLIPHAUNT_ANDROID_EMULATOR_PARTITION_SIZE_MB must be between 6144 and 8192 for modern Android images' \
  "$tmp/invalid-partition.log"

if OLIPHAUNT_ANDROID_EMULATOR_DISK_HEADROOM_MB=invalid \
  run_launcher >"$tmp/invalid-headroom.log" 2>&1; then
  echo "non-numeric Android emulator headroom unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'OLIPHAUNT_ANDROID_EMULATOR_DISK_HEADROOM_MB must be an integer' \
  "$tmp/invalid-headroom.log"

printf '%s\n' 'start-android-emulator-ci tests passed'
