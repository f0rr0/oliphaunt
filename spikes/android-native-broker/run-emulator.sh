#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "android-native-broker: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

root="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "run inside the Oliphaunt checkout"
cd "$root"

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
adb="$ANDROID_HOME/platform-tools/adb"
emulator="$ANDROID_HOME/emulator/emulator"
avd="${OLIPHAUNT_ANDROID_BROKER_AVD:-Pixel_9_API_34_Google_API}"
package="dev.oliphaunt.androidbrokerspike"
strategy="${OLIPHAUNT_ANDROID_BROKER_STRATEGY:-full}"
timeout_seconds="${OLIPHAUNT_ANDROID_BROKER_TIMEOUT_SECONDS:-240}"
runtime_resources="${OLIPHAUNT_ANDROID_BROKER_RUNTIME_RESOURCES_DIR:-$root/target/android-native-broker-spike/runtime-resources}"
native_library="${OLIPHAUNT_ANDROID_BROKER_LIBOLIPHAUNT_SO:-$root/target/android-native-broker-spike/native/out/liboliphaunt.so}"
ndk_version="${OLIPHAUNT_ANDROID_BROKER_NDK_VERSION:-27.0.12077973}"
libcxx_shared=""
for ndk_host in darwin-arm64 darwin-x86_64 linux-x86_64; do
  candidate="$ANDROID_HOME/ndk/$ndk_version/toolchains/llvm/prebuilt/$ndk_host/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so"
  if [ -f "$candidate" ]; then
    libcxx_shared="$candidate"
    break
  fi
done
scratch="$root/target/android-native-broker-spike"
jni_root="$scratch/android-jni"
gradle_build_root="$scratch/gradle-build"
gradle_cxx_root="$scratch/gradle-cxx"
gradle_cache_root="$scratch/gradle-cache"
run_nonce="${OLIPHAUNT_ANDROID_BROKER_RUN_NONCE:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
run_dir="$scratch/runs/$run_nonce"

case "$timeout_seconds" in
  ''|*[!0-9]*) fail "OLIPHAUNT_ANDROID_BROKER_TIMEOUT_SECONDS must be a positive integer" ;;
esac
[ "$timeout_seconds" -gt 0 ] || fail "timeout must be positive"
[ -d "$runtime_resources/oliphaunt/runtime/files" ] ||
  fail "prepared runtime resources are missing: $runtime_resources"
[ -f "$runtime_resources/oliphaunt/template-pgdata/files/PG_VERSION" ] ||
  fail "prepared template PGDATA is missing under $runtime_resources"
[ -f "$native_library" ] || fail "prepared Android liboliphaunt is missing: $native_library"
[ -n "$libcxx_shared" ] || fail "Android NDK libc++_shared.so is missing for NDK $ndk_version"
[ -x "$adb" ] || fail "adb is missing: $adb"
[ -x "$emulator" ] || fail "emulator is missing: $emulator"
need git
need python3
need shasum

mkdir -p "$run_dir" "$jni_root/jniLibs/arm64-v8a"

# Bind retained evidence to the exact dirty-tree inputs used for this spike.
# The APK/native-library hashes below identify outputs; this manifest identifies
# the source bytes that produced the Android host and exercised native ABI.
source_scope=(
  spikes/android-native-broker
  src/sdks/kotlin/build.gradle.kts
  src/sdks/kotlin/gradle/libs.versions.toml
  src/sdks/kotlin/settings.gradle.kts
  src/sdks/kotlin/oliphaunt/src
  src/runtimes/liboliphaunt/native/src/liboliphaunt_native.c
)
git rev-parse HEAD >"$run_dir/source-head.txt"
git status --short --untracked-files=all -- "${source_scope[@]}" \
  >"$run_dir/source-status.txt"
git ls-files --cached --others --exclude-standard -- "${source_scope[@]}" \
  | LC_ALL=C sort -u \
  | while IFS= read -r source_path; do
      [ -f "$source_path" ] && shasum -a 256 "$source_path"
    done \
  >"$run_dir/source-files.sha256"

native_out_dir="$(cd "$(dirname "$native_library")" && pwd)"
[ "$(basename "$native_out_dir")" = out ] ||
  fail "liboliphaunt must be the canonical out/liboliphaunt.so artifact"
native_work_root="$(dirname "$native_out_dir")"
ANDROID_NDK_HOME="$ANDROID_HOME/ndk/$ndk_version" \
  ANDROID_NDK_ROOT="$ANDROID_HOME/ndk/$ndk_version" \
  OLIPHAUNT_ANDROID_WORK_ROOT="$native_work_root" \
  src/runtimes/liboliphaunt/native/bin/build-postgres18-android-arm64.sh \
  --check-current \
  | tee "$run_dir/native-current.log"

install -m 0644 "$native_library" "$jni_root/jniLibs/arm64-v8a/liboliphaunt.so"
install -m 0644 "$libcxx_shared" "$jni_root/jniLibs/arm64-v8a/libc++_shared.so"
shasum -a 256 "$native_library" "$libcxx_shared" >"$run_dir/native-libraries.sha256"

echo "==> Build Android broker spike"
src/sdks/kotlin/gradlew -p src/sdks/kotlin \
  :android-native-broker-spike:assembleDebug \
  -PoliphauntRuntimeResourcesDir="$runtime_resources" \
  -PoliphauntAndroidJniLibsDir="$jni_root" \
  -PoliphauntAndroidAbiFilters=arm64-v8a \
  -PoliphauntMobileStaticModules= \
  -PoliphauntBuildRoot="$gradle_build_root" \
  -PoliphauntCxxBuildRoot="$gradle_cxx_root" \
  --project-cache-dir "$gradle_cache_root" \
  --no-configuration-cache \
  | tee "$run_dir/gradle-build.log"

apk="$gradle_build_root/android-native-broker-spike/outputs/apk/debug/android-native-broker-spike-debug.apk"
[ -f "$apk" ] || fail "Gradle did not produce the expected APK: $apk"
shasum -a 256 "$apk" >"$run_dir/apk.sha256"

owned_emulator=0
serial="${ANDROID_SERIAL:-}"
cleanup() {
  status=$?
  if [ "$owned_emulator" -eq 1 ] && [ -n "$serial" ]; then
    "$adb" -s "$serial" emu kill >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

"$adb" start-server >/dev/null
if [ -z "$serial" ]; then
  serial="$($adb devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')"
fi
if [ -z "$serial" ]; then
  "$emulator" -list-avds | grep -Fxq "$avd" || fail "Android AVD is unavailable: $avd"
  echo "==> Start $avd"
  "$emulator" \
    -avd "$avd" \
    -no-window \
    -no-audio \
    -no-boot-anim \
    -no-snapshot-load \
    -no-snapshot-save \
    -no-metrics \
    -gpu swiftshader_indirect \
    >"$run_dir/emulator.log" 2>&1 &
  owned_emulator=1
  deadline=$((SECONDS + timeout_seconds))
  while [ "$SECONDS" -lt "$deadline" ]; do
    serial="$($adb devices | awk 'NR > 1 && $2 == "device" && $1 ~ /^emulator-/ { print $1; exit }')"
    [ -n "$serial" ] && break
    sleep 2
  done
  [ -n "$serial" ] || fail "emulator did not appear in adb within ${timeout_seconds}s"
fi

deadline=$((SECONDS + timeout_seconds))
while [ "$SECONDS" -lt "$deadline" ]; do
  [ "$($adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && break
  sleep 2
done
[ "$($adb -s "$serial" shell getprop sys.boot_completed | tr -d '\r')" = 1 ] ||
  fail "Android target did not finish booting"

api="$($adb -s "$serial" shell getprop ro.build.version.sdk | tr -d '\r')"
abi="$($adb -s "$serial" shell getprop ro.product.cpu.abi | tr -d '\r')"
qemu="$($adb -s "$serial" shell getprop ro.boot.qemu | tr -d '\r')"
[ "$api" = 34 ] || fail "expected API 34, got $api"
[ "$abi" = arm64-v8a ] || fail "expected arm64-v8a, got $abi"
[ "$qemu" = 1 ] || fail "target is not an Android emulator"
printf 'serial=%s\napi=%s\nabi=%s\navd=%s\n' "$serial" "$api" "$abi" "$avd" >"$run_dir/device.txt"

echo "==> Install and run strategy=$strategy nonce=$run_nonce"
"$adb" -s "$serial" install -r -t "$apk" | tee "$run_dir/install.log"
"$adb" -s "$serial" shell am force-stop "$package" >/dev/null 2>&1 || true
"$adb" -s "$serial" shell pm clear "$package" | tee "$run_dir/pm-clear.log"
"$adb" -s "$serial" logcat -c
"$adb" -s "$serial" shell am start -W \
  -n "$package/.MainActivity" \
  --es runNonce "$run_nonce" \
  --es strategy "$strategy" \
  | tee "$run_dir/launch.log"

report="$run_dir/android-broker-report.json"
deadline=$((SECONDS + timeout_seconds))
while [ "$SECONDS" -lt "$deadline" ]; do
  if "$adb" -s "$serial" exec-out run-as "$package" \
    cat files/android-broker-report.json >"$report.candidate" 2>/dev/null; then
    if [ -s "$report.candidate" ] && python3 - "$report.candidate" "$run_nonce" 2>/dev/null <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    report = json.load(source)
if report.get("runNonce") != sys.argv[2]:
    raise SystemExit(1)
PY
    then
      mv "$report.candidate" "$report"
      break
    fi
  fi
  sleep 1
done
[ -s "$report" ] || fail "fixture did not publish a report within ${timeout_seconds}s"

"$adb" -s "$serial" shell ps -A -o USER,PID,PPID,NAME,ARGS >"$run_dir/processes.txt" 2>&1 || true
"$adb" -s "$serial" shell pidof "$package" >"$run_dir/host-pid.txt" 2>&1 || true
"$adb" -s "$serial" shell pidof "$package:broker" >"$run_dir/broker-pid.txt" 2>&1 || true
"$adb" -s "$serial" shell dumpsys activity services "$package" >"$run_dir/services.txt" 2>&1 || true
"$adb" -s "$serial" shell dumpsys meminfo "$package:broker" >"$run_dir/broker-meminfo.txt" 2>&1 || true
"$adb" -s "$serial" logcat -d -v epoch >"$run_dir/logcat.txt" 2>&1 || true
"$adb" -s "$serial" logcat -b crash -d -v epoch >"$run_dir/crash-logcat.txt" 2>&1 || true
"$adb" -s "$serial" shell dumpsys dropbox --print SYSTEM_TOMBSTONE >"$run_dir/dropbox-tombstones.txt" 2>&1 || true

python3 - "$report" "$strategy" "$run_dir/processes.txt" "$run_dir/crash-logcat.txt" <<'PY'
import json
import re
import sys

report_path, strategy, process_path, crash_path = sys.argv[1:]
with open(report_path, encoding="utf-8") as source:
    report = json.load(source)

def require(condition, message):
    if not condition:
        raise SystemExit(f"report validation failed: {message}")

require(report.get("status") == "PASS", report.get("error", "status is not PASS"))
require(report.get("strategy") == strategy, "strategy mismatch")
checks = set(report.get("checks", []))
required = {
    "separateProcess",
    "healthySql",
    "outOfBandCancel",
    "executorDeadlockFailStop",
    "nativePgSleepFailStop",
    "binderDeath",
    "freshPidAndEpoch",
    "outcomeUnknownNoReplay",
    "boundedSlowReader8MiB",
    "boundedSlowReader32MiB",
    "persistentRecovery",
}
require(required <= checks, f"missing checks: {sorted(required - checks)}")
host_pid = int(report["hostPid"])
worker_pids = [int(value) for value in report.get("workerPids", [])]
epochs = report.get("workerEpochs", [])
require(len(worker_pids) >= 3 and len(set(worker_pids)) == len(worker_pids), "worker PIDs are not fresh")
require(all(pid != host_pid for pid in worker_pids), "worker reused host PID")
require(len(epochs) == len(worker_pids) and len(set(epochs)) == len(epochs), "worker epochs are not fresh")
require(report.get("persistentMarkerSurvived") is True, "persistent marker did not survive")
ambiguous_execution_count = report.get("ambiguousExecutionCount")
require(ambiguous_execution_count == 1,
        "ambiguous counter did not record exactly one execution")
require(report.get("replayCount") == ambiguous_execution_count - 1,
        "replayCount was not derived from the ambiguous execution counter")
require(report.get("replayCount") == 0, "a faulted request was replayed")
faults = report.get("faultEvidence", [])
require([item.get("label") for item in faults] == [
    "executorDeadlock", "nativePgSleep", "afterCommitBeforeCompleted"
], "fault evidence labels are incomplete or out of order")
for index, item in enumerate(faults):
    require(item.get("initialWorkerPid") == worker_pids[index], "fault initial PID mismatch")
    require(item.get("recoveredWorkerPid") == worker_pids[index + 1], "fault recovered PID mismatch")
    require(item.get("initialEpoch") == epochs[index], "fault initial epoch mismatch")
    require(item.get("recoveredEpoch") == epochs[index + 1], "fault recovered epoch mismatch")
    require(item.get("terminal") == "outcomeUnknown", "fault terminal is not outcomeUnknown")
require([item.get("nativeDispatchObserved") for item in faults] == [False, True, False],
        "native-dispatch evidence does not match executor/native/after-commit lanes")
require([item.get("nativePostgresOutputWitnessObserved") for item in faults] ==
        [False, True, False],
        "native PostgreSQL-output witness must be present only for the native pg_sleep lane")
native_output_witness = faults[1]
require(native_output_witness.get("nativePostgresOutputWitnessRequestId") ==
        native_output_witness.get("requestId"),
        "native PostgreSQL-output witness request does not match the faulted request")
require(native_output_witness.get("nativePostgresOutputWitnessBackendBytes", 0) >
        4 * 1024 * 1024,
        "native PostgreSQL-output witness did not exceed 4 MiB of backend bytes")
require(native_output_witness.get("nativePostgresOutputWitnessElapsedRealtimeNanos", 0) > 0,
        "native PostgreSQL-output witness monotonic timestamp is missing")
require(native_output_witness.get("nativePostgresOutputWatchdogDelayMilliseconds") == 2000,
        "native PostgreSQL-output watchdog delay is not two seconds")
for item in (faults[0], faults[2]):
    require("nativePostgresOutputWitnessRequestId" not in item and
            "nativePostgresOutputWitnessBackendBytes" not in item and
            "nativePostgresOutputWitnessElapsedRealtimeNanos" not in item and
            "nativePostgresOutputWatchdogDelayMilliseconds" not in item,
            "non-native fault unexpectedly published a native PostgreSQL-output marker")
require(all(item.get("binderDeathObserved") is True for item in faults),
        "Binder death was not observed for every fail-stop")
slow8 = report.get("slowReader8MiB", {})
slow32 = report.get("slowReader32MiB", {})
require(slow8.get("responseBytes", 0) >= 8 * 1024 * 1024, "8 MiB stream is undersized")
require(slow32.get("responseBytes", 0) >= 32 * 1024 * 1024, "32 MiB stream is undersized")
require(slow8.get("responseChunks", 0) > 1 and slow32.get("responseChunks", 0) > 1,
        "slow-reader streams were not chunked")
require(slow8.get("sampleCount", 0) > 0 and slow32.get("sampleCount", 0) > 0,
        "slow-reader memory was not sampled")
maximum_encoded_frame_bytes = 40 + 256 * 1024
for label, expected_bytes, result in (
    ("8 MiB", 8 * 1024 * 1024, slow8),
    ("32 MiB", 32 * 1024 * 1024, slow32),
):
    pss_span = result["maximumPssBytes"] - result["minimumPssBytes"]
    rss_span = result["maximumRssBytes"] - result["minimumRssBytes"]
    require(pss_span >= 0 and result.get("pssSpanBytes") == pss_span,
            f"{label} PSS span is missing or inconsistent")
    require(rss_span >= 0 and result.get("rssSpanBytes") == rss_span,
            f"{label} RSS span is missing or inconsistent")
    require(result.get("requestedSocketSendBufferBytes") == 512 * 1024,
            f"{label} requested socket send buffer is not 512 KiB")
    require(result.get("readReleaseMode") == "hostControlledGate",
            f"{label} did not use the host-controlled read gate")
    require(result.get("readGateReleasedAfterSecondSample") is True,
            f"{label} read gate was not released after the second sample")
    read_gate_created = result.get("readGateCreatedElapsedRealtimeNanos", 0)
    read_gate_released = result.get("readGateReleasedElapsedRealtimeNanos", 0)
    require(read_gate_created > 0 and
            read_gate_released >= result.get("secondSampleElapsedRealtimeNanos", 0),
            f"{label} read-gate timestamps do not cover the second sample")
    require(result.get("readGateHeldMilliseconds") ==
            (read_gate_released - read_gate_created) // 1000 // 1000,
            f"{label} read-gate duration is inconsistent")
    require(result.get("readGateHeldMilliseconds", 0) >= 300,
            f"{label} read gate was not held for the required stall")
    require(result.get("stableStallSearchTimeoutMilliseconds") == 10000,
            f"{label} stable-stall search timeout is not 10 seconds")
    require(result.get("stableStallPollIntervalMilliseconds") == 10,
            f"{label} stable-stall poll interval is not 10 ms")
    require(result.get("transientStallCandidatesRejected", -1) >= 0,
            f"{label} transient stall rejection count is missing")
    require(result.get("slowReaderDrainTimeoutMilliseconds") == 30000,
            f"{label} slow-reader drain timeout is not 30 seconds")
    require(result.get("requiredStallMilliseconds") == 300,
            f"{label} did not require a 300 ms sustained stall")
    require(result.get("observedSameWriteStallMilliseconds", 0) >= 300,
            f"{label} did not observe a 300 ms same-write stall")
    require(result.get("activeWriteAgeAtSecondSampleMilliseconds", 0) >= 300,
            f"{label} active write was not blocked for 300 ms")
    require(result.get("socketNonBlockingProbeSucceeded") is True,
            f"{label} socket blocking-mode probe failed")
    require(result.get("socketNonBlocking") is False,
            f"{label} broker socket was nonblocking")
    require(result.get("firstSocketPollSucceeded") is True and
            result.get("secondSocketPollSucceeded") is True,
            f"{label} POLLOUT probe failed")
    require(result.get("firstSocketWritableNow") is False and
            result.get("secondSocketWritableNow") is False,
            f"{label} socket was writable during the no-read stall")
    require(result.get("firstSocketWriteInProgress") is True and
            result.get("secondSocketWriteInProgress") is True,
            f"{label} synchronous write was not active across both stall samples")
    observed_stall_nanos = (result["secondSampleElapsedRealtimeNanos"] -
                            result["firstSampleElapsedRealtimeNanos"])
    active_write_age_nanos = (result["secondSampleElapsedRealtimeNanos"] -
                              result["activeWriteStartedElapsedRealtimeNanos"])
    require(observed_stall_nanos >= 300 * 1000 * 1000,
            f"{label} raw sample timestamps do not span 300 ms")
    require(active_write_age_nanos >= 300 * 1000 * 1000,
            f"{label} raw write age is less than 300 ms")
    require(result.get("observedSameWriteStallMilliseconds") ==
            observed_stall_nanos // 1000 // 1000,
            f"{label} reported stall duration is inconsistent")
    require(result.get("activeWriteAgeAtSecondSampleMilliseconds") ==
            active_write_age_nanos // 1000 // 1000,
            f"{label} reported active-write age is inconsistent")
    require(result.get("activeWriteFrameType") == "RESPONSE_BYTES",
            f"{label} blocked write was not response data")
    require(result.get("activeWriteRequestId", 0) > 0,
            f"{label} blocked write request ID is missing")
    require(result.get("firstActiveWriteSequence") ==
            result.get("secondActiveWriteSequence"),
            f"{label} socket writer advanced during the stall")
    require(result.get("firstWritesCompleted") == result.get("secondWritesCompleted"),
            f"{label} completed-write count advanced during the stall")
    require(result.get("firstCompletedEncodedBytes") ==
            result.get("secondCompletedEncodedBytes"),
            f"{label} completed socket bytes advanced during the stall")
    completed_delta = (result["firstCompletedEncodedBytes"] -
                       result["baselineCompletedEncodedBytes"])
    require(completed_delta >= 0 and
            result.get("completedEncodedDeltaBeforeRead") == completed_delta,
            f"{label} pre-read completed-byte delta is inconsistent")
    accepted_bound = completed_delta + result["activeWriteEncodedBytes"]
    require(result.get("acceptedWireBytesUpperBound") == accepted_bound,
            f"{label} accepted-wire upper bound is inconsistent")
    require(result.get("maximumEncodedFrameBytes") == maximum_encoded_frame_bytes,
            f"{label} maximum encoded frame size is inconsistent")
    require(accepted_bound + maximum_encoded_frame_bytes < expected_bytes,
            f"{label} socket accepted nearly the full response before reads began")
    require(result.get("afterDrainWritesCompleted", 0) >=
            result.get("firstActiveWriteSequence", 1),
            f"{label} blocked socket write did not complete after reads resumed")
    require(result.get("afterDrainCompletedEncodedBytes", 0) -
            result.get("baselineCompletedEncodedBytes", 0) >= result["responseBytes"],
            f"{label} post-drain socket-byte count is smaller than the response")
accepted_bound_delta = abs(
    slow32["acceptedWireBytesUpperBound"] - slow8["acceptedWireBytesUpperBound"]
)
require(report.get("acceptedWireBoundDeltaBytes") == accepted_bound_delta,
        "large-vs-small accepted-wire bound delta is inconsistent")
require(report.get("maximumAcceptedWireBoundDeltaBytes") == maximum_encoded_frame_bytes,
        "accepted-wire bound delta limit is not one maximum frame")
require(accepted_bound_delta <= maximum_encoded_frame_bytes,
        "32 MiB and 8 MiB pre-read socket bounds differ by more than one frame")
with open(process_path, encoding="utf-8", errors="replace") as source:
    processes = source.read()
require(any(line.split()[1:2] == [str(host_pid)] for line in processes.splitlines()),
        "reported host PID is not live after report publication")
for stale_pid in worker_pids[:-1]:
    require(not any(line.split()[1:2] == [str(stale_pid)] for line in processes.splitlines()),
            f"stale worker PID {stale_pid} is still live")
with open(crash_path, encoding="utf-8", errors="replace") as source:
    crashes = source.read()
for stale_pid in worker_pids[:-1]:
    require(re.search(rf"Fatal signal 6 .* pid {stale_pid} ", crashes) is not None,
            f"worker PID {stale_pid} has no retained SIGABRT record")
print(json.dumps({
    "status": "PASS",
    "hostPid": host_pid,
    "workerPids": worker_pids,
    "workerEpochs": epochs,
    "checks": sorted(checks),
}, sort_keys=True))
PY

echo "Android broker experiment PASS: $report"
echo "Evidence directory: $run_dir"
