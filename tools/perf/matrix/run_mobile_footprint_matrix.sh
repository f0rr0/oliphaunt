#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
if repo_root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)"; then
  :
else
  repo_root="$(cd "$script_dir/../../.." && pwd)"
fi
example_dir="$repo_root/src/sdks/react-native/examples/expo"

platform="both"
plan_only=0
include_invalid_wal_min=0
quick=0
keep_going=0
summarize_only=0
crash_recovery="${OLIPHAUNT_MOBILE_FOOTPRINT_CRASH_RECOVERY:-per-case}"
runtime_footprints_raw="${OLIPHAUNT_MOBILE_FOOTPRINT_RUNTIME_FOOTPRINTS:-balancedMobile}"
shared_buffers_raw="${OLIPHAUNT_MOBILE_FOOTPRINT_SHARED_BUFFERS:-all}"
wal_buffers_raw="${OLIPHAUNT_MOBILE_FOOTPRINT_WAL_BUFFERS:-all}"
min_wal_sizes_raw="${OLIPHAUNT_MOBILE_FOOTPRINT_MIN_WAL_SIZES:-all}"
max_wal_sizes_raw="${OLIPHAUNT_MOBILE_FOOTPRINT_MAX_WAL_SIZES:-all}"
durabilities_raw="${OLIPHAUNT_MOBILE_FOOTPRINT_DURABILITIES:-all}"
wal_segsize_mb="${OLIPHAUNT_MOBILE_FOOTPRINT_WAL_SEGSIZE_MB:-16}"
run_id="${OLIPHAUNT_MOBILE_FOOTPRINT_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
output_dir="${OLIPHAUNT_MOBILE_FOOTPRINT_OUTPUT_DIR:-$repo_root/target/perf/mobile-footprint-$run_id}"
output_dir_explicit=0
run_id_explicit=0

usage() {
  cat >&2 <<'USAGE'
usage: tools/perf/matrix/run_mobile_footprint_matrix.sh [options]

Options:
  --platform android|ios|both   Platform benchmark harness to run. Default: both.
  --plan-only                   Print concrete benchmark commands without running them.
  --include-invalid-wal-min     Include min_wal_size combinations smaller than two WAL segments.
                                Use only for negative validation.
  --wal-segsize MB              Template-cluster WAL segment size in megabytes. Default: 16.
                                Pass 4 to make min_wal_size=8MB and 16MB valid.
  --run-id ID                   Stable run id for the report directory.
  --output-dir DIR              Matrix output directory. Default: target/perf/mobile-footprint-<run-id>.
  --keep-going                  Continue after a failed case and summarize failures.
  --runtime-footprint PROFILE   Runtime footprint profile to use for each case:
                                throughput, balancedMobile, smallMobile, all, or a
                                comma-separated list. Default: balancedMobile.
  --shared-buffers VALUES       shared_buffers values to run: all or a comma-separated
                                subset of 8MB,16MB,32MB,64MB,128MB.
  --wal-buffers VALUES          wal_buffers values to run: all or a comma-separated
                                subset of -1,256kB,1MB,4MB.
  --min-wal-size VALUES         min_wal_size values to run: all or a comma-separated
                                subset of 8MB,16MB,32MB,80MB.
  --max-wal-size VALUES         max_wal_size values to run: all or a comma-separated
                                subset of 32MB,64MB,default.
  --durability VALUES           Durability profiles to run: all, safe, balanced, or a
                                comma-separated subset. Default: all.
  --crash-recovery off|per-case Run process-death recovery evidence for safe
                                durability cases. Balanced keeps
                                synchronous_commit=off and is not a last-commit
                                survival gate. Default: per-case.
  --summarize-only              Rebuild summary.json and summary.md from an existing output dir.
  --quick                       Forward quick benchmark sizing to the Expo benchmark harness when
                                supported by local overrides.
  -h, --help                    Show this help.

The matrix sweeps:
  runtime footprint: balancedMobile by default; pass --runtime-footprint all
    to compare throughput/balancedMobile/smallMobile under the same GUC axes
  shared_buffers: 8/16/32/64/128MB
  wal_buffers: -1/256kB/1MB/4MB
  min_wal_size: 8/16/32/80MB
  WAL segment size: 16MB by default; pass --wal-segsize 4 to run the 8/16MB
    min_wal_size mobile experiments against a matching template cluster
  max_wal_size: 32/64MB plus default
  durability: safe/balanced
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform)
      platform="${2:?--platform requires a value}"
      shift 2
      ;;
    --plan-only)
      plan_only=1
      shift
      ;;
    --include-invalid-wal-min)
      include_invalid_wal_min=1
      shift
      ;;
    --quick)
      quick=1
      shift
      ;;
    --wal-segsize|--wal-segsize-mb)
      wal_segsize_mb="${2:?$1 requires a value}"
      wal_segsize_mb="${wal_segsize_mb%MB}"
      shift 2
      ;;
    --keep-going)
      keep_going=1
      shift
      ;;
    --runtime-footprint|--runtime-footprints)
      runtime_footprints_raw="${2:?$1 requires a value}"
      shift 2
      ;;
    --shared-buffers|--shared-buffer)
      shared_buffers_raw="${2:?$1 requires a value}"
      shift 2
      ;;
    --wal-buffers|--wal-buffer)
      wal_buffers_raw="${2:?$1 requires a value}"
      shift 2
      ;;
    --min-wal-size|--min-wal-sizes)
      min_wal_sizes_raw="${2:?$1 requires a value}"
      shift 2
      ;;
    --max-wal-size|--max-wal-sizes)
      max_wal_sizes_raw="${2:?$1 requires a value}"
      shift 2
      ;;
    --durability|--durabilities)
      durabilities_raw="${2:?$1 requires a value}"
      shift 2
      ;;
    --crash-recovery)
      crash_recovery="${2:?--crash-recovery requires a value}"
      shift 2
      ;;
    --summarize-only)
      summarize_only=1
      shift
      ;;
    --run-id)
      run_id="${2:?--run-id requires a value}"
      run_id_explicit=1
      if [[ "$output_dir_explicit" -eq 0 ]]; then
        output_dir="${OLIPHAUNT_MOBILE_FOOTPRINT_OUTPUT_DIR:-$repo_root/target/perf/mobile-footprint-$run_id}"
      fi
      shift 2
      ;;
    --output-dir)
      output_dir="${2:?--output-dir requires a value}"
      output_dir_explicit=1
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

case "$platform" in
  android|ios|both) ;;
  *)
    echo "unknown platform: $platform" >&2
    exit 2
    ;;
esac
case "$crash_recovery" in
  off|per-case) ;;
  *)
    echo "unknown --crash-recovery value: $crash_recovery" >&2
    exit 2
    ;;
esac
case "$wal_segsize_mb" in
  ''|*[!0-9]*)
    echo "--wal-segsize must be a positive integer number of megabytes" >&2
    exit 2
    ;;
esac
if [[ "$wal_segsize_mb" -le 0 ]]; then
  echo "--wal-segsize must be greater than zero" >&2
  exit 2
fi
if [[ "$summarize_only" -eq 1 && "$output_dir_explicit" -eq 1 && "$run_id_explicit" -eq 0 ]]; then
  output_basename="$(basename "$output_dir")"
  run_id="${output_basename#mobile-footprint-}"
fi

shared_buffers=(8MB 16MB 32MB 64MB 128MB)
wal_buffers=(-1 256kB 1MB 4MB)
min_wal_sizes=(8MB 16MB 32MB 80MB)
max_wal_sizes=(32MB 64MB default)
durabilities=(safe balanced)
runtime_footprints=()

value_in() {
  local wanted="$1"
  shift
  local value
  for value in "$@"; do
    if [[ "$value" = "$wanted" ]]; then
      return 0
    fi
  done
  return 1
}

print_axis_values() {
  local label="$1"
  local raw="$2"
  shift 2
  local allowed=("$@")
  local selected=()
  local old_ifs values value existing
  old_ifs="$IFS"
  IFS=","
  # shellcheck disable=SC2206
  values=($raw)
  IFS="$old_ifs"

  if [[ "${#values[@]}" -eq 0 ]]; then
    echo "$label list must not be empty" >&2
    exit 2
  fi

  for value in "${values[@]}"; do
    value="$(printf '%s' "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [[ -n "$value" ]] || continue
    if [[ "$value" = "all" ]]; then
      selected=("${allowed[@]}")
      break
    fi
    if ! value_in "$value" "${allowed[@]}"; then
      echo "unknown $label value: $value" >&2
      echo "expected all or one of: ${allowed[*]}" >&2
      exit 2
    fi
    if [[ "${#selected[@]}" -gt 0 ]]; then
      for existing in "${selected[@]}"; do
        if [[ "$existing" = "$value" ]]; then
          value=""
          break
        fi
      done
    fi
    [[ -n "$value" ]] && selected+=("$value")
  done

  if [[ "${#selected[@]}" -eq 0 ]]; then
    echo "$label list must not be empty" >&2
    exit 2
  fi
  printf '%s\n' "${selected[@]}"
}

add_runtime_footprint() {
  local profile="$1"
  local existing
  if [[ "${#runtime_footprints[@]}" -gt 0 ]]; then
    for existing in "${runtime_footprints[@]}"; do
      if [[ "$existing" = "$profile" ]]; then
        return
      fi
    done
  fi
  runtime_footprints+=("$profile")
}

normalize_runtime_footprints() {
  local raw="$1"
  local old_ifs value
  old_ifs="$IFS"
  IFS=","
  # shellcheck disable=SC2206
  local values=($raw)
  IFS="$old_ifs"

  if [[ "${#values[@]}" -eq 0 ]]; then
    echo "runtime footprint profile list must not be empty" >&2
    exit 2
  fi

  for value in "${values[@]}"; do
    value="$(printf '%s' "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [[ -n "$value" ]] || continue
    case "$value" in
      all)
        add_runtime_footprint throughput
        add_runtime_footprint balancedMobile
        add_runtime_footprint smallMobile
        ;;
      throughput|balancedMobile|smallMobile)
        add_runtime_footprint "$value"
        ;;
      *)
        echo "unknown runtime footprint profile: $value" >&2
        echo "expected throughput, balancedMobile, smallMobile, all, or a comma-separated list" >&2
        exit 2
        ;;
    esac
  done

  if [[ "${#runtime_footprints[@]}" -eq 0 ]]; then
    echo "runtime footprint profile list must not be empty" >&2
    exit 2
  fi
}

normalize_runtime_footprints "$runtime_footprints_raw"
shared_buffers=($(print_axis_values shared_buffers "$shared_buffers_raw" "${shared_buffers[@]}"))
wal_buffers=($(print_axis_values wal_buffers "$wal_buffers_raw" "${wal_buffers[@]}"))
min_wal_sizes=($(print_axis_values min_wal_size "$min_wal_sizes_raw" "${min_wal_sizes[@]}"))
max_wal_sizes=($(print_axis_values max_wal_size "$max_wal_sizes_raw" "${max_wal_sizes[@]}"))
durabilities=($(print_axis_values durability "$durabilities_raw" "${durabilities[@]}"))

platforms=()
case "$platform" in
  android) platforms=(android) ;;
  ios) platforms=(ios) ;;
  both) platforms=(android ios) ;;
esac

size_mb() {
  case "$1" in
    *MB) printf '%s\n' "${1%MB}" ;;
    default) printf '1048576\n' ;;
    *)
      echo "unsupported size value: $1" >&2
      exit 2
      ;;
  esac
}

is_valid_wal_min_for_segment() {
  local min_wal="$1"
  local segment_mb="$2"
  [[ "$(size_mb "$min_wal")" -ge $((segment_mb * 2)) ]]
}

is_valid_wal_range() {
  local min_wal="$1"
  local max_wal="$2"
  if [[ "$max_wal" = "default" ]]; then
    return 0
  fi
  [[ "$(size_mb "$max_wal")" -ge "$(size_mb "$min_wal")" ]]
}

shell_quote() {
  printf '%q' "$1"
}

case_slug() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'
}

write_case_metadata() {
  local case_dir="$1"
  local case_id="$2"
  local target_platform="$3"
  local durability="$4"
  local runtime_footprint="$5"
  local shared="$6"
  local wal="$7"
  local min_wal="$8"
  local max_wal="$9"
  local wal_segment_mb="${10}"
  local startup_gucs="${11}"
  local status="${12}"
  CASE_ID="$case_id" \
    CASE_PLATFORM="$target_platform" \
    CASE_DURABILITY="$durability" \
    CASE_RUNTIME_FOOTPRINT="$runtime_footprint" \
    CASE_SHARED_BUFFERS="$shared" \
    CASE_WAL_BUFFERS="$wal" \
    CASE_MIN_WAL_SIZE="$min_wal" \
    CASE_MAX_WAL_SIZE="$max_wal" \
    CASE_WAL_SEGMENT_SIZE_MB="$wal_segment_mb" \
    CASE_STARTUP_GUCS="$startup_gucs" \
    CASE_STATUS="$status" \
    node <<'NODE' >"$case_dir/case.json"
const data = {
  id: process.env.CASE_ID,
  platform: process.env.CASE_PLATFORM,
  durability: process.env.CASE_DURABILITY,
  runtimeFootprint: process.env.CASE_RUNTIME_FOOTPRINT,
  startupGUCs: process.env.CASE_STARTUP_GUCS,
  gucs: {
    shared_buffers: process.env.CASE_SHARED_BUFFERS,
    wal_buffers: process.env.CASE_WAL_BUFFERS,
    min_wal_size: process.env.CASE_MIN_WAL_SIZE,
    max_wal_size: process.env.CASE_MAX_WAL_SIZE,
    wal_segment_size_mb: process.env.CASE_WAL_SEGMENT_SIZE_MB,
  },
  status: process.env.CASE_STATUS,
};
process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
NODE
}

summarize_matrix() {
  MATRIX_OUTPUT_DIR="$output_dir" MATRIX_RUN_ID="$run_id" node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const outputDir = process.env.MATRIX_OUTPUT_DIR;
const casesDir = path.join(outputDir, 'cases');
const rows = [];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function workload(report, id) {
  return report?.workloads?.find(entry => entry.id === id);
}

function latency(report, id, field) {
  const value = workload(report, id)?.latency?.[field];
  return typeof value === 'number' ? value : null;
}

function throughput(report, id) {
  const value = workload(report, id)?.throughput?.rowsPerSecond;
  return typeof value === 'number' ? value : null;
}

function parseAndroidMemory(text) {
  const pss = text.match(/TOTAL PSS:\s*([0-9]+)/);
  const rss = text.match(/TOTAL RSS:\s*([0-9]+)/);
  return {
    androidPssKb: pss ? Number(pss[1]) : null,
    androidRssKb: rss ? Number(rss[1]) : null,
  };
}

function parseIosProcess(text) {
  const [, line] = text.trim().split(/\r?\n/);
  if (!line) {
    return { iosResidentKb: null, iosCpuPercent: null };
  }
  const [pid, rss, cpu] = line.split('\t');
  const rssValue = typeof rss === 'string' && rss.trim() !== '' ? Number(rss) : null;
  const cpuValue = typeof cpu === 'string' && cpu.trim() !== '' ? Number(cpu) : null;
  return {
    iosResidentKb: pid && Number.isFinite(rssValue) ? rssValue : null,
    iosCpuPercent: pid && Number.isFinite(cpuValue) ? cpuValue : null,
  };
}

function bytesToKb(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value / 1024 : null;
}

function parseProcessMemoryReport(report) {
  const memory = report?.processMemoryReport;
  if (!memory || typeof memory !== 'object') {
    return {
      processMemorySource: null,
      processResidentKb: null,
      processPhysicalFootprintKb: null,
      processVirtualKb: null,
      processPeakResidentKb: null,
      processTotalPssKb: null,
      processPrivateDirtyKb: null,
      processSharedDirtyKb: null,
    };
  }
  return {
    processMemorySource: typeof memory.source === 'string' ? memory.source : null,
    processResidentKb: bytesToKb(memory.residentBytes),
    processPhysicalFootprintKb: bytesToKb(memory.physicalFootprintBytes),
    processVirtualKb: bytesToKb(memory.virtualBytes),
    processPeakResidentKb: bytesToKb(memory.peakResidentBytes),
    processTotalPssKb: typeof memory.totalPssKb === 'number' && Number.isFinite(memory.totalPssKb)
      ? memory.totalPssKb
      : null,
    processPrivateDirtyKb: typeof memory.totalPrivateDirtyKb === 'number' && Number.isFinite(memory.totalPrivateDirtyKb)
      ? memory.totalPrivateDirtyKb
      : null,
    processSharedDirtyKb: typeof memory.totalSharedDirtyKb === 'number' && Number.isFinite(memory.totalSharedDirtyKb)
      ? memory.totalSharedDirtyKb
      : null,
  };
}

if (fs.existsSync(casesDir)) {
  for (const name of fs.readdirSync(casesDir).sort()) {
    const caseDir = path.join(casesDir, name);
    const stat = fs.statSync(caseDir);
    if (!stat.isDirectory()) {
      continue;
    }
    const meta = readJson(path.join(caseDir, 'case.json'));
    if (!meta) {
      continue;
    }
    const report = readJson(path.join(caseDir, 'scratch', 'reports', 'benchmark-report.json'));
    const crashReport = readJson(path.join(caseDir, 'crash-scratch', 'reports', 'crash-report.json'));
    const androidMemory = parseAndroidMemory(
      readText(path.join(caseDir, 'scratch', 'reports', 'benchmark-meminfo.txt')),
    );
    const iosProcess = parseIosProcess(
      readText(path.join(caseDir, 'scratch', 'reports', 'benchmark-process.tsv')),
    );
    const processMemory = parseProcessMemoryReport(report);
    const packageSizes = readJson(
      path.join(caseDir, 'scratch', 'reports', 'benchmark-package-sizes.json'),
    );
    rows.push({
      ...meta,
      reportPath: report ? path.relative(outputDir, path.join(caseDir, 'scratch', 'reports', 'benchmark-report.json')) : null,
      benchmarkPreset: typeof report?.metadata?.benchmarkPreset === 'string' ? report.metadata.benchmarkPreset : null,
      postgresSettings: report?.postgresSettings && typeof report.postgresSettings === 'object'
        ? report.postgresSettings
        : null,
      openMs: typeof report?.openMs === 'number' ? report.openMs : null,
      closeMs: typeof report?.closeMs === 'number' ? report.closeMs : null,
      elapsedMs: typeof report?.elapsedMs === 'number' ? report.elapsedMs : null,
      rawP50Ms: latency(report, 'raw_simple_query_rtt', 'p50Ms'),
      rawP90Ms: latency(report, 'raw_simple_query_rtt', 'p90Ms'),
      rawP95Ms: latency(report, 'raw_simple_query_rtt', 'p95Ms'),
      rawP99Ms: latency(report, 'raw_simple_query_rtt', 'p99Ms'),
      typedP50Ms: latency(report, 'typed_select_rtt', 'p50Ms'),
      typedP90Ms: latency(report, 'typed_select_rtt', 'p90Ms'),
      typedP95Ms: latency(report, 'typed_select_rtt', 'p95Ms'),
      typedP99Ms: latency(report, 'typed_select_rtt', 'p99Ms'),
      parameterizedP50Ms: latency(report, 'parameterized_select_rtt', 'p50Ms'),
      parameterizedP90Ms: latency(report, 'parameterized_select_rtt', 'p90Ms'),
      parameterizedP95Ms: latency(report, 'parameterized_select_rtt', 'p95Ms'),
      parameterizedP99Ms: latency(report, 'parameterized_select_rtt', 'p99Ms'),
      lookupP50Ms: latency(report, 'indexed_lookup', 'p50Ms'),
      lookupP90Ms: latency(report, 'indexed_lookup', 'p90Ms'),
      lookupP95Ms: latency(report, 'indexed_lookup', 'p95Ms'),
      lookupP99Ms: latency(report, 'indexed_lookup', 'p99Ms'),
      aggregateP50Ms: latency(report, 'indexed_aggregate', 'p50Ms'),
      aggregateP90Ms: latency(report, 'indexed_aggregate', 'p90Ms'),
      aggregateP95Ms: latency(report, 'indexed_aggregate', 'p95Ms'),
      aggregateP99Ms: latency(report, 'indexed_aggregate', 'p99Ms'),
      updateP50Ms: latency(report, 'indexed_update', 'p50Ms'),
      updateP90Ms: latency(report, 'indexed_update', 'p90Ms'),
      updateP95Ms: latency(report, 'indexed_update', 'p95Ms'),
      updateP99Ms: latency(report, 'indexed_update', 'p99Ms'),
      backgroundCheckpointP50Ms: latency(report, 'background_checkpoint', 'p50Ms'),
      backgroundCheckpointP90Ms: latency(report, 'background_checkpoint', 'p90Ms'),
      backgroundCheckpointP95Ms: latency(report, 'background_checkpoint', 'p95Ms'),
      backgroundCheckpointP99Ms: latency(report, 'background_checkpoint', 'p99Ms'),
      largeResultP50Ms: latency(report, 'large_result_raw', 'p50Ms'),
      largeResultP90Ms: latency(report, 'large_result_raw', 'p90Ms'),
      largeResultP95Ms: latency(report, 'large_result_raw', 'p95Ms'),
      largeResultP99Ms: latency(report, 'large_result_raw', 'p99Ms'),
      sqliteOpenMs: typeof report?.sqliteBenchmark?.openMs === 'number' ? report.sqliteBenchmark.openMs : null,
      sqliteSimpleP50Ms: latency(report?.sqliteBenchmark, 'sqlite_simple_select_rtt', 'p50Ms'),
      sqliteSimpleP90Ms: latency(report?.sqliteBenchmark, 'sqlite_simple_select_rtt', 'p90Ms'),
      sqliteSimpleP95Ms: latency(report?.sqliteBenchmark, 'sqlite_simple_select_rtt', 'p95Ms'),
      sqliteSimpleP99Ms: latency(report?.sqliteBenchmark, 'sqlite_simple_select_rtt', 'p99Ms'),
      sqliteParameterizedP50Ms: latency(report?.sqliteBenchmark, 'sqlite_parameterized_select_rtt', 'p50Ms'),
      sqliteParameterizedP90Ms: latency(report?.sqliteBenchmark, 'sqlite_parameterized_select_rtt', 'p90Ms'),
      sqliteParameterizedP95Ms: latency(report?.sqliteBenchmark, 'sqlite_parameterized_select_rtt', 'p95Ms'),
      sqliteParameterizedP99Ms: latency(report?.sqliteBenchmark, 'sqlite_parameterized_select_rtt', 'p99Ms'),
      sqliteLookupP50Ms: latency(report?.sqliteBenchmark, 'sqlite_indexed_lookup', 'p50Ms'),
      sqliteLookupP90Ms: latency(report?.sqliteBenchmark, 'sqlite_indexed_lookup', 'p90Ms'),
      sqliteLookupP95Ms: latency(report?.sqliteBenchmark, 'sqlite_indexed_lookup', 'p95Ms'),
      sqliteLookupP99Ms: latency(report?.sqliteBenchmark, 'sqlite_indexed_lookup', 'p99Ms'),
      sqliteAggregateP50Ms: latency(report?.sqliteBenchmark, 'sqlite_indexed_aggregate', 'p50Ms'),
      sqliteAggregateP90Ms: latency(report?.sqliteBenchmark, 'sqlite_indexed_aggregate', 'p90Ms'),
      sqliteAggregateP95Ms: latency(report?.sqliteBenchmark, 'sqlite_indexed_aggregate', 'p95Ms'),
      sqliteAggregateP99Ms: latency(report?.sqliteBenchmark, 'sqlite_indexed_aggregate', 'p99Ms'),
      sqliteUpdateP50Ms: latency(report?.sqliteBenchmark, 'sqlite_indexed_update', 'p50Ms'),
      sqliteUpdateP90Ms: latency(report?.sqliteBenchmark, 'sqlite_indexed_update', 'p90Ms'),
      sqliteUpdateP95Ms: latency(report?.sqliteBenchmark, 'sqlite_indexed_update', 'p95Ms'),
      sqliteUpdateP99Ms: latency(report?.sqliteBenchmark, 'sqlite_indexed_update', 'p99Ms'),
      sqliteCheckpointP50Ms: latency(report?.sqliteBenchmark, 'sqlite_wal_checkpoint', 'p50Ms'),
      sqliteCheckpointP90Ms: latency(report?.sqliteBenchmark, 'sqlite_wal_checkpoint', 'p90Ms'),
      sqliteCheckpointP95Ms: latency(report?.sqliteBenchmark, 'sqlite_wal_checkpoint', 'p95Ms'),
      sqliteCheckpointP99Ms: latency(report?.sqliteBenchmark, 'sqlite_wal_checkpoint', 'p99Ms'),
      sqliteLargeResultP50Ms: latency(report?.sqliteBenchmark, 'sqlite_large_result', 'p50Ms'),
      sqliteLargeResultP90Ms: latency(report?.sqliteBenchmark, 'sqlite_large_result', 'p90Ms'),
      sqliteLargeResultP95Ms: latency(report?.sqliteBenchmark, 'sqlite_large_result', 'p95Ms'),
      sqliteLargeResultP99Ms: latency(report?.sqliteBenchmark, 'sqlite_large_result', 'p99Ms'),
      sqliteInsertRowsPerSecond: throughput(report?.sqliteBenchmark, 'sqlite_transaction_insert'),
      crashRecoveryElapsedMs: typeof crashReport?.elapsedMs === 'number' ? crashReport.elapsedMs : null,
      crashRecoveryOpenMs: typeof crashReport?.openMs === 'number' ? crashReport.openMs : null,
      insertRowsPerSecond: throughput(report, 'transaction_insert'),
      packageBytes: typeof report?.packageSizeReport?.packageBytes === 'number'
        ? report.packageSizeReport.packageBytes
        : (typeof report?.packageBytes === 'number' ? report.packageBytes : null),
      androidApkBytes: typeof packageSizes?.apkBytes === 'number' ? packageSizes.apkBytes : null,
      iosAppBytes: typeof packageSizes?.iosAppBytes === 'number' ? packageSizes.iosAppBytes : null,
      rnPackageBytes: typeof packageSizes?.rnPackageBytes === 'number' ? packageSizes.rnPackageBytes : null,
      jsTimerTicks: typeof report?.jsTimerTicks === 'number' ? report.jsTimerTicks : null,
      androidPssKb: processMemory.processTotalPssKb ?? androidMemory.androidPssKb,
      androidRssKb: androidMemory.androidRssKb,
      iosResidentKb: processMemory.processResidentKb ?? iosProcess.iosResidentKb,
      iosPhysicalFootprintKb: processMemory.processPhysicalFootprintKb,
      iosVirtualKb: processMemory.processVirtualKb,
      iosPeakResidentKb: processMemory.processPeakResidentKb,
      iosCpuPercent: iosProcess.iosCpuPercent,
      processPrivateDirtyKb: processMemory.processPrivateDirtyKb,
      processSharedDirtyKb: processMemory.processSharedDirtyKb,
      processMemorySource: processMemory.processMemorySource,
    });
  }
}

const summary = {
  schemaVersion: 1,
  runId: process.env.MATRIX_RUN_ID,
  outputDir,
  generatedAt: new Date().toISOString(),
  caseCount: rows.length,
  passed: rows.filter(row => row.status === 'passed').length,
  failed: rows.filter(row => row.status === 'failed').length,
  rows,
};
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

function fmt(value, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '';
}

function fmtMb(kb) {
  return typeof kb === 'number' && Number.isFinite(kb) ? (kb / 1024).toFixed(1) : '';
}

function fmtBytesMb(bytes) {
  return typeof bytes === 'number' && Number.isFinite(bytes) ? (bytes / 1024 / 1024).toFixed(1) : '';
}

function effectiveGucSummary(settings) {
  if (!settings || typeof settings !== 'object') {
    return '';
  }
  return [
    'shared_buffers',
    'wal_buffers',
    'wal_segment_size',
    'min_wal_size',
    'max_wal_size',
    'synchronous_commit',
    'io_method',
  ]
    .map(name => {
      const value = settings[name];
      return typeof value === 'string' ? `${name}=${value}` : null;
    })
    .filter(Boolean)
    .join(', ');
}

const lines = [];
lines.push(`# Mobile Footprint Matrix ${summary.runId}`);
lines.push('');
lines.push(`- Generated: ${summary.generatedAt}`);
lines.push(`- Cases: ${summary.caseCount}; passed: ${summary.passed}; failed: ${summary.failed}`);
lines.push('');
const summaryColumns = [
  'Case', 'Platform', 'Durability', 'Runtime footprint', 'Benchmark preset',
  'shared_buffers', 'wal_buffers', 'min_wal_size', 'max_wal_size',
  'WAL segment MB', 'Effective GUCs', 'Open ms',
  'Raw p50 ms', 'Raw p90 ms', 'Raw p95 ms', 'Raw p99 ms',
  'Typed p50 ms', 'Typed p90 ms', 'Typed p95 ms', 'Typed p99 ms',
  'Param p50 ms', 'Param p90 ms', 'Param p95 ms', 'Param p99 ms',
  'Lookup p50 ms', 'Lookup p90 ms', 'Lookup p95 ms', 'Lookup p99 ms',
  'Aggregate p50 ms', 'Aggregate p90 ms', 'Aggregate p95 ms', 'Aggregate p99 ms',
  'Update p50 ms', 'Update p90 ms', 'Update p95 ms', 'Update p99 ms',
  'Background checkpoint p50 ms', 'Background checkpoint p90 ms',
  'Background checkpoint p95 ms', 'Background checkpoint p99 ms',
  'Large result p50 ms', 'Large result p90 ms', 'Large result p95 ms',
  'Large result p99 ms', 'Crash recovery ms', 'Crash recovery open ms',
  'Insert rows/s',
  'SQLite open ms', 'SQLite simple p50 ms', 'SQLite simple p90 ms',
  'SQLite simple p95 ms', 'SQLite simple p99 ms', 'SQLite param p50 ms',
  'SQLite param p90 ms', 'SQLite param p95 ms', 'SQLite param p99 ms',
  'SQLite lookup p50 ms', 'SQLite lookup p90 ms', 'SQLite lookup p95 ms',
  'SQLite lookup p99 ms', 'SQLite aggregate p50 ms', 'SQLite aggregate p90 ms',
  'SQLite aggregate p95 ms', 'SQLite aggregate p99 ms', 'SQLite update p50 ms',
  'SQLite update p90 ms', 'SQLite update p95 ms', 'SQLite update p99 ms',
  'SQLite checkpoint p50 ms', 'SQLite checkpoint p90 ms',
  'SQLite checkpoint p95 ms', 'SQLite checkpoint p99 ms',
  'SQLite large result p50 ms', 'SQLite large result p90 ms',
  'SQLite large result p95 ms', 'SQLite large result p99 ms',
  'SQLite insert rows/s', 'Oliphaunt payload MB', 'Android APK MB',
  'iOS app MB', 'RN package KB', 'Android PSS MB', 'Android RSS MB',
  'iOS RSS MB', 'iOS footprint MB', 'iOS CPU %', 'Memory source', 'Report',
];

function markdownRow(cells) {
  return `| ${cells.join(' | ')} |`;
}

lines.push(markdownRow(summaryColumns));
lines.push(markdownRow(summaryColumns.map(() => '---')));
for (const row of rows) {
  lines.push(markdownRow([
    row.status === 'passed' ? row.id : `${row.id} (${row.status})`,
    row.platform,
    row.durability,
    row.runtimeFootprint ?? '',
    row.benchmarkPreset ?? '',
    row.gucs?.shared_buffers ?? '',
    row.gucs?.wal_buffers ?? '',
    row.gucs?.min_wal_size ?? '',
    row.gucs?.max_wal_size ?? '',
    row.gucs?.wal_segment_size_mb ?? '',
    effectiveGucSummary(row.postgresSettings),
    fmt(row.openMs),
    fmt(row.rawP50Ms),
    fmt(row.rawP90Ms),
    fmt(row.rawP95Ms),
    fmt(row.rawP99Ms),
    fmt(row.typedP50Ms),
    fmt(row.typedP90Ms),
    fmt(row.typedP95Ms),
    fmt(row.typedP99Ms),
    fmt(row.parameterizedP50Ms),
    fmt(row.parameterizedP90Ms),
    fmt(row.parameterizedP95Ms),
    fmt(row.parameterizedP99Ms),
    fmt(row.lookupP50Ms),
    fmt(row.lookupP90Ms),
    fmt(row.lookupP95Ms),
    fmt(row.lookupP99Ms),
    fmt(row.aggregateP50Ms),
    fmt(row.aggregateP90Ms),
    fmt(row.aggregateP95Ms),
    fmt(row.aggregateP99Ms),
    fmt(row.updateP50Ms),
    fmt(row.updateP90Ms),
    fmt(row.updateP95Ms),
    fmt(row.updateP99Ms),
    fmt(row.backgroundCheckpointP50Ms),
    fmt(row.backgroundCheckpointP90Ms),
    fmt(row.backgroundCheckpointP95Ms),
    fmt(row.backgroundCheckpointP99Ms),
    fmt(row.largeResultP50Ms),
    fmt(row.largeResultP90Ms),
    fmt(row.largeResultP95Ms),
    fmt(row.largeResultP99Ms),
    fmt(row.crashRecoveryElapsedMs),
    fmt(row.crashRecoveryOpenMs),
    fmt(row.insertRowsPerSecond, 0),
    fmt(row.sqliteOpenMs),
    fmt(row.sqliteSimpleP50Ms),
    fmt(row.sqliteSimpleP90Ms),
    fmt(row.sqliteSimpleP95Ms),
    fmt(row.sqliteSimpleP99Ms),
    fmt(row.sqliteParameterizedP50Ms),
    fmt(row.sqliteParameterizedP90Ms),
    fmt(row.sqliteParameterizedP95Ms),
    fmt(row.sqliteParameterizedP99Ms),
    fmt(row.sqliteLookupP50Ms),
    fmt(row.sqliteLookupP90Ms),
    fmt(row.sqliteLookupP95Ms),
    fmt(row.sqliteLookupP99Ms),
    fmt(row.sqliteAggregateP50Ms),
    fmt(row.sqliteAggregateP90Ms),
    fmt(row.sqliteAggregateP95Ms),
    fmt(row.sqliteAggregateP99Ms),
    fmt(row.sqliteUpdateP50Ms),
    fmt(row.sqliteUpdateP90Ms),
    fmt(row.sqliteUpdateP95Ms),
    fmt(row.sqliteUpdateP99Ms),
    fmt(row.sqliteCheckpointP50Ms),
    fmt(row.sqliteCheckpointP90Ms),
    fmt(row.sqliteCheckpointP95Ms),
    fmt(row.sqliteCheckpointP99Ms),
    fmt(row.sqliteLargeResultP50Ms),
    fmt(row.sqliteLargeResultP90Ms),
    fmt(row.sqliteLargeResultP95Ms),
    fmt(row.sqliteLargeResultP99Ms),
    fmt(row.sqliteInsertRowsPerSecond, 0),
    fmtBytesMb(row.packageBytes),
    fmtBytesMb(row.androidApkBytes),
    fmtBytesMb(row.iosAppBytes),
    typeof row.rnPackageBytes === 'number' && Number.isFinite(row.rnPackageBytes)
      ? (row.rnPackageBytes / 1024).toFixed(1)
      : '',
    fmtMb(row.androidPssKb),
    fmtMb(row.androidRssKb),
    fmtMb(row.iosResidentKb),
    fmtMb(row.iosPhysicalFootprintKb),
    fmt(row.iosCpuPercent),
    row.processMemorySource ?? '',
    row.reportPath ? `\`${row.reportPath}\`` : '',
  ]));
}
lines.push('');
fs.writeFileSync(path.join(outputDir, 'summary.md'), `${lines.join('\n')}\n`);
NODE
}

print_or_run() {
  local target_platform="$1"
  local runtime_footprint="$2"
  local durability="$3"
  local shared="$4"
  local wal="$5"
  local min_wal="$6"
  local max_wal="$7"
  local startup_gucs="shared_buffers=$shared,wal_buffers=$wal,min_wal_size=$min_wal"
  if [[ "$max_wal" != "default" ]]; then
    startup_gucs="$startup_gucs,max_wal_size=$max_wal"
  fi
  local script="bench:$target_platform"
  local crash_script="crash:$target_platform"
  local raw_case_id="$target_platform-profile-$runtime_footprint-$durability-shared-$shared-wal-$wal-minwal-$min_wal-maxwal-$max_wal-walseg-${wal_segsize_mb}MB"
  local case_id
  case_id="$(case_slug "$raw_case_id")"
  local case_dir="$output_dir/cases/$case_id"
  local scratch="$case_dir/scratch"
  local crash_scratch="$case_dir/crash-scratch"
  local benchmark_preset=full
  if [[ "$quick" -eq 1 ]]; then
    benchmark_preset=quick
  fi
  local base_prefix=(
    env
    "OLIPHAUNT_EXPO_MOBILE_DURABILITY=$durability"
    "OLIPHAUNT_EXPO_MOBILE_RUNTIME_FOOTPRINT=$runtime_footprint"
    "OLIPHAUNT_EXPO_MOBILE_STARTUP_GUCS=$startup_gucs"
    "OLIPHAUNT_EXPO_MOBILE_WAL_SEGSIZE_MB=$wal_segsize_mb"
    "OLIPHAUNT_EXPO_MOBILE_BENCHMARK_PRESET=$benchmark_preset"
  )
  local prefix=("${base_prefix[@]}")
  local crash_prefix=("${base_prefix[@]}")
  local run_crash=0
  if [[ "$crash_recovery" = "per-case" && "$durability" = "safe" ]]; then
    run_crash=1
  fi

  case "$target_platform" in
    android) prefix+=("OLIPHAUNT_EXPO_ANDROID_SCRATCH=$scratch") ;;
    ios) prefix+=("OLIPHAUNT_EXPO_IOS_SCRATCH=$scratch") ;;
  esac
  if [[ "$run_crash" -eq 1 ]]; then
    case "$target_platform" in
      android) crash_prefix+=("OLIPHAUNT_EXPO_ANDROID_SCRATCH=$crash_scratch") ;;
      ios) crash_prefix+=("OLIPHAUNT_EXPO_IOS_SCRATCH=$crash_scratch") ;;
    esac
  fi

  if [[ "$quick" -eq 1 ]]; then
    case "$target_platform" in
      android)
        prefix+=("OLIPHAUNT_EXPO_ANDROID_TIMEOUT_SECONDS=240")
        crash_prefix+=("OLIPHAUNT_EXPO_ANDROID_TIMEOUT_SECONDS=240")
        ;;
      ios)
        prefix+=("OLIPHAUNT_EXPO_IOS_TIMEOUT_SECONDS=240")
        crash_prefix+=("OLIPHAUNT_EXPO_IOS_TIMEOUT_SECONDS=240")
        ;;
    esac
  fi

  if [[ "$plan_only" -eq 1 ]]; then
    printf 'case platform=%s durability=%s runtimeFootprint=%s shared_buffers=%s wal_buffers=%s min_wal_size=%s max_wal_size=%s wal_segment_size_mb=%s\n' \
      "$target_platform" "$durability" "$runtime_footprint" "$shared" "$wal" "$min_wal" "$max_wal" "$wal_segsize_mb"
    printf 'benchmarkPreset=%s\n' "$benchmark_preset"
    printf 'caseId=%s\n' "$case_id"
    printf 'caseOutputDir=%s\n' "$case_dir"
    printf 'command='
    for part in "${prefix[@]}"; do
      printf '%s ' "$(shell_quote "$part")"
    done
    printf 'pnpm --dir %s run %s\n' "$(shell_quote "$example_dir")" "$(shell_quote "$script")"
    if [[ "$run_crash" -eq 1 ]]; then
      printf 'crashCommand='
      for part in "${crash_prefix[@]}"; do
        printf '%s ' "$(shell_quote "$part")"
      done
      printf 'pnpm --dir %s run %s\n' "$(shell_quote "$example_dir")" "$(shell_quote "$crash_script")"
    elif [[ "$crash_recovery" = "per-case" ]]; then
      printf 'crashCommand=skipped durability=%s reason=synchronous_commit_off_does_not_guarantee_last_commit\n' "$durability"
    fi
    return
  fi

  mkdir -p "$case_dir"
  write_case_metadata \
    "$case_dir" \
    "$case_id" \
    "$target_platform" \
    "$durability" \
    "$runtime_footprint" \
    "$shared" \
    "$wal" \
    "$min_wal" \
    "$max_wal" \
    "$wal_segsize_mb" \
    "$startup_gucs" \
    "running"

  echo "==> mobile footprint case $case_id"
  set +e
  "${prefix[@]}" pnpm --dir "$example_dir" run "$script" 2>&1 | tee "$case_dir/harness.log"
  local status="${PIPESTATUS[0]}"
  if [[ "$status" -eq 0 && "$run_crash" -eq 1 ]]; then
    "${crash_prefix[@]}" pnpm --dir "$example_dir" run "$crash_script" 2>&1 | tee "$case_dir/crash-harness.log"
    status="${PIPESTATUS[0]}"
  fi
  set -e
  if [[ "$status" -eq 0 ]]; then
    write_case_metadata \
      "$case_dir" \
      "$case_id" \
      "$target_platform" \
      "$durability" \
      "$runtime_footprint" \
      "$shared" \
      "$wal" \
      "$min_wal" \
      "$max_wal" \
      "$wal_segsize_mb" \
      "$startup_gucs" \
      "passed"
  else
    write_case_metadata \
      "$case_dir" \
      "$case_id" \
      "$target_platform" \
      "$durability" \
      "$runtime_footprint" \
      "$shared" \
      "$wal" \
      "$min_wal" \
      "$max_wal" \
      "$wal_segsize_mb" \
      "$startup_gucs" \
      "failed"
    if [[ "$keep_going" -ne 1 ]]; then
      summarize_matrix
      exit "$status"
    fi
  fi
}

if [[ "$summarize_only" -eq 1 ]]; then
  summarize_matrix
  printf 'mobile footprint summary: %s\n' "$output_dir/summary.md"
  exit 0
fi

planned=0
skipped=0
skipped_wal_range=0
for target_platform in "${platforms[@]}"; do
  for runtime_footprint in "${runtime_footprints[@]}"; do
    for durability in "${durabilities[@]}"; do
      for shared in "${shared_buffers[@]}"; do
        for wal in "${wal_buffers[@]}"; do
          for min_wal in "${min_wal_sizes[@]}"; do
            for max_wal in "${max_wal_sizes[@]}"; do
              if ! is_valid_wal_min_for_segment "$min_wal" "$wal_segsize_mb" && [[ "$include_invalid_wal_min" -ne 1 ]]; then
                skipped=$((skipped + 1))
                continue
              fi
              if ! is_valid_wal_range "$min_wal" "$max_wal"; then
                skipped_wal_range=$((skipped_wal_range + 1))
                continue
              fi
              planned=$((planned + 1))
              print_or_run "$target_platform" "$runtime_footprint" "$durability" "$shared" "$wal" "$min_wal" "$max_wal"
            done
          done
        done
      done
    done
  done
done

if [[ "$plan_only" -eq 1 ]]; then
  printf 'runId=%s\n' "$run_id"
  printf 'outputDir=%s\n' "$output_dir"
  printf 'planned=%s\n' "$planned"
  printf 'walSegmentSizeMB=%s\n' "$wal_segsize_mb"
  printf 'skippedInvalidForWalSegment=%s\n' "$skipped"
  printf 'skippedInvalidWalRange=%s\n' "$skipped_wal_range"
else
  summarize_matrix
  printf 'mobile footprint summary: %s\n' "$output_dir/summary.md"
fi
