#!/usr/bin/env sh
set -eu

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

. "$root/tools/runtime/preflight.sh"

if ! command -v rg >/dev/null 2>&1; then
  echo "missing required command: rg" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "missing required command: node" >&2
  exit 1
fi

release_plan="$(tools/perf/matrix/run_native_oliphaunt_matrix.sh --plan-only --skip-build)"
quick_plan="$(tools/perf/matrix/run_native_oliphaunt_matrix.sh --plan-only --quick --skip-build)"
focused_plan="$(tools/perf/matrix/run_native_oliphaunt_matrix.sh --plan-only --quick --skip-build --engines broker --suites streaming --skip-sqlite --skip-prepared)"

require_plan_text() {
  plan="$1"
  text="$2"
  message="$3"
  plan_tmp="$(mktemp)"
  printf '%s\n' "$plan" >"$plan_tmp"
  if ! rg -q --fixed-strings -- "$text" "$plan_tmp"; then
    rm -f "$plan_tmp"
    echo "$message" >&2
    echo "missing plan text: $text" >&2
    exit 1
  fi
  rm -f "$plan_tmp"
}

reject_plan_text() {
  plan="$1"
  text="$2"
  message="$3"
  plan_tmp="$(mktemp)"
  printf '%s\n' "$plan" >"$plan_tmp"
  if rg -q --fixed-strings -- "$text" "$plan_tmp"; then
    rm -f "$plan_tmp"
    echo "$message" >&2
    echo "unexpected plan text: $text" >&2
    exit 1
  fi
  rm -f "$plan_tmp"
}

reject_text() {
  pattern="$1"
  file="$2"
  message="$3"
  if rg -q --fixed-strings -- "$pattern" "$file"; then
    echo "$message" >&2
    echo "unexpected text '$pattern' in $file" >&2
    exit 1
  fi
}

require_text() {
  pattern="$1"
  file="$2"
  message="$3"
  if ! rg -q --fixed-strings -- "$pattern" "$file"; then
    echo "$message" >&2
    echo "missing text '$pattern' in $file" >&2
    exit 1
  fi
}

extension_probe_root=""
provenance_probe_root=""
mobile_probe_root=""
cleanup_extension_probe() {
  if [ -n "$extension_probe_root" ]; then
    rm -rf "$extension_probe_root"
  fi
  if [ -n "$provenance_probe_root" ]; then
    rm -rf "$provenance_probe_root"
  fi
  if [ -n "$mobile_probe_root" ]; then
    rm -rf "$mobile_probe_root"
  fi
}
trap cleanup_extension_probe EXIT HUP INT TERM

assert_extension_no_build_guard() {
  if [ "$(uname -s)" != "Darwin" ]; then
    echo "skipping Darwin-only extension artifact no-build probe on $(uname -s)"
    return 0
  fi

  extension_probe_root="$(mktemp -d)"
  mkdir -p "$extension_probe_root/out" "$extension_probe_root/install/bin"
  printf 'fake liboliphaunt for readiness probe\n' > "$extension_probe_root/out/$(oliphaunt_runtime_host_library_name)"
  for tool in initdb postgres; do
    printf '#!/bin/sh\nexit 0\n' > "$extension_probe_root/install/bin/$tool"
    chmod +x "$extension_probe_root/install/bin/$tool"
  done

  set +e
  probe_output="$(
    OLIPHAUNT_WORK_ROOT="$extension_probe_root" \
      OLIPHAUNT_TRACK_BUILD=never \
      OLIPHAUNT_TRACK_SKIP_HARNESS_GUARD=1 \
      OLIPHAUNT_TRACK_SKIP_CURRENT_GUARD=1 \
      src/runtimes/liboliphaunt/native/tools/check-track.sh extensions 2>&1
  )"
  probe_status=$?
  set -e

  if [ "$probe_status" -eq 0 ]; then
    echo "extension/full validation accepted a core-only native runtime under no-build policy" >&2
    printf '%s\n' "$probe_output" >&2
    exit 1
  fi
  if ! printf '%s\n' "$probe_output" |
    rg -q --fixed-strings "missing native extension artifacts for the liboliphaunt extension matrix"; then
    echo "extension/full validation failed for the wrong reason under no-build policy" >&2
    printf '%s\n' "$probe_output" >&2
    exit 1
  fi

  rm -rf "$extension_probe_root"
  extension_probe_root=""
}

assert_extension_current_check_is_no_build() {
  if [ "$(uname -s)" != "Darwin" ]; then
    echo "skipping Darwin-only extension freshness no-build probe on $(uname -s)"
    return 0
  fi

  extension_probe_root="$(mktemp -d)"

  set +e
  probe_output="$(
    OLIPHAUNT_WORK_ROOT="$extension_probe_root" \
      src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh --check-extension-artifacts-current 2>&1
  )"
  probe_status=$?
  set -e

  if [ "$probe_status" -eq 0 ]; then
    echo "extension freshness check accepted an empty work root" >&2
    printf '%s\n' "$probe_output" >&2
    exit 1
  fi
  if [ -d "$extension_probe_root/source" ] || [ -d "$extension_probe_root/out" ]; then
    echo "extension freshness check created build directories instead of staying no-build" >&2
    find "$extension_probe_root" -maxdepth 2 -print >&2
    exit 1
  fi
  if ! printf '%s\n' "$probe_output" |
    rg -q --fixed-strings "native extension artifacts are missing or stale"; then
    echo "extension freshness check failed with an unexpected diagnostic" >&2
    printf '%s\n' "$probe_output" >&2
    exit 1
  fi

  rm -rf "$extension_probe_root"
  extension_probe_root=""
}

assert_runtime_no_build_guard() {
  extension_probe_root="$(mktemp -d)"

  set +e
  probe_output="$(
      OLIPHAUNT_WORK_ROOT="$extension_probe_root" \
      OLIPHAUNT_TRACK_BUILD=never \
      OLIPHAUNT_TRACK_SKIP_HARNESS_GUARD=1 \
      src/runtimes/liboliphaunt/native/tools/check-track.sh host-smoke 2>&1
  )"
  probe_status=$?
  set -e

  if [ "$probe_status" -eq 0 ]; then
    echo "host C smoke accepted a missing native runtime under no-build policy" >&2
    printf '%s\n' "$probe_output" >&2
    exit 1
  fi
  if [ -d "$extension_probe_root/source" ] || [ -d "$extension_probe_root/out" ]; then
    echo "host C smoke no-build validation created build directories" >&2
    find "$extension_probe_root" -maxdepth 2 -print >&2
    exit 1
  fi
  if ! printf '%s\n' "$probe_output" |
    rg -q --fixed-strings "native Oliphaunt runtime is missing or stale"; then
    echo "rust no-build validation failed with an unexpected diagnostic" >&2
    printf '%s\n' "$probe_output" >&2
    exit 1
  fi

  rm -rf "$extension_probe_root"
  extension_probe_root=""
}

assert_rust_sdk_extension_readiness_guard() {
  extension_probe_root="$(mktemp -d)"
  mkdir -p "$extension_probe_root/out" "$extension_probe_root/install/bin" "$extension_probe_root/install/include"
  printf 'fake liboliphaunt for Rust SDK readiness probe\n' > "$extension_probe_root/out/$(oliphaunt_runtime_host_library_name)"
  for tool in initdb postgres; do
    printf '#!/bin/sh\nexit 0\n' > "$extension_probe_root/install/bin/$tool"
    chmod +x "$extension_probe_root/install/bin/$tool"
  done
  cat > "$extension_probe_root/install/bin/pg_config" <<'SH'
#!/bin/sh
if [ "${1:-}" = "--configure" ]; then
  printf '%s\n' "'--with-icu'"
fi
SH
  chmod +x "$extension_probe_root/install/bin/pg_config"
  printf '#define USE_ICU 1\n' > "$extension_probe_root/install/include/pg_config.h"

  set +e
  probe_output="$(
    OLIPHAUNT_WORK_ROOT="$extension_probe_root" \
      OLIPHAUNT_REQUIRE_NATIVE=1 \
      src/sdks/rust/tools/check-sdk.sh 2>&1
  )"
  probe_status=$?
  set -e

  if [ "$probe_status" -eq 0 ]; then
    echo "Rust SDK validation accepted a core-only native runtime with missing extension artifacts" >&2
    printf '%s\n' "$probe_output" >&2
    exit 1
  fi
  if [ -d "$extension_probe_root/source" ]; then
    echo "Rust SDK readiness validation entered the native build path" >&2
    find "$extension_probe_root" -maxdepth 2 -print >&2
    exit 1
  fi
  if ! printf '%s\n' "$probe_output" |
    rg -q --fixed-strings "native Oliphaunt runtime is incomplete: extension artifacts are missing"; then
    echo "Rust SDK extension readiness guard failed with an unexpected diagnostic" >&2
    printf '%s\n' "$probe_output" >&2
    exit 1
  fi

  rm -rf "$extension_probe_root"
  extension_probe_root=""
}

assert_mobile_footprint_summary_smoke() {
  mobile_probe_root="$(mktemp -d)"
  mobile_case_dir="$mobile_probe_root/cases/android-shared-32MB-wal--1-minwal-32MB"
  mkdir -p "$mobile_case_dir/scratch/reports" "$mobile_case_dir/crash-scratch/reports"
  cat >"$mobile_case_dir/case.json" <<'JSON'
{
  "id": "android-shared-32MB-wal--1-minwal-32MB",
  "platform": "android",
  "startupGUCs": "shared_buffers=32MB,wal_buffers=-1,min_wal_size=32MB",
  "gucs": {
    "shared_buffers": "32MB",
    "wal_buffers": "-1",
    "min_wal_size": "32MB",
    "max_wal_size": "64MB"
  },
  "status": "passed"
}
JSON
  cat >"$mobile_case_dir/scratch/reports/benchmark-report.json" <<'JSON'
{
  "schemaVersion": 1,
  "openMs": 12.5,
  "closeMs": 1.5,
  "elapsedMs": 250,
  "postgresSettings": {
    "shared_buffers": "32MB",
    "wal_buffers": "-1",
    "wal_segment_size": "16MB",
    "min_wal_size": "32MB",
    "max_wal_size": "64MB",
    "synchronous_commit": "on",
    "fsync": "on",
    "full_page_writes": "on",
    "io_method": "sync"
  },
  "jsTimerTicks": 42,
  "workloads": [
    {
      "id": "typed_select_rtt",
      "latency": {"p50Ms": 4, "p90Ms": 4.5, "p95Ms": 5, "p99Ms": 6}
    },
    {
      "id": "parameterized_select_rtt",
      "latency": {"p50Ms": 7, "p90Ms": 7.5, "p95Ms": 8, "p99Ms": 9}
    },
    {
      "id": "transaction_insert",
      "throughput": {"rows": 1000, "totalMs": 100, "rowsPerSecond": 10000}
    },
    {
      "id": "background_checkpoint",
      "latency": {"p50Ms": 13, "p90Ms": 13.5, "p95Ms": 14, "p99Ms": 15}
    }
  ],
  "sqliteBenchmark": {
    "schemaVersion": 1,
    "engine": "expo-sqlite",
    "durability": "balanced",
    "openMs": 0.8,
    "workloads": [
      {
        "id": "sqlite_simple_select_rtt",
        "latency": {"p50Ms": 0.15, "p90Ms": 0.25, "p95Ms": 0.35, "p99Ms": 0.45}
      },
      {
        "id": "sqlite_parameterized_select_rtt",
        "latency": {"p50Ms": 0.2, "p90Ms": 0.3, "p95Ms": 0.4, "p99Ms": 0.5}
      },
      {
        "id": "sqlite_transaction_insert",
        "throughput": {"rows": 1000, "totalMs": 50, "rowsPerSecond": 20000}
      },
      {
        "id": "sqlite_indexed_lookup",
        "latency": {"p50Ms": 0.51, "p90Ms": 0.52, "p95Ms": 0.53, "p99Ms": 0.54}
      },
      {
        "id": "sqlite_indexed_aggregate",
        "latency": {"p50Ms": 0.55, "p90Ms": 0.56, "p95Ms": 0.57, "p99Ms": 0.58}
      },
      {
        "id": "sqlite_indexed_update",
        "latency": {"p50Ms": 0.6, "p90Ms": 0.7, "p95Ms": 0.8, "p99Ms": 0.9}
      },
      {
        "id": "sqlite_wal_checkpoint",
        "latency": {"p50Ms": 1.1, "p90Ms": 1.2, "p95Ms": 1.3, "p99Ms": 1.4}
      },
      {
        "id": "sqlite_large_result",
        "latency": {"p50Ms": 1.5, "p90Ms": 1.6, "p95Ms": 1.7, "p99Ms": 1.8}
      }
    ]
  }
}
JSON
  cat >"$mobile_case_dir/crash-scratch/reports/crash-report.json" <<'JSON'
{
  "elapsedMs": 88,
  "openMs": 21
}
JSON
  cat >"$mobile_case_dir/scratch/reports/benchmark-meminfo.txt" <<'TEXT'
TOTAL PSS: 65536
TOTAL RSS: 98304
TEXT
  cat >"$mobile_case_dir/scratch/reports/benchmark-process.tsv" <<'TEXT'
pid	rss	cpu
123	131072	4.5
TEXT
  cat >"$mobile_case_dir/scratch/reports/benchmark-package-sizes.json" <<'JSON'
{
  "apkBytes": 209715200,
  "iosAppBytes": 73400320,
  "rnPackageBytes": 65536
}
JSON

  tools/perf/matrix/run_mobile_footprint_matrix.sh \
    --summarize-only \
    --run-id mobile-probe \
    --output-dir "$mobile_probe_root" >/dev/null

  require_text '"typedP95Ms": 5' "$mobile_probe_root/summary.json" \
    "mobile footprint summary JSON must include typed query p95 latency"
  require_text '"parameterizedP99Ms": 9' "$mobile_probe_root/summary.json" \
    "mobile footprint summary JSON must include parameterized query p99 latency"
  require_text '"max_wal_size": "64MB"' "$mobile_probe_root/summary.json" \
    "mobile footprint summary JSON must include WAL maximum tuning"
  require_text '"wal_segment_size": "16MB"' "$mobile_probe_root/summary.json" \
    "mobile footprint summary JSON must preserve effective WAL segment size"
  require_text '"androidRssKb": 98304' "$mobile_probe_root/summary.json" \
    "mobile footprint summary JSON must include Android RSS"
  reject_text '"packageBytes"' "$mobile_probe_root/summary.json" \
    "mobile footprint summary JSON must not retain app-reported package bytes"
  require_text '"androidApkBytes": 209715200' "$mobile_probe_root/summary.json" \
    "mobile footprint summary JSON must include Android APK bytes"
  require_text '"iosAppBytes": 73400320' "$mobile_probe_root/summary.json" \
    "mobile footprint summary JSON must include iOS app bytes"
  require_text '"rnPackageBytes": 65536' "$mobile_probe_root/summary.json" \
    "mobile footprint summary JSON must include React Native package bytes"
  require_text '"postgresSettings": {' "$mobile_probe_root/summary.json" \
    "mobile footprint summary JSON must include effective PostgreSQL settings"
  require_text '"shared_buffers": "32MB"' "$mobile_probe_root/summary.json" \
    "mobile footprint summary JSON must preserve effective shared_buffers"
  require_text '"fsync": "on"' "$mobile_probe_root/summary.json" \
    "mobile footprint summary JSON must preserve effective crash-safety settings"
  require_text '"sqliteOpenMs": 0.8' "$mobile_probe_root/summary.json" \
    "mobile footprint summary JSON must include native-device SQLite open latency"
  require_text '"sqliteSimpleP90Ms": 0.25' "$mobile_probe_root/summary.json" \
    "mobile footprint summary JSON must include native-device SQLite simple-query latency"
  require_text '"sqliteParameterizedP90Ms": 0.3' "$mobile_probe_root/summary.json" \
    "mobile footprint summary JSON must include native-device SQLite query latency"
  require_text '"sqliteLookupP90Ms": 0.52' "$mobile_probe_root/summary.json" \
    "mobile footprint summary JSON must include native-device SQLite lookup latency"
  require_text '"sqliteAggregateP95Ms": 0.57' "$mobile_probe_root/summary.json" \
    "mobile footprint summary JSON must include native-device SQLite aggregate latency"
  require_text '"sqliteCheckpointP90Ms": 1.2' "$mobile_probe_root/summary.json" \
    "mobile footprint summary JSON must include native-device SQLite checkpoint latency"
  require_text '"sqliteInsertRowsPerSecond": 20000' "$mobile_probe_root/summary.json" \
    "mobile footprint summary JSON must include native-device SQLite insert throughput"
  require_text '"sqliteDurability": "balanced"' "$mobile_probe_root/summary.json" \
    "mobile footprint summary JSON must keep durability explicitly SQLite-specific"
  require_text '"crashRecoveryOpenMs": 21' "$mobile_probe_root/summary.json" \
    "mobile footprint summary JSON must include crash-recovery reopen latency"
  require_text 'Platform | Benchmark preset | shared_buffers' "$mobile_probe_root/summary.md" \
    "mobile footprint summary markdown must expose benchmark preset next to explicit PostgreSQL GUCs"
  require_text 'Effective GUCs | Open ms' "$mobile_probe_root/summary.md" \
    "mobile footprint summary markdown must expose effective PostgreSQL settings"
  require_text 'min_wal_size | max_wal_size | Effective GUCs | Open ms' "$mobile_probe_root/summary.md" \
    "mobile footprint summary markdown must expose WAL min/max and effective PostgreSQL settings"
  require_text 'Typed p50 ms | Typed p90 ms | Typed p95 ms | Typed p99 ms' "$mobile_probe_root/summary.md" \
    "mobile footprint summary markdown must expose typed query p50/p90/p95/p99"
  require_text 'Crash recovery ms | Crash recovery open ms | Insert rows/s' "$mobile_probe_root/summary.md" \
    "mobile footprint summary markdown must expose process-death recovery total and reopen latency"
  require_text 'SQLite open ms | SQLite simple p50 ms | SQLite simple p90 ms | SQLite simple p95 ms | SQLite simple p99 ms' "$mobile_probe_root/summary.md" \
    "mobile footprint summary markdown must expose same-device SQLite comparison columns"
  require_text 'SQLite lookup p50 ms | SQLite lookup p90 ms | SQLite lookup p95 ms | SQLite lookup p99 ms' "$mobile_probe_root/summary.md" \
    "mobile footprint summary markdown must expose same-device SQLite indexed lookup columns"
  require_text 'SQLite aggregate p50 ms | SQLite aggregate p90 ms | SQLite aggregate p95 ms | SQLite aggregate p99 ms' "$mobile_probe_root/summary.md" \
    "mobile footprint summary markdown must expose same-device SQLite indexed aggregate columns"
  require_text 'SQLite insert rows/s | SQLite durability | Android APK MB | iOS app MB | RN package KB | Android PSS MB' "$mobile_probe_root/summary.md" \
    "mobile footprint summary markdown must distinguish SQLite durability from harness package and memory evidence"

  rm -rf "$mobile_probe_root"
  mobile_probe_root=""
}

assert_mobile_footprint_plan_guard() {
  mobile_plan="$(
    tools/perf/matrix/run_mobile_footprint_matrix.sh \
      --plan-only \
      --platform android \
      --run-id mobile-plan-probe
  )"
  mobile_filtered_plan="$(
    tools/perf/matrix/run_mobile_footprint_matrix.sh \
      --plan-only \
      --quick \
      --platform android \
      --shared-buffers 8MB,32MB \
      --wal-buffers -1 \
      --min-wal-size 32MB \
      --max-wal-size default \
      --crash-recovery off \
      --run-id mobile-filtered-plan-probe
  )"
  require_plan_text "$mobile_plan" "planned=80" \
    "mobile footprint matrix plan must count only runnable Android cases once"
  require_plan_text "$mobile_plan" "skippedInvalidMinWalSize=120" \
    "mobile footprint matrix plan must report invalid 8MB/16MB WAL-minimum cases"
  require_plan_text "$mobile_plan" "skippedInvalidWalRange=40" \
    "mobile footprint matrix plan must report max_wal_size below min_wal_size cases"
  require_plan_text "$mobile_plan" "crashCommand=env" \
    "mobile footprint matrix plan must run crash evidence for default-safe PostgreSQL cases"
  reject_plan_text "$mobile_plan" "durability=" \
    "mobile footprint matrix plan must not retain an Oliphaunt durability label"
  reject_plan_text "$mobile_plan" "runtimeFootprint=" \
    "mobile footprint matrix plan must not retain a runtime-footprint label"
  require_plan_text "$mobile_filtered_plan" "planned=2" \
    "mobile footprint matrix filters must shrink Android plan counts to the selected GUC slice"
  require_plan_text "$mobile_filtered_plan" "benchmarkPreset=quick" \
    "mobile footprint matrix filters must preserve quick preset reporting"
  require_plan_text "$mobile_filtered_plan" "shared_buffers=8MB" \
    "mobile footprint matrix filters must include selected shared_buffers values"
  require_plan_text "$mobile_filtered_plan" "shared_buffers=32MB" \
    "mobile footprint matrix filters must include every selected shared_buffers value"
  require_plan_text "$mobile_filtered_plan" "skippedInvalidMinWalSize=0" \
    "mobile footprint matrix filters must not report skipped WAL-min cases when only valid minima are selected"
}

write_release_probe_outputs() {
  PROBE_RUN_DIR="$1" PROBE_DIRECT_REGRESSION="${2:-0}" node <<'NODE'
const fs = require('node:fs')
const path = require('node:path')

const runDir = process.env.PROBE_RUN_DIR
const directRegression = process.env.PROBE_DIRECT_REGRESSION === '1'

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
}

function writeJson(name, value) {
  const jsonFile = path.join(runDir, `${name}.json`)
  const resourceFile = path.join(runDir, `${name}.resource.txt`)
  ensureParent(jsonFile)
  fs.writeFileSync(jsonFile, `${JSON.stringify(value, null, 2)}\n`)
  fs.writeFileSync(resourceFile, '0.01 real\n0.01 user\n0.00 sys\n1024 maximum resident set size\n')
}

function benchTest(id, elapsedMicros = 1) {
  return {
    id,
    label: 'probe',
    unit: 'milliseconds',
    operationCount: 1,
    sampleCount: 1,
    trimmedSampleCount: 1,
    elapsedMicros,
    averageMicros: elapsedMicros,
    minMicros: 1,
    p50Micros: elapsedMicros,
    p90Micros: elapsedMicros,
    p95Micros: elapsedMicros,
    p99Micros: elapsedMicros,
  }
}

function benchRun(suite, mode) {
  const elapsedMicros = directRegression && suite === 'speed' && mode === 'native_liboliphaunt_direct'
    ? 10
    : 1
  const testId = suite === 'speed' ? 'probe_speed_case' : `${suite}_probe`
  return {
    suite,
    mode,
    description: 'probe',
    openMicros: 1,
    connectMicros: null,
    setupMicros: 1,
    observedServerPeakRssBytes: 1024,
    tests: [benchTest(testId, elapsedMicros)],
  }
}

function benchReport(runs) {
  return {
    wasmerVersion: 'probe',
    wasmerWasixVersion: 'probe',
    sourceModel: 'probe',
    measurementModel: 'probe',
    rttIterations: 100,
    speedScale: 1,
    preloadMicros: 0,
    runs,
  }
}

function writeBench(name, runs) {
  writeJson(name, benchReport(runs.map(([suite, mode]) => benchRun(suite, mode))))
}

function preparedTest(id) {
  return {
    id,
    label: id,
    openMicros: 1,
    connectMicros: 1,
    setupMicros: 1,
    prepareMicros: 1,
    elapsedMicros: 1,
    operationCount: 1,
    averageMicros: 1,
  }
}

function preparedReport(modes) {
  return {
    sourceModel: 'probe',
    measurementModel: 'probe',
    gateModel: null,
    rows: 25000,
    runs: modes.map((mode) => ({
      mode,
      description: 'probe',
      protocolStats: null,
      tests: [preparedTest('numeric'), preparedTest('text')],
    })),
  }
}

function writePrepared(name, modes) {
  writeJson(name, preparedReport(modes))
}

function nativeMode(engine) {
  return `native_liboliphaunt_${engine}`
}

function nativeCase(engine, suite) {
  if (engine === 'direct') {
    return {
      rtt: 'native-liboliphaunt-rtt',
      speed: 'native-liboliphaunt-speed',
      streaming: 'native-liboliphaunt-streaming',
      prepared: 'native-liboliphaunt-prepared-direct',
      backup: 'native-liboliphaunt-backup',
    }[suite]
  }
  return {
    rtt: `native-liboliphaunt-${engine}-rtt`,
    speed: `native-liboliphaunt-${engine}-speed`,
    streaming: `native-liboliphaunt-${engine}-streaming`,
    prepared: `native-liboliphaunt-prepared-${engine}`,
    backup: `native-liboliphaunt-${engine}-backup`,
  }[suite]
}

function nativePreparedModes(engine) {
  const mode = nativeMode(engine)
  return [`${mode}_prepared`, `${mode}_pipelined_prepared`]
}

function repeat(index, count) {
  return String(index).padStart(String(count).length, '0')
}

const engines = ['direct', 'broker', 'server']

fs.writeFileSync(
  path.join(runDir, 'artifact-sizes.json'),
  `${JSON.stringify({
    artifacts: [
      { name: 'liboliphaunt-native', path: '/probe/liboliphaunt.dylib', bytes: 1 },
      { name: 'embedded-modules', path: '/probe/modules', bytes: 1 },
      { name: 'native-postgres-install', path: '/probe/install', bytes: 1 },
    ],
  }, null, 2)}\n`,
)
fs.writeFileSync(path.join(runDir, 'report.md'), '# Probe native performance report\n')

for (const engine of engines) {
  for (const suite of ['rtt', 'speed', 'streaming']) {
    writeBench(nativeCase(engine, suite), [[suite, nativeMode(engine)]])
  }
  writeBench(nativeCase(engine, 'backup'), [['backup-restore', nativeMode(engine)]])
  writePrepared(nativeCase(engine, 'prepared'), nativePreparedModes(engine))
}

writeBench('native-postgres-tokio-all', [
  ['rtt', 'native_postgres'],
  ['speed', 'native_postgres'],
])
writeBench('native-postgres-sqlx-all', [
  ['rtt', 'native_postgres_sqlx'],
  ['speed', 'native_postgres_sqlx'],
])
writeBench('native-postgres-streaming', [['streaming', 'native_postgres_raw']])
writeBench('native-postgres-backup', [
  ['backup-restore', 'native_postgres'],
  ['backup-restore', 'native_postgres_physical'],
])
writeBench('sqlite-speed', [['speed', 'sqlite']])
writeBench('sqlite-backup', [['backup-restore', 'sqlite']])
writePrepared('native-postgres-prepared', [
  'native_postgres_tokio_prepared',
  'native_postgres_tokio_pipelined_prepared',
])

for (let index = 1; index <= 10; index += 1) {
  const suffix = repeat(index, 10)
  for (const engine of engines) {
    writeBench(`repeats/${nativeCase(engine, 'rtt')}-${suffix}`, [['rtt', nativeMode(engine)]])
    writeBench(`repeats/${nativeCase(engine, 'backup')}-${suffix}`, [
      ['backup-restore', nativeMode(engine)],
    ])
    writePrepared(
      `repeats/${nativeCase(engine, 'prepared')}-${suffix}`,
      nativePreparedModes(engine),
    )
  }
  writeBench(`repeats/native-postgres-tokio-rtt-${suffix}`, [['rtt', 'native_postgres']])
  writeBench(`repeats/native-postgres-backup-${suffix}`, [
    ['backup-restore', 'native_postgres'],
    ['backup-restore', 'native_postgres_physical'],
  ])
  writeBench(`repeats/sqlite-backup-${suffix}`, [['backup-restore', 'sqlite']])
  writePrepared(`repeats/native-postgres-prepared-${suffix}`, [
    'native_postgres_tokio_prepared',
    'native_postgres_tokio_pipelined_prepared',
  ])
}

for (let index = 1; index <= 20; index += 1) {
  const suffix = repeat(index, 20)
  for (const engine of engines) {
    writeBench(`repeats/${nativeCase(engine, 'speed')}-${suffix}`, [
      ['speed', nativeMode(engine)],
    ])
  }
  writeBench(`repeats/native-postgres-tokio-speed-${suffix}`, [['speed', 'native_postgres']])
  writeBench(`repeats/sqlite-speed-${suffix}`, [['speed', 'sqlite']])
}
NODE
}

assert_provenance_release_gate() {
  provenance_probe_root="$(mktemp -d)"

  node tools/perf/matrix/native_oliphaunt_provenance.mjs write \
    --run-dir "$provenance_probe_root/release" \
    --repo-root "$root" \
    --run-id perf-release-probe \
    --native-engines direct,broker,server \
    --suites rtt,speed,streaming,prepared,backup \
    --durability safe \
    --rtt-iterations 100 \
    --rtt-repeats 10 \
    --prepared-rows 25000 \
    --prepared-repeats 10 \
    --speed-repeats 20 \
    --backup-repeats 10 \
    --run-sqlite 1 \
    --run-prepared 1 \
    --release-evidence 1 \
    --partial-report 0 \
    --diagnostic-run 0 \
    --release-min-rtt-iterations 100 \
    --release-min-rtt-repeats 10 \
    --release-min-prepared-rows 25000 \
    --release-min-prepared-repeats 10 \
    --release-min-speed-repeats 20 \
    --release-min-backup-repeats 10 \
    >/dev/null
  write_release_probe_outputs "$provenance_probe_root/release"
  node tools/perf/matrix/native_oliphaunt_provenance.mjs verify \
    --run-dir "$provenance_probe_root/release" \
    --require-release-evidence \
    >/dev/null

  node tools/perf/matrix/native_oliphaunt_provenance.mjs write \
    --run-dir "$provenance_probe_root/diagnostic" \
    --repo-root "$root" \
    --run-id perf-diagnostic-probe \
    --native-engines broker \
    --suites streaming \
    --durability safe \
    --rtt-iterations 10 \
    --rtt-repeats 1 \
    --prepared-rows 1000 \
    --prepared-repeats 1 \
    --speed-repeats 1 \
    --backup-repeats 1 \
    --run-sqlite 0 \
    --run-prepared 0 \
    --release-evidence 0 \
    --partial-report 1 \
    --diagnostic-run 1 \
    --release-min-rtt-iterations 100 \
    --release-min-rtt-repeats 10 \
    --release-min-prepared-rows 25000 \
    --release-min-prepared-repeats 10 \
    --release-min-speed-repeats 20 \
    --release-min-backup-repeats 10 \
    >/dev/null

  set +e
  probe_output="$(
    node tools/perf/matrix/native_oliphaunt_provenance.mjs verify \
      --run-dir "$provenance_probe_root/diagnostic" \
      --require-release-evidence 2>&1
  )"
  probe_status=$?
  set -e

  if [ "$probe_status" -eq 0 ]; then
    echo "release-evidence provenance gate accepted a diagnostic perf report" >&2
    printf '%s\n' "$probe_output" >&2
    exit 1
  fi
  if ! printf '%s\n' "$probe_output" |
    rg -q --fixed-strings "benchmark provenance is not marked as releaseEvidence=true"; then
    echo "release-evidence provenance gate failed with an unexpected diagnostic" >&2
    printf '%s\n' "$probe_output" >&2
    exit 1
  fi

  node tools/perf/matrix/native_oliphaunt_provenance.mjs verify \
    --run-dir "$provenance_probe_root/diagnostic" \
    >/dev/null

  summary_output="$(
    node tools/perf/matrix/summarize_native_oliphaunt_matrix.mjs \
      --run-dir "$provenance_probe_root/release" \
      --run-id perf-release-probe \
      --postgres-version "postgres (PostgreSQL) 18.4" \
      --durability safe \
      --runtime-footprint throughput
  )"
  require_plan_text "$summary_output" "throughput p50 ops/s" \
    "native perf summary must render speed throughput columns"
  require_plan_text "$summary_output" "tail throughput p10 MB/s" \
    "native perf summary must render backup throughput columns"
  require_plan_text "$summary_output" "payload p50 MB" \
    "native perf summary must render backup payload-size columns"
  require_plan_text "$summary_output" "Speed tail throughput p10" \
    "native perf summary must render throughput parity gate"
  require_plan_text "$summary_output" "Backup/restore physical total p90" \
    "native perf summary must gate backup totals against the native PostgreSQL physical control"
  require_plan_text "$summary_output" "Native Postgres physical archive" \
    "native perf summary must render the native PostgreSQL physical backup control"

  node tools/perf/matrix/native_oliphaunt_provenance.mjs write \
    --run-dir "$provenance_probe_root/regression" \
    --repo-root "$root" \
    --run-id perf-regression-probe \
    --native-engines direct,broker,server \
    --suites rtt,speed,streaming,prepared,backup \
    --durability safe \
    --rtt-iterations 100 \
    --rtt-repeats 10 \
    --prepared-rows 25000 \
    --prepared-repeats 10 \
    --speed-repeats 20 \
    --backup-repeats 10 \
    --run-sqlite 1 \
    --run-prepared 1 \
    --release-evidence 1 \
    --partial-report 0 \
    --diagnostic-run 0 \
    --release-min-rtt-iterations 100 \
    --release-min-rtt-repeats 10 \
    --release-min-prepared-rows 25000 \
    --release-min-prepared-repeats 10 \
    --release-min-speed-repeats 20 \
    --release-min-backup-repeats 10 \
    >/dev/null
  write_release_probe_outputs "$provenance_probe_root/regression" 1
  node tools/perf/matrix/native_oliphaunt_provenance.mjs verify \
    --run-dir "$provenance_probe_root/regression" \
    --require-release-evidence \
    >/dev/null
  regression_summary="$(
    node tools/perf/matrix/summarize_native_oliphaunt_matrix.mjs \
      --run-dir "$provenance_probe_root/regression" \
      --run-id perf-regression-probe \
      --postgres-version "postgres (PostgreSQL) 18.4" \
      --durability safe \
      --runtime-footprint throughput
  )"
  require_plan_text "$regression_summary" "## Native Direct Regression Diagnostics" \
    "native perf summary must render diagnostic section when native-direct gates miss"
  require_plan_text "$regression_summary" "Speed-case diagnostic commands:" \
    "native perf summary must render speed-case diagnostic commands when speed cases miss"
  require_plan_text "$regression_summary" "tools/perf/matrix/run_native_speed_diagnostics.sh --ids probe_speed_case --repeats 10 --skip-build" \
    "native perf summary must render the repeated speed diagnostic command"
  require_plan_text "$regression_summary" "cargo run --release -p oliphaunt-perf -- diagnose-speed-cases --engine native-liboliphaunt --ids probe_speed_case" \
    "native perf summary must render the liboliphaunt speed-case diagnostic command"
  require_plan_text "$regression_summary" "cargo run --release -p oliphaunt-perf -- diagnose-speed-cases --engine native-postgres --ids probe_speed_case" \
    "native perf summary must render the native PostgreSQL speed-case diagnostic command"
  require_plan_text "$regression_summary" 'Run `oliphaunt-perf diagnose-speed-cases` for the missed case ids below' \
    "native perf summary must explain the missed speed-suite diagnostic path"

  rm -rf "$provenance_probe_root"
  provenance_probe_root=""
}

require_plan_text "$release_plan" "nativeOnly=true" "native performance plan must declare native-only scope"
require_plan_text "$release_plan" "nativeEngines=direct,broker,server" "native performance full plan must cover all native engines by default"
require_plan_text "$release_plan" "suites=rtt,speed,streaming,prepared,backup" "native performance full plan must cover all suites by default"
require_plan_text "$release_plan" "releaseEvidence=1" "native performance default plan must be classified as release evidence"
require_plan_text "$release_plan" "partialReport=0" "native performance default plan must not be classified as partial"
require_plan_text "$release_plan" "diagnosticRun=0" "native performance default plan must not be classified as diagnostic"
require_plan_text "$release_plan" "releaseMinRttIterations=100" "native performance plan must publish release RTT sample minimum"
require_plan_text "$release_plan" "releaseMinRttRepeats=10" "native performance plan must publish release RTT repeat minimum"
require_plan_text "$release_plan" "releaseMinPreparedRows=25000" "native performance plan must publish release prepared-row minimum"
require_plan_text "$release_plan" "releaseMinPreparedRepeats=10" "native performance plan must publish release prepared repeat minimum"
require_plan_text "$release_plan" "releaseMinSpeedRepeats=20" "native performance plan must publish release speed repeat minimum"
require_plan_text "$release_plan" "releaseMinBackupRepeats=10" "native performance plan must publish release backup/restore repeat minimum"
require_plan_text "$release_plan" "rttIterations=100" "native performance default plan must meet release RTT sample minimum"
require_plan_text "$release_plan" "rttRepeats=10" "native performance default plan must meet release RTT repeat minimum"
require_plan_text "$release_plan" "preparedRows=25000" "native performance default plan must meet release prepared-row minimum"
require_plan_text "$release_plan" "preparedRepeats=10" "native performance default plan must meet release prepared repeat minimum"
require_plan_text "$release_plan" "speedRepeats=20" "native performance default plan must meet release speed repeat minimum"
require_plan_text "$release_plan" "backupRepeats=10" "native performance default plan must meet release backup/restore repeat minimum"
require_plan_text "$release_plan" "perfRunnerBuildCommand=cargo build --release -p oliphaunt-perf -p oliphaunt --bins" \
  "native performance plan must opt in to oliphaunt-perf support explicitly"
require_plan_text "$release_plan" "case=native-liboliphaunt-rtt" "native performance plan must cover direct RTT"
require_plan_text "$release_plan" "case=native-liboliphaunt-broker-rtt" "native performance plan must cover broker RTT"
require_plan_text "$release_plan" "case=native-liboliphaunt-server-rtt" "native performance plan must cover server RTT"
require_plan_text "$release_plan" "case=native-liboliphaunt-backup" "native performance plan must cover direct backup/restore"
require_plan_text "$release_plan" "case=native-liboliphaunt-broker-backup" "native performance plan must cover broker backup/restore"
reject_plan_text "$release_plan" "case=native-liboliphaunt-server-backup" "native performance plan must not invent an SDK server backup path"
require_plan_text "$release_plan" "case=native-postgres-tokio-all" "native performance plan must include native PostgreSQL control"
require_plan_text "$release_plan" "case=native-postgres-backup" "native performance plan must include native PostgreSQL backup/restore control"
require_plan_text "$release_plan" "case=sqlite-backup" "native performance plan must include SQLite backup/restore control"

require_plan_text "$quick_plan" "nativeEngines=direct,broker,server" "quick native performance plan must retain all engines"
require_plan_text "$quick_plan" "suites=rtt,speed,streaming,prepared,backup" "quick native performance plan must retain all suites"
require_plan_text "$quick_plan" "releaseEvidence=0" "quick native performance plan must not be classified as release evidence"
require_plan_text "$quick_plan" "partialReport=0" "quick native performance plan must remain full coverage"
require_plan_text "$quick_plan" "diagnosticRun=1" "quick native performance plan must be classified as diagnostic"

require_plan_text "$focused_plan" "nativeEngines=broker" "focused native performance plan must preserve selected engine"
require_plan_text "$focused_plan" "suites=streaming" "focused native performance plan must preserve selected suite"
require_plan_text "$focused_plan" "releaseEvidence=0" "focused native performance plan must not be classified as release evidence"
require_plan_text "$focused_plan" "partialReport=1" "focused native performance plan must be classified as partial"
require_plan_text "$focused_plan" "diagnosticRun=1" "focused native performance plan must be classified as diagnostic"
require_plan_text "$focused_plan" "runSqlite=0" "focused streaming plan must not include SQLite"
require_plan_text "$focused_plan" "runPrepared=0" "focused streaming plan must not include prepared updates"
require_plan_text "$focused_plan" "case=native-liboliphaunt-broker-streaming" "focused native performance plan must include selected broker streaming case"
require_plan_text "$focused_plan" "case=native-postgres-streaming" "focused native performance plan must include native PostgreSQL streaming control"
reject_plan_text "$focused_plan" "case=native-liboliphaunt-rtt" "focused native performance plan must not include direct RTT"
reject_plan_text "$focused_plan" "case=native-liboliphaunt-server-streaming" "focused native performance plan must not include unselected server engine"
reject_plan_text "$focused_plan" "case=sqlite-speed" "focused native performance plan must not include SQLite speed"
reject_plan_text "$focused_plan" "case=native-liboliphaunt-prepared-broker" "focused native performance plan must not include prepared updates"

reject_text "--skip-wasix" src/docs/content/reference/performance.mdx \
  "performance docs must not require a skip-WASIX flag for native perf"
require_text 'command: "bash src/runtimes/liboliphaunt/native/tools/check-track.sh quick"' src/runtimes/liboliphaunt/native/moon.yml \
  "liboliphaunt smoke must delegate to the reusable native-only product harness"
require_text 'command: "bash src/runtimes/liboliphaunt/native/tools/check-track.sh host-smoke"' src/runtimes/liboliphaunt/native/moon.yml \
  "liboliphaunt host-smoke must expose a fast cross-platform host C ABI smoke lane"
require_text 'OLIPHAUNT_TRACK_BUILD: "never"' src/runtimes/liboliphaunt/native/moon.yml \
  "liboliphaunt host-smoke must fail fast instead of entering the native build path"
require_text 'cargo test -p oliphaunt --locked \' src/runtimes/liboliphaunt/native/tools/check-track.sh \
  "native Rust track validation must run selected Rust targets through one cargo invocation"
require_text '--test public_api \' src/runtimes/liboliphaunt/native/tools/check-track.sh \
  "native Rust track validation must include the public API contract in the combined invocation"
require_text '--test native_smoke' src/runtimes/liboliphaunt/native/tools/check-track.sh \
  "native Rust track validation must include the direct and broker smoke coverage in the combined invocation"
require_text '--test native_sql_regression \' src/runtimes/liboliphaunt/native/tools/check-track.sh \
  "native Rust track validation must retain PostgreSQL behavior regression coverage"
require_text 'cargo test -p oliphaunt --locked \' src/sdks/rust/tools/check-sdk.sh \
  "Rust SDK validation must run selected non-doc targets through one cargo invocation"
reject_text 'cargo test -p oliphaunt --test native_root_locking --locked' src/sdks/rust/tools/check-sdk.sh \
  "Rust SDK validation must not split native_root_locking into a separate cargo invocation"
require_text '--print-required-extension-artifacts' tools/runtime/preflight.sh \
  "shared runtime preflight must use the native build script's complete extension artifact inventory"
require_text 'oliphaunt_runtime_native_host_extensions_ready()' tools/runtime/preflight.sh \
  "shared runtime preflight must treat native extension artifacts as part of runtime readiness"
require_text 'await fs.mkdir(lockDir)' tools/runtime/with-native-runtime-lock.mjs \
  "shared native runtime probes must use an atomic cross-process lock instead of ad hoc task-ordering"
require_text 'removeStaleLock' tools/runtime/with-native-runtime-lock.mjs \
  "shared native runtime probes must recover stale lock owners after interrupted runs"
require_text 'native_runtime_lock cargo test -p oliphaunt --locked \' src/runtimes/liboliphaunt/native/tools/check-track.sh \
  "liboliphaunt native Rust probes must be serialized across parallel Moon release lanes"
require_text 'native_runtime_lock node src/runtimes/liboliphaunt/native/tools/run-host-c-smoke.mjs' src/runtimes/liboliphaunt/native/tools/check-track.sh \
  "liboliphaunt host C ABI smoke must be serialized across parallel Moon release lanes"
require_text 'command: "bash src/extensions/artifacts/native/tools/check-release-artifacts.sh"' src/extensions/artifacts/native/moon.yml \
  "native extension artifact release-check must validate the native extension matrix through extension-owned tooling"
require_text "env.OLIPHAUNT_BUILD_EXTENSIONS ??= '0'" src/runtimes/liboliphaunt/native/tools/build-release-runtime.mjs \
  "liboliphaunt core release-runtime producer must not build optional extension artifacts by default"
require_text 'export OLIPHAUNT_BUILD_EXTENSIONS="${OLIPHAUNT_BUILD_EXTENSIONS:-1}"' src/runtimes/liboliphaunt/native/tools/check-track.sh \
  "liboliphaunt extension validation must opt into native extension artifacts explicitly"
reject_text 'command: "src/runtimes/liboliphaunt/native/tools/check-track.sh full"' src/runtimes/liboliphaunt/native/moon.yml \
  "liboliphaunt release-check must not use the legacy full aggregate now that SDK release checks are first-class Moon product tasks"
require_text '- "liboliphaunt-native:release-runtime"' src/sdks/rust/moon.yml \
  "Rust SDK release-check must consume the liboliphaunt runtime producer"
require_text 'native_runtime_lock cargo nextest run -p oliphaunt --locked --profile ci' src/sdks/rust/tools/check-sdk.sh \
  "Rust SDK native-capable nextest runs must serialize with liboliphaunt native probes"
require_text '- "liboliphaunt-native:release-runtime"' src/sdks/swift/moon.yml \
  "Swift SDK release-check must consume the liboliphaunt runtime producer"
require_text '- "liboliphaunt-native:release-runtime"' src/sdks/kotlin/moon.yml \
  "Kotlin SDK release-check must consume the liboliphaunt runtime producer"
require_text 'moon run liboliphaunt-native:host-smoke' docs/maintainers/development.md \
  "development docs must advertise the no-build native product inner loop"
require_text 'normal extension files, and embedded' docs/maintainers/development.md \
  "development docs must state that rust-sdk native reuse requires complete extension artifacts"
require_text '--require-release-evidence' tools/perf/check-native-perf-report.sh \
  "native perf report validation must require release-evidence provenance by default"
require_text 'OLIPHAUNT_PERF_ALLOW_DIAGNOSTIC' tools/perf/check-native-perf-report.sh \
  "native perf report validation must require an explicit diagnostic override"
require_text 'benchmarkReleaseOutputFailures' tools/perf/matrix/native_oliphaunt_provenance.mjs \
  "native perf provenance validation must verify release raw benchmark outputs"
require_text 'p99_micros' tools/perf/runner/src/report.rs \
  "native benchmark JSON must include p99 tail latency"
require_text 'median p99 us' tools/perf/matrix/summarize_native_oliphaunt_matrix.mjs \
  "native benchmark summary must report p99 RTT tail latency"
require_text 'suite p99 s' tools/perf/matrix/summarize_native_oliphaunt_matrix.mjs \
  "native benchmark summary must report p99 speed-suite tail latency"
require_text 'total p99 s' tools/perf/matrix/summarize_native_oliphaunt_matrix.mjs \
  "native benchmark summary must report p99 backup/restore tail latency"
require_text 'p99 observed server RSS MB' tools/perf/matrix/summarize_native_oliphaunt_matrix.mjs \
  "native benchmark summary must report p99 broker/server child RSS"
require_text 'p99 command CPU s' tools/perf/matrix/summarize_native_oliphaunt_matrix.mjs \
  "native benchmark summary must report p99 prepared-update CPU"
require_text 'throughput p50 ops/s' tools/perf/matrix/summarize_native_oliphaunt_matrix.mjs \
  "native benchmark summary must report speed throughput"
require_text 'tail throughput p10 MB/s' tools/perf/matrix/summarize_native_oliphaunt_matrix.mjs \
  "native benchmark summary must report backup/restore tail throughput"
require_text 'payload p50 MB' tools/perf/matrix/summarize_native_oliphaunt_matrix.mjs \
  "native benchmark summary must report backup/restore payload size"
require_text 'Speed tail throughput p10' tools/perf/matrix/summarize_native_oliphaunt_matrix.mjs \
  "native direct gate must include throughput parity"
require_text 'Backup/restore physical total p90' tools/perf/matrix/summarize_native_oliphaunt_matrix.mjs \
  "native direct gate must compare physical backup totals against a physical native PostgreSQL control"
require_text 'native_postgres_physical' tools/perf/runner/src/native_postgres.rs \
  "native Postgres benchmark must expose a physical backup/restore control"
require_text 'native_postgres_physical' tools/perf/matrix/native_oliphaunt_provenance.mjs \
  "native perf provenance must require the native PostgreSQL physical backup/restore control"
require_text 'Native Direct Regression Diagnostics' tools/perf/matrix/summarize_native_oliphaunt_matrix.mjs \
  "native perf report must include diagnostics for native-direct gate misses"
require_text 'oliphaunt-perf diagnose-speed-cases' tools/perf/matrix/summarize_native_oliphaunt_matrix.mjs \
  "native perf report must include liboliphaunt speed-case diagnostic commands"
require_text 'cargo run --release -p oliphaunt-perf -- diagnose-speed-cases --engine native-postgres' tools/perf/matrix/summarize_native_oliphaunt_matrix.mjs \
  "native perf report must include native PostgreSQL speed-case diagnostic commands"
require_text 'run_native_speed_diagnostics.sh' tools/perf/matrix/summarize_native_oliphaunt_matrix.mjs \
  "native perf report must include repeated speed diagnostic commands"
require_text "oliphaunt.native-speed-diagnostics.v1" tools/perf/matrix/summarize_native_speed_diagnostics.mjs \
  "native speed diagnostic summary must write a versioned schema"
require_text 'NativeDirect diagnostics run one fresh process per case/repeat' tools/perf/matrix/summarize_native_speed_diagnostics.mjs \
  "native speed diagnostic summary must document direct process-lifetime semantics"
require_text 'p50/p90/p95/p99 latency, suite totals, throughput' src/docs/content/reference/performance.mdx \
  "performance docs must document p99 tail latency and throughput reporting"
require_text 'Native Direct Regression Diagnostics' src/docs/content/reference/performance.mdx \
  "performance docs must document native-direct regression diagnostics"
require_text '--runtime-footprint' tools/perf/runner/src/main.rs \
  "native perf runner must expose runtime footprint profile sweeps"
require_text '--startup-guc' tools/perf/runner/src/main.rs \
  "native perf runner must expose explicit PostgreSQL startup GUC sweeps"
require_text 'runtimeFootprint' tools/perf/matrix/run_native_oliphaunt_matrix.sh \
  "native perf matrix plan must record runtime footprint profile"
require_text 'startupGucs' tools/perf/matrix/run_native_oliphaunt_matrix.sh \
  "native perf matrix plan must record startup GUC overrides"
require_text 'runtimeFootprint' tools/perf/matrix/native_oliphaunt_provenance.mjs \
  "native perf provenance must record runtime footprint profile"
require_text 'Native runtime footprint profile' tools/perf/matrix/summarize_native_oliphaunt_matrix.mjs \
  "native perf report must state the runtime footprint profile"
require_text 'min_wal_size=8MB' src/docs/content/reference/performance.mdx \
  "performance docs must explain invalid below-segment WAL-size experiments"
require_text '#!/usr/bin/env bash' tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint matrix runner must exist"
require_text 'shared_buffers=(8MB 16MB 32MB 64MB 128MB)' tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint matrix must sweep requested shared_buffers values"
require_text 'wal_buffers=(-1 256kB 1MB 4MB)' tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint matrix must sweep requested wal_buffers values"
require_text 'min_wal_sizes=(8MB 16MB 32MB 80MB)' tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint matrix must sweep requested min_wal_size values"
require_text 'max_wal_sizes=(32MB 64MB default)' tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint matrix must sweep requested max_wal_size values and preserve the default baseline"
require_text 'skippedInvalidWalRange' tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint matrix must reject impossible max_wal_size below min_wal_size cases"
require_text '--shared-buffers VALUES' tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint matrix must expose shared_buffers filters for measured tuning slices"
require_text '--wal-buffers VALUES' tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint matrix must expose wal_buffers filters for measured tuning slices"
require_text '--min-wal-size VALUES' tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint matrix must expose min_wal_size filters for measured tuning slices"
require_text '--max-wal-size VALUES' tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint matrix must expose max_wal_size filters for measured tuning slices"
require_text 'OLIPHAUNT_EXPO_MOBILE_BENCHMARK_PRESET=$benchmark_preset' tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint matrix quick mode must propagate an installed-app benchmark preset"
require_text "'Benchmark preset'" tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint matrix summary must expose the installed-app benchmark preset"
require_text "'Effective GUCs'" tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint matrix summary must expose effective PostgreSQL settings"
require_text "'Typed p50 ms'" tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint matrix summary must expose typed-query latency columns"
require_text "'Param p99 ms'" tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint matrix summary must expose parameterized tail latency"
require_text 'SQLite lookup p50 ms' tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint matrix summary must expose SQLite indexed lookup comparison columns"
require_text 'SQLite aggregate p50 ms' tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint matrix summary must expose SQLite indexed aggregate comparison columns"
require_text 'SQLite large result p99 ms' tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint matrix summary must expose full SQLite large-result latency distribution"
require_text 'Crash recovery open ms' tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint matrix summary must expose crash-recovery reopen latency"
require_text "'Android APK MB'" tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint matrix summary must expose Android package size columns"
require_text "'iOS app MB'" tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint matrix summary must expose iOS app size columns"
require_text "'Android PSS MB'" tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint matrix summary must expose Android PSS columns"
require_text "'SQLite durability'" tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint matrix must label durability as SQLite-specific"
require_text 'assertSafeCrashSettings(postgresSettings)' examples/react-native-expo/src/SmokeDashboard.tsx \
  "Expo crash evidence must verify effective safe PostgreSQL settings"
reject_text 'processMemoryReport' tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint summary must use platform harness memory evidence"
reject_text 'packageSizeReport' tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint summary must use built artifact size evidence"
reject_text 'OLIPHAUNT_EXPO_MOBILE_DURABILITY' tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint matrix must not pass a dead durability profile"
reject_text 'OLIPHAUNT_EXPO_MOBILE_RUNTIME_FOOTPRINT' tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint matrix must not pass a dead runtime-footprint profile"
reject_text '--durability' tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint matrix must not retain a dead durability option"
reject_text '--runtime-footprint' tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint matrix must not retain a dead runtime-footprint option"
require_text 'benchmark-meminfo.txt' tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint summary must read Android harness process evidence"
require_text 'benchmark-process.tsv' tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint summary must read iOS harness process evidence"
require_text 'benchmark-package-sizes.json' tools/perf/matrix/run_mobile_footprint_matrix.sh \
  "mobile footprint summary must read built artifact sizes"
reject_text 'processMemoryReport' examples/react-native-expo/src/SmokeDashboard.tsx \
  "Expo app report must not expose stale process-memory metadata"
reject_text 'packageSizeReport' examples/react-native-expo/src/SmokeDashboard.tsx \
  "Expo app report must not expose stale package-size metadata"
reject_text 'EXPO_PUBLIC_OLIPHAUNT_DURABILITY' src/sdks/react-native/tools/expo-android-runner.sh \
  "Android Expo runner must not publish a dead durability profile"
reject_text 'EXPO_PUBLIC_OLIPHAUNT_RUNTIME_FOOTPRINT' src/sdks/react-native/tools/expo-android-runner.sh \
  "Android Expo runner must not publish a dead runtime-footprint profile"
reject_text 'EXPO_PUBLIC_OLIPHAUNT_DURABILITY' src/sdks/react-native/tools/expo-ios-runner.sh \
  "iOS Expo runner must not publish a dead durability profile"
reject_text 'EXPO_PUBLIC_OLIPHAUNT_RUNTIME_FOOTPRINT' src/sdks/react-native/tools/expo-ios-runner.sh \
  "iOS Expo runner must not publish a dead runtime-footprint profile"
reject_text 'liboliphauntDurability' src/sdks/react-native/tools/expo-runner-android-device.sh \
  "Android installed-app URL must not carry a dead durability profile"
reject_text 'liboliphauntRuntimeFootprint' src/sdks/react-native/tools/expo-runner-android-device.sh \
  "Android installed-app URL must not carry a dead runtime-footprint profile"
reject_text 'liboliphauntDurability' src/sdks/react-native/tools/expo-runner-ios-installed-app.sh \
  "iOS installed-app URL must not carry a dead durability profile"
reject_text 'liboliphauntRuntimeFootprint' src/sdks/react-native/tools/expo-runner-ios-installed-app.sh \
  "iOS installed-app URL must not carry a dead runtime-footprint profile"
require_text 'liboliphauntBenchmarkPreset' src/sdks/react-native/tools/expo-runner-ios-installed-app.sh \
  "iOS Expo benchmark harness must pass the benchmark preset into the installed app"
require_text 'iPhoneOS builds require a local Apple Development signing identity' src/sdks/react-native/tools/expo-runner-ios-device.sh \
  "iOS physical-device benchmark harness must fail fast when signing is not configured"
require_text 'is_physical_ios_launch' src/sdks/react-native/tools/expo-ios-runner.sh \
  "iOS harness must separate physical install/launch preflight from iPhoneOS build-only validation"
require_text 'printf '"'"'id=%s\n'"'"' "$(select_ios_physical_device_id)"' src/sdks/react-native/tools/expo-runner-ios-device.sh \
  "iOS physical-device benchmark harness must build for the selected device so Xcode can register/provision it"
require_text 'OLIPHAUNT_EXPO_IOS_CODE_SIGNING_ALLOWED=NO for install/launch benchmarks' src/sdks/react-native/tools/expo-runner-ios-device.sh \
  "iOS physical-device benchmark harness must reject unsigned install/launch runs"
require_text 'physical iOS runs require Developer Mode enabled' src/sdks/react-native/tools/expo-runner-ios-device.sh \
  "iOS physical-device benchmark harness must fail fast when Developer Mode is disabled"
require_text 'physical iOS runs require Developer Disk Image services' src/sdks/react-native/tools/expo-runner-ios-device.sh \
  "iOS physical-device benchmark harness must fail fast when Developer Disk Image services are unavailable"
require_text '-allowProvisioningUpdates' src/sdks/react-native/tools/expo-ios-runner.sh \
  "iOS physical-device benchmark harness must support explicit automatic provisioning"
require_text 'OLIPHAUNT_EXPO_IOS_CRASH_STORAGE' src/sdks/react-native/tools/expo-ios-runner.sh \
  "iOS crash recovery must expose a storage-named override"
reject_text 'OLIPHAUNT_EXPO_IOS_CRASH_ROOT' src/sdks/react-native/tools/expo-ios-runner.sh \
  "iOS crash recovery must not retain the old root-named override"
require_text 'crash_storage_suffix' src/sdks/react-native/tools/expo-ios-runner.sh \
  "iOS crash recovery storage must be isolated per scratch run"
require_text 'app-data:oliphaunt-crash-recovery-$crash_storage_suffix' src/sdks/react-native/tools/expo-ios-runner.sh \
  "iOS crash recovery must avoid stale persistent storage across benchmark runs"
require_text 'rm -rf "$crash_storage"' src/sdks/react-native/tools/expo-runner-ios-installed-app.sh \
  "iOS simulator crash recovery must clear the per-run storage before the write phase"
require_text 'liboliphauntBenchmarkPreset' src/sdks/react-native/tools/expo-runner-android-device.sh \
  "Android Expo benchmark harness must pass the benchmark preset into the installed app"
require_text 'OLIPHAUNT_EXPO_ANDROID_CRASH_STORAGE' src/sdks/react-native/tools/expo-android-runner.sh \
  "Android crash recovery must expose a storage-named override"
reject_text 'OLIPHAUNT_EXPO_ANDROID_CRASH_ROOT' src/sdks/react-native/tools/expo-android-runner.sh \
  "Android crash recovery must not retain the old root-named override"
require_text 'crash_storage_suffix' src/sdks/react-native/tools/expo-android-runner.sh \
  "Android crash recovery storage must be isolated per scratch run"
require_text 'oliphaunt-crash-recovery-storage-$crash_storage_suffix' src/sdks/react-native/tools/expo-android-runner.sh \
  "Android crash recovery must avoid stale persistent storage across benchmark runs"
require_text 'rm -rf "$crash_storage"' src/sdks/react-native/tools/expo-runner-android-device.sh \
  "Android crash recovery must clear the per-run storage before the write phase"
require_text 'benchmarkOptionsForPreset' examples/react-native-expo/src/SmokeDashboard.tsx \
  "Expo benchmark app must size benchmark workloads from a named preset"
require_text 'refreshing native extension artifacts through fingerprinted build script' src/runtimes/liboliphaunt/native/tools/check-track.sh \
  "native extension/full validation must refresh extension artifacts through the fingerprinted build script"
require_text '--check-extension-artifacts-current' src/runtimes/liboliphaunt/native/tools/check-track.sh \
  "native extension/full validation must check extension freshness before entering the build path"
require_text '--check-oliphaunt-current' src/runtimes/liboliphaunt/native/tools/check-track.sh \
  "native validation must check liboliphaunt dylib freshness before trusting no-build artifacts"
require_text '--check-oliphaunt-current' src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh \
  "native build script must expose a no-build liboliphaunt dylib freshness check"
require_text 'missing native extension artifacts for the liboliphaunt extension matrix' src/runtimes/liboliphaunt/native/tools/check-track.sh \
  "native extension/full validation must fail fast when extension artifacts are absent under no-build policy"
require_text 'OLIPHAUNT_TRACK_SKIP_HARNESS_GUARD' src/runtimes/liboliphaunt/native/tools/check-track.sh \
  "native track harness must expose an internal recursion guard for fast harness self-tests"
require_text 'OLIPHAUNT_TRACK_SKIP_CURRENT_GUARD' src/runtimes/liboliphaunt/native/tools/check-track.sh \
  "native track harness must expose an internal current-artifact guard bypass for focused harness self-tests"
require_text '--print-required-extension-artifacts' src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh \
  "native build script must expose required extension artifact metadata without rebuilding"
require_text '--check-extension-artifacts-current' src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh \
  "native build script must expose a no-build native extension freshness check"
require_text '--print-required-extension-artifacts' src/runtimes/liboliphaunt/native/tools/check-track.sh \
  "native extension/full validation must use the build script's complete extension artifact inventory"
required_extension_artifacts="$(src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh --print-required-extension-artifacts)"
require_plan_text "$required_extension_artifacts" "control:pgtap" \
  "extension artifact inventory must include SQL-only pgtap control assets"
require_plan_text "$required_extension_artifacts" "module:_int" \
  "extension artifact inventory must include module stems whose names differ from extension ids"
require_plan_text "$required_extension_artifacts" "module:vector" \
  "extension artifact inventory must include vector native module assets"
assert_extension_current_check_is_no_build
assert_runtime_no_build_guard
assert_rust_sdk_extension_readiness_guard
assert_extension_no_build_guard
assert_mobile_footprint_plan_guard
assert_mobile_footprint_summary_smoke
assert_provenance_release_gate

printf '\nNative performance and validation harness checks passed.\n'
