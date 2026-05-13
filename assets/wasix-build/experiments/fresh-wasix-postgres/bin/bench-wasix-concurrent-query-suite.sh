#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

usage() {
  cat <<'USAGE'
Usage: bench-wasix-concurrent-query-suite.sh [options]

Runs native PostgreSQL and WASIX PostgreSQL under the same concurrent client
fanout, then records wall throughput, psql timing, verification counts, and
runtime epoll interruption counts.

Options:
  --connections N       Concurrent psql clients. Default: 4.
  --iterations N        Operations per client. Default: 1000.
  --rows N              Seed rows for read/update workloads. Default: 100000.
  --workload NAME       Workload to run. May repeat.
                         Names: indexed-read, mixed-write, indexed-update,
                         indexed-insert. Aliases: read, mwrite, iupdate,
                         indexed.
  --workloads LIST      Space-separated workload names.
  --target NAME         Target to run. May repeat. Names: native, wasix.
  --skip-native         Only run WASIX.
  --skip-wasix          Only run native.
  --skip-build          Require existing installs.
  --skip-precompile     Reuse current Wasmer cache.
  --timeout SECONDS     Per setup/client/verify timeout. Default: 120.
  --resource-interval S Process resource sample interval in seconds. Default: 0.5.
  --pg-wait-sample-interval S
                       Sample pg_stat_activity wait events during each fanout.
                       Default: 0 (disabled).
  --wasix-perf-stats   Enable WASIX perf-stats counters for the WASIX target.
                       Requires a Wasmer build with wasmer-wasix/perf-stats.
  --wasix-wait-dump-interval-ms MS
                       Dump live futex/epoll/socket wait registry state while
                       waits remain parked. Requires a wait-dump capable Wasmer
                       build, but does not require counters to be enabled.
                       Default: 0.
  --wasix-wait-dump-max-per-wait N
                       Maximum wait-registry snapshots per individual parked
                       wait before logging one suppression marker. Use 0 for
                       unlimited. Default: 8.
  --memory-map-snapshots
                       Capture vmmap/pmap snapshots at readiness and fanout
                       boundaries. Expensive and off by default.
  --sample-seconds S   Run sample(1) against the WASIX server during fanout.
                       Default: 0 (disabled).
  --sample-delay S     Delay after fanout starts before sample(1). Default: 0.2.
  --start-port PORT     First PostgreSQL port. Default: PGPORT or 55620.
  --label NAME          Report/run label. Default: timestamped.
  --postgres-guc GUC    Extra postmaster -c name=value setting. May repeat.
  --wasmer-arg ARG      Extra wasmer run argument. May repeat.
  -h, --help            Show this help.
USAGE
}

connections="${WASIX_CONCURRENT_CONNECTIONS:-4}"
iterations="${WASIX_CONCURRENT_ITERATIONS:-1000}"
row_count="${WASIX_CONCURRENT_ROWS:-100000}"
timeout_seconds="${WASIX_CONCURRENT_TIMEOUT:-120}"
resource_sample_interval="${WASIX_RESOURCE_SAMPLE_INTERVAL:-0.5}"
pg_wait_sample_interval="${WASIX_PG_WAIT_SAMPLE_INTERVAL:-0}"
start_port="${PGPORT:-55620}"
run_label="${WASIX_CONCURRENT_LABEL:-$(date -u +%Y%m%dT%H%M%SZ)}"
skip_build=0
skip_precompile="${WASIX_SKIP_PRECOMPILE:-0}"
wasix_perf_stats="${WASIX_PERF_STATS:-0}"
wasix_wait_dump_interval_ms="${WASIX_PERF_WAIT_DUMP_INTERVAL_MS:-0}"
wasix_wait_dump_max_per_wait="${WASIX_WAIT_DUMP_MAX_PER_WAIT:-8}"
memory_map_snapshots="${WASIX_MEMORY_MAP_SNAPSHOTS:-0}"
sample_seconds="${WASIX_CONCURRENT_SAMPLE_SECONDS:-0}"
sample_delay="${WASIX_CONCURRENT_SAMPLE_DELAY:-0.2}"
targets=()
workloads=()
postgres_gucs=()
wasmer_extra_args=()

default_workloads=(
  indexed-read
  mixed-write
  indexed-update
  indexed-insert
)

while [ "$#" -gt 0 ]; do
  case "$1" in
    --connections)
      shift
      [ "$#" -gt 0 ] || { echo "--connections requires a value" >&2; exit 2; }
      connections="$1"
      ;;
    --iterations)
      shift
      [ "$#" -gt 0 ] || { echo "--iterations requires a value" >&2; exit 2; }
      iterations="$1"
      ;;
    --rows)
      shift
      [ "$#" -gt 0 ] || { echo "--rows requires a value" >&2; exit 2; }
      row_count="$1"
      ;;
    --workload)
      shift
      [ "$#" -gt 0 ] || { echo "--workload requires a value" >&2; exit 2; }
      workloads+=("$1")
      ;;
    --workloads)
      shift
      [ "$#" -gt 0 ] || { echo "--workloads requires a value" >&2; exit 2; }
      for workload in $1; do
        workloads+=("$workload")
      done
      ;;
    --target)
      shift
      [ "$#" -gt 0 ] || { echo "--target requires native or wasix" >&2; exit 2; }
      targets+=("$1")
      ;;
    --skip-native)
      targets=(wasix)
      ;;
    --skip-wasix)
      targets=(native)
      ;;
    --skip-build)
      skip_build=1
      ;;
    --skip-precompile)
      skip_precompile=1
      ;;
    --timeout)
      shift
      [ "$#" -gt 0 ] || { echo "--timeout requires a value" >&2; exit 2; }
      timeout_seconds="$1"
      ;;
    --resource-interval)
      shift
      [ "$#" -gt 0 ] || { echo "--resource-interval requires a value" >&2; exit 2; }
      resource_sample_interval="$1"
      ;;
    --pg-wait-sample-interval)
      shift
      [ "$#" -gt 0 ] || { echo "--pg-wait-sample-interval requires a value" >&2; exit 2; }
      pg_wait_sample_interval="$1"
      ;;
    --wasix-perf-stats)
      wasix_perf_stats=1
      ;;
    --wasix-wait-dump-interval-ms)
      shift
      [ "$#" -gt 0 ] || { echo "--wasix-wait-dump-interval-ms requires a value" >&2; exit 2; }
      wasix_wait_dump_interval_ms="$1"
      ;;
    --wasix-wait-dump-max-per-wait)
      shift
      [ "$#" -gt 0 ] || { echo "--wasix-wait-dump-max-per-wait requires a value" >&2; exit 2; }
      wasix_wait_dump_max_per_wait="$1"
      ;;
    --memory-map-snapshots|--vmmap-snapshots)
      memory_map_snapshots=1
      ;;
    --sample-seconds)
      shift
      [ "$#" -gt 0 ] || { echo "--sample-seconds requires a value" >&2; exit 2; }
      sample_seconds="$1"
      ;;
    --sample-delay)
      shift
      [ "$#" -gt 0 ] || { echo "--sample-delay requires a value" >&2; exit 2; }
      sample_delay="$1"
      ;;
    --start-port)
      shift
      [ "$#" -gt 0 ] || { echo "--start-port requires a value" >&2; exit 2; }
      start_port="$1"
      ;;
    --label)
      shift
      [ "$#" -gt 0 ] || { echo "--label requires a value" >&2; exit 2; }
      run_label="$1"
      ;;
    --postgres-guc)
      shift
      [ "$#" -gt 0 ] || { echo "--postgres-guc requires name=value" >&2; exit 2; }
      postgres_gucs+=("$1")
      ;;
    --wasmer-arg)
      shift
      [ "$#" -gt 0 ] || { echo "--wasmer-arg requires a value" >&2; exit 2; }
      wasmer_extra_args+=("$1")
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

case "$connections" in ''|*[!0-9]*|0) echo "--connections requires a positive integer" >&2; exit 2 ;; esac
case "$iterations" in ''|*[!0-9]*|0) echo "--iterations requires a positive integer" >&2; exit 2 ;; esac
case "$row_count" in ''|*[!0-9]*|0) echo "--rows requires a positive integer" >&2; exit 2 ;; esac
case "$timeout_seconds" in ''|*[!0-9]*|0) echo "--timeout requires a positive integer" >&2; exit 2 ;; esac
case "$resource_sample_interval" in ''|*[!0-9.]*) echo "--resource-interval requires a positive number" >&2; exit 2 ;; esac
case "$pg_wait_sample_interval" in ''|*[!0-9.]*) echo "--pg-wait-sample-interval requires a non-negative number" >&2; exit 2 ;; esac
case "$sample_seconds" in ''|*[!0-9.]*) echo "--sample-seconds requires a non-negative number" >&2; exit 2 ;; esac
case "$sample_delay" in ''|*[!0-9.]*) echo "--sample-delay requires a non-negative number" >&2; exit 2 ;; esac
case "$wasix_wait_dump_interval_ms" in ''|*[!0-9]*) echo "--wasix-wait-dump-interval-ms requires a non-negative integer" >&2; exit 2 ;; esac
case "$wasix_wait_dump_max_per_wait" in ''|*[!0-9]*) echo "--wasix-wait-dump-max-per-wait requires a non-negative integer" >&2; exit 2 ;; esac
case "$start_port" in ''|*[!0-9]*) echo "--start-port requires a port number" >&2; exit 2 ;; esac
case "$run_label" in ""|*[!A-Za-z0-9._-]*) echo "--label may only contain letters, numbers, '.', '_', and '-'" >&2; exit 2 ;; esac
case "$(printf '%s' "$wasix_perf_stats" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) wasix_perf_stats=1 ;;
  0|false|no|off|"") wasix_perf_stats=0 ;;
  *) echo "WASIX_PERF_STATS must be 0/1, true/false, yes/no, or on/off" >&2; exit 2 ;;
esac
case "$(printf '%s' "$memory_map_snapshots" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) memory_map_snapshots=1 ;;
  0|false|no|off|"") memory_map_snapshots=0 ;;
  *) echo "WASIX_MEMORY_MAP_SNAPSHOTS must be 0/1, true/false, yes/no, or on/off" >&2; exit 2 ;;
esac

normalize_workload() {
  case "$1" in
    read|indexed-read|iread) echo "indexed-read" ;;
    mwrite|mixed-write|multi-write) echo "mixed-write" ;;
    iupdate|indexed-update) echo "indexed-update" ;;
    indexed|indexed-insert|iinsert) echo "indexed-insert" ;;
    *)
      printf 'unknown workload: %s\n' "$1" >&2
      return 2
      ;;
  esac
}

normalize_target() {
  case "$1" in
    native|wasix) echo "$1" ;;
    *)
      printf 'unknown target: %s\n' "$1" >&2
      return 2
      ;;
  esac
}

if [ "${#workloads[@]}" -eq 0 ]; then
  workloads=("${default_workloads[@]}")
fi
if [ "${#targets[@]}" -eq 0 ]; then
  targets=(native wasix)
fi

normalized_workloads=()
for workload in "${workloads[@]}"; do
  normalized_workloads+=("$(normalize_workload "$workload")")
done
workloads=("${normalized_workloads[@]}")

normalized_targets=()
for target in "${targets[@]}"; do
  normalized_targets+=("$(normalize_target "$target")")
done
targets=("${normalized_targets[@]}")

fresh_ensure_dirs

setup_rows="$row_count"
min_setup_rows=$((connections * iterations))
if [ "$setup_rows" -lt "$min_setup_rows" ]; then
  setup_rows="$min_setup_rows"
fi

if [ ! -x "$NATIVE_INSTALL_DIR/bin/psql" ] || [ ! -x "$NATIVE_INSTALL_DIR/bin/postgres" ]; then
  if [ "$skip_build" -eq 1 ]; then
    printf 'missing native install with --skip-build: %s\n' "$NATIVE_INSTALL_DIR" >&2
    exit 2
  fi
  "$FRESH_ROOT/bin/build-native-oracle.sh" >/dev/null
fi

need_wasix=0
for target in "${targets[@]}"; do
  [ "$target" = "wasix" ] && need_wasix=1
done

if [ "$need_wasix" -eq 1 ]; then
  if [ ! -x "$WASIX_INSTALL_DIR/bin/postgres" ] || [ ! -x "$WASIX_INSTALL_DIR/bin/initdb" ]; then
    if [ "$skip_build" -eq 1 ]; then
      printf 'missing WASIX install with --skip-build: %s\n' "$WASIX_INSTALL_DIR" >&2
      exit 2
    fi
    "$FRESH_ROOT/bin/build-wasix-core.sh" >/dev/null
  fi
fi

now_ms() {
  if command -v perl >/dev/null 2>&1; then
    perl -MTime::HiRes=time -e 'printf "%.0f\n", time() * 1000'
  else
    printf '%s000\n' "$(date +%s)"
  fi
}

calc_rate() {
  local operations="$1"
  local wall_ms="$2"
  perl -e 'my ($ops, $ms) = @ARGV; printf "%.3f", $ms > 0 ? ($ops * 1000.0 / $ms) : 0' \
    "$operations" "$wall_ms"
}

float_gt_zero() {
  perl -e 'exit !(($ARGV[0] + 0) > 0)' "$1"
}

extract_psql_time_sum_ms() {
  local log="$1"
  awk '/^Time: [0-9.]+ ms/ { sum += $2; count += 1 } END { if (count == 0) printf ""; else printf "%.3f", sum }' "$log"
}

extract_psql_time_count() {
  local log="$1"
  awk '/^Time: [0-9.]+ ms/ { count += 1 } END { printf "%d", count }' "$log"
}

run_logged_timeout() {
  local timeout="$1"
  shift
  local log="$1"
  shift
  local pid child_pid status_file started_ms elapsed_seconds status

  status_file="$log.status.$$.$RANDOM"
  rm -f "$status_file"
  (
    child_pid=""
    trap 'status=124; if [ -n "$child_pid" ]; then kill "$child_pid" 2>/dev/null || true; wait "$child_pid" 2>/dev/null || true; fi; printf "%s\n" "$status" >"$status_file"; exit "$status"' TERM INT
    "$@" >"$log" 2>&1 &
    child_pid=$!
    wait "$child_pid"
    status=$?
    printf "%s\n" "$status" >"$status_file"
    exit "$status"
  ) &
  pid=$!
  started_ms="$(now_ms)"
  while [ ! -f "$status_file" ]; do
    elapsed_seconds=$((( $(now_ms) - started_ms ) / 1000))
    if [ "$elapsed_seconds" -ge "$timeout" ]; then
      {
        printf '\ncommand timed out after %s seconds\n' "$timeout"
        printf 'command:'
        printf ' %q' "$@"
        printf '\n'
      } >>"$log"
      kill "$pid" 2>/dev/null || true
      sleep 0.5
      kill -9 "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      rm -f "$status_file"
      return 124
    fi
    sleep 0.05
  done
  wait "$pid" 2>/dev/null || true
  status="$(tr -d '[:space:]' <"$status_file")"
  rm -f "$status_file"
  case "$status" in ''|*[!0-9]*) return 1 ;; esac
  return "$status"
}

collect_process_tree() {
  local root_pid="$1"
  ps -axo pid=,ppid= | awk -v root="$root_pid" '
    {
      pid = $1
      ppid = $2
      seen[pid] = 1
      parent[pid] = ppid
    }
    END {
      if (!(root in seen)) {
        exit
      }
      for (pid in seen) {
        cur = pid
        depth = 0
        while (cur != "" && depth < 10000) {
          if (cur == root) {
            print pid
            break
          }
          cur = parent[cur]
          depth++
        }
      }
    }
  '
}

set_resource_phase() {
  local phase_file="$1"
  local phase="$2"
  printf '%s\n' "$phase" >"$phase_file" 2>/dev/null || true
}

monitor_resource_usage() {
  local target="$1"
  local root_pid="$2"
  local phase_file="$3"
  local stop_file="$4"
  local samples_tsv="$5"
  local interval="$6"
  local now phase pids pid_csv metrics

  printf 'unix_ms\ttarget\tphase\troot_pid\tprocess_count\trss_kb_total\tvsz_kb_total\tcpu_percent_total\tmax_rss_kb_per_pid\tpids\n' >"$samples_tsv"
  while :; do
    now="$(now_ms)"
    phase="$(tr -d '[:space:]' <"$phase_file" 2>/dev/null || true)"
    [ -n "$phase" ] || phase="unknown"
    pids="$(collect_process_tree "$root_pid" | sort -n | tr '\n' ' ')"
    if [ -n "$pids" ]; then
      pid_csv="$(printf '%s\n' "$pids" | awk '{$1=$1; gsub(/ /, ","); print}')"
      metrics="$(ps -o rss= -o vsz= -o %cpu= -p "$pid_csv" 2>/dev/null | awk '
        {
          rss += $1
          vsz += $2
          cpu += $3
          if ($1 > maxrss) {
            maxrss = $1
          }
          count += 1
        }
        END {
          printf "%d\t%d\t%d\t%.1f\t%d", count, rss, vsz, cpu, maxrss
        }
      ')"
      [ -n "$metrics" ] || metrics="0	0	0	0.0	0"
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$now" "$target" "$phase" "$root_pid" "$metrics" "$pids" >>"$samples_tsv"
    else
      printf '%s\t%s\t%s\t%s\t0\t0\t0\t0.0\t0\t\n' "$now" "$target" "$phase" "$root_pid" >>"$samples_tsv"
    fi
    [ -f "$stop_file" ] && break
    sleep "$interval"
  done
}

summarize_resource_usage() {
  local target="$1"
  local samples_tsv="$2"
  local out_tsv="$3"
  awk -F '\t' -v target="$target" -v samples="$samples_tsv" '
    NR == 1 { next }
    {
      phase = $3
      if (phase == "") {
        phase = "unknown"
      }
      samples_count[phase] += 1
      if (($6 + 0) > peak_rss[phase]) {
        peak_rss[phase] = $6 + 0
      }
      if (($7 + 0) > peak_vsz[phase]) {
        peak_vsz[phase] = $7 + 0
      }
      if (($8 + 0) > peak_cpu[phase]) {
        peak_cpu[phase] = $8 + 0
      }
      if (($5 + 0) > peak_processes[phase]) {
        peak_processes[phase] = $5 + 0
      }
    }
    END {
      for (phase in samples_count) {
        printf "%s\t%s\t%d\t%.3f\t%d\t%.1f\t%d\t%d\t%s\n",
          target,
          phase,
          peak_rss[phase],
          peak_rss[phase] / 1024.0,
          peak_vsz[phase],
          peak_cpu[phase],
          peak_processes[phase],
          samples_count[phase],
          samples
      }
    }
  ' "$samples_tsv" | sort >>"$out_tsv"
}

sample_pg_wait_events() {
  local target="$1"
  local workload="$2"
  local conn="$3"
  local stop_file="$4"
  local samples_tsv="$5"
  local interval="$6"
  local now rows

  printf 'unix_ms\ttarget\tworkload\twait_event_type\twait_event\tstate\tbackend_type\tcount\n' >"$samples_tsv"
  while :; do
    now="$(now_ms)"
    rows="$("$NATIVE_INSTALL_DIR/bin/psql" "$conn" -XAtq -F $'\t' -v ON_ERROR_STOP=1 -c "
      SELECT
        coalesce(wait_event_type, ''),
        coalesce(wait_event, ''),
        coalesce(state, ''),
        coalesce(backend_type, ''),
        count(*)::bigint
      FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
      GROUP BY 1, 2, 3, 4
      ORDER BY 5 DESC, 1, 2, 3, 4
    " 2>/dev/null || true)"
    if [ -n "$rows" ]; then
      while IFS= read -r row; do
        [ -n "$row" ] || continue
        printf '%s\t%s\t%s\t%s\n' "$now" "$target" "$workload" "$row" >>"$samples_tsv"
      done <<<"$rows"
    else
      printf '%s\t%s\t%s\t\t\t\t\t0\n' "$now" "$target" "$workload" >>"$samples_tsv"
    fi
    [ -f "$stop_file" ] && break
    sleep "$interval"
  done
}

summarize_pg_wait_events() {
  local samples_tsv="$1"
  local out_tsv="$2"

  {
    printf "wait_event_type\twait_event\tstate\tbackend_type\tsample_rows\tbackend_observations\tmax_count\n"
    awk -F '\t' '
      NR == 1 { next }
      {
        key = $4 "\t" $5 "\t" $6 "\t" $7
        count = $8 + 0
        total[key] += count
        samples[key] += 1
        if (count > max_count[key]) {
          max_count[key] = count
        }
      }
      END {
        for (key in total) {
          printf "%s\t%d\t%d\t%d\n", key, samples[key], total[key], max_count[key]
        }
      }
    ' "$samples_tsv" | sort -t $'\t' -k6,6nr
  } >"$out_tsv"
}

capture_relation_footprint() {
  local conn="$1"
  local workload="$2"
  local out_tsv="$3"

  "$NATIVE_INSTALL_DIR/bin/psql" "$conn" -XAtq -F $'\t' -v ON_ERROR_STOP=1 -c "
    SELECT
      current_setting('data_directory') AS data_directory,
      n.nspname,
      c.relname,
      c.relkind,
      pg_relation_filepath(c.oid),
      pg_relation_size(c.oid)::bigint,
      pg_total_relation_size(c.oid)::bigint
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname LIKE 'cqb_%'
    ORDER BY c.relname, c.relkind
  " >"$out_tsv.tmp" 2>"$out_tsv.stderr" || true
  {
    printf 'workload\tdata_directory\tschema\trelation\trelkind\tpath\trelation_bytes\ttotal_bytes\n'
    awk -F '\t' -v workload="$workload" '{ print workload "\t" $0 }' "$out_tsv.tmp"
  } >"$out_tsv"
  rm -f "$out_tsv.tmp"
}

snapshot_memory_map() {
  local target="$1"
  local root_pid="$2"
  local label="$3"
  local out_dir="$4"
  local snapshot_dir safe_label pids pid pid_csv

  [ "$memory_map_snapshots" -eq 1 ] || return 0
  if ! kill -0 "$root_pid" 2>/dev/null; then
    return 0
  fi

  snapshot_dir="$out_dir/memory-maps"
  mkdir -p "$snapshot_dir"
  safe_label="$(printf '%s' "$label" | tr -c 'A-Za-z0-9._-' '_')"
  pids="$(collect_process_tree "$root_pid" | sort -n | tr '\n' ' ')"
  [ -n "$pids" ] || return 0

  printf 'target=%s\nlabel=%s\nroot_pid=%s\npids=%s\n' \
    "$target" "$label" "$root_pid" "$pids" >"$snapshot_dir/$safe_label.summary.txt"
  pid_csv="$(printf '%s\n' "$pids" | awk '{$1=$1; gsub(/ /, ","); print}')"
  ps -o pid= -o ppid= -o rss= -o vsz= -o %cpu= -o command= -p "$pid_csv" \
    >>"$snapshot_dir/$safe_label.summary.txt" 2>&1 || true

  for pid in $pids; do
    if command -v vmmap >/dev/null 2>&1; then
      vmmap -summary "$pid" >"$snapshot_dir/$safe_label.$pid.vmmap.txt" 2>&1 || true
    elif command -v pmap >/dev/null 2>&1; then
      pmap -x "$pid" >"$snapshot_dir/$safe_label.$pid.pmap.txt" 2>&1 || true
    fi
  done
}

suite_root="$RUN_DIR/concurrent-query-suite/$run_label"
report_dir="$REPORT_DIR/concurrent-query-suite/$run_label"
summary="$report_dir/summary.md"
summary_tsv="$report_dir/summary.tsv"
client_tsv="$report_dir/client-summary.tsv"
resource_tsv="$report_dir/resource-summary.tsv"

rm -rf "$suite_root" "$report_dir"
mkdir -p "$suite_root/sql" "$report_dir"

fresh_write_report_header "$summary" "WASIX Concurrent Query Suite"
{
  printf -- '- Targets: `%s`\n' "${targets[*]}"
  printf -- '- Workloads: `%s`\n' "${workloads[*]}"
  printf -- '- Connections: `%s`\n' "$connections"
  printf -- '- Iterations per connection: `%s`\n' "$iterations"
  printf -- '- Requested seed rows: `%s`\n' "$row_count"
  printf -- '- Actual setup rows: `%s`\n' "$setup_rows"
  printf -- '- Timeout: `%s seconds`\n' "$timeout_seconds"
  printf -- '- Resource sample interval: `%s seconds`\n' "$resource_sample_interval"
  printf -- '- PostgreSQL wait sample interval: `%s seconds`\n' "$pg_wait_sample_interval"
  printf -- '- WASIX perf stats: `%s`\n' "$wasix_perf_stats"
  printf -- '- WASIX wait dump interval: `%s ms`\n' "$wasix_wait_dump_interval_ms"
  printf -- '- WASIX wait dump max per wait: `%s`\n' "$wasix_wait_dump_max_per_wait"
  printf -- '- Memory map snapshots: `%s`\n' "$memory_map_snapshots"
  printf -- '- WASIX sample seconds: `%s`\n' "$sample_seconds"
  printf -- '- WASIX sample delay: `%s`\n' "$sample_delay"
  printf -- '- Start port: `%s`\n' "$start_port"
  printf -- '- WASIX core profile: `%s`\n' "$WASIX_CORE_PROFILE"
  printf -- '- WASIX install dir: `%s`\n' "$WASIX_INSTALL_DIR"
  printf -- '- Pinned runtime: `%s`\n' "${FRESH_PINNED_RUNTIME_NAME:-}"
  printf -- '- PostgreSQL GUCs: `%s`\n' "${postgres_gucs[*]:-}"
  printf -- '- Extra Wasmer args: `%s`\n' "${wasmer_extra_args[*]:-}"
  printf -- '- Summary TSV: `%s`\n' "$summary_tsv"
  printf -- '- Client TSV: `%s`\n' "$client_tsv"
  printf -- '- Resource TSV: `%s`\n\n' "$resource_tsv"
} >>"$summary"

printf 'target\tworkload\tstatus\tconnections\titerations\toperation_count\tverified_count\texpected_verify_count\tfanout_wall_ms\tthroughput_ops_per_sec\tok_clients\tfailed_clients\ttimed_out\tepoll_intr_count\tserver_log\treport_dir\n' >"$summary_tsv"
printf 'target\tworkload\tclient\tstatus\twall_ms\tpsql_time_ms\tpsql_time_count\tlog\n' >"$client_tsv"
printf 'target\tphase\tpeak_rss_kb\tpeak_rss_mb\tpeak_vsz_kb\tpeak_cpu_percent\tpeak_process_count\tsample_count\tsamples_log\n' >"$resource_tsv"

write_workload_sql() {
  local workload="$1"
  local setup_sql="$2"
  local client_sql="$3"
  local verify_sql="$4"

  case "$workload" in
    indexed-read)
      cat >"$setup_sql" <<'SQL'
\set ON_ERROR_STOP 1
DROP TABLE IF EXISTS cqb_indexed_read;
CREATE TABLE cqb_indexed_read (
  id integer PRIMARY KEY,
  bucket integer NOT NULL,
  payload text NOT NULL
);
INSERT INTO cqb_indexed_read
SELECT i, i % 1000, md5(i::text)
FROM generate_series(1, :row_count) AS i;
CREATE INDEX cqb_indexed_read_bucket_idx ON cqb_indexed_read (bucket);
CREATE INDEX cqb_indexed_read_payload_idx ON cqb_indexed_read (payload);
ANALYZE cqb_indexed_read;
CREATE OR REPLACE FUNCTION cqb_indexed_read_worker(client_id integer, iterations integer, row_count integer)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  i integer;
  key integer;
  value text;
  bucket_count bigint;
  total bigint := 0;
BEGIN
  FOR i IN 1..iterations LOOP
    key := (((client_id::bigint * 104729) + (i::bigint * 7919)) % row_count + 1)::integer;
    SELECT payload INTO value FROM cqb_indexed_read WHERE id = key;
    total := total + length(value);
    IF i % 10 = 0 THEN
      SELECT count(*) INTO bucket_count FROM cqb_indexed_read WHERE bucket = key % 1000;
      total := total + bucket_count;
    END IF;
  END LOOP;
  RETURN total;
END;
$$;
SQL
      cat >"$client_sql" <<'SQL'
\set ON_ERROR_STOP 1
\pset tuples_only on
SELECT pg_backend_pid();
\timing on
SELECT cqb_indexed_read_worker(:client_id, :iterations, :row_count);
\timing off
SQL
      cat >"$verify_sql" <<'SQL'
SELECT count(*)::bigint FROM cqb_indexed_read;
SQL
      ;;
    mixed-write)
      cat >"$setup_sql" <<'SQL'
\set ON_ERROR_STOP 1
DROP TABLE IF EXISTS cqb_mixed_write;
CREATE TABLE cqb_mixed_write (
  client_id integer NOT NULL,
  iteration integer NOT NULL,
  bucket integer NOT NULL,
  payload text NOT NULL,
  updates integer NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, iteration)
);
SQL
      cat >"$client_sql" <<'SQL'
\set ON_ERROR_STOP 1
\pset tuples_only on
SELECT pg_backend_pid();
\timing on
BEGIN;
INSERT INTO cqb_mixed_write (client_id, iteration, bucket, payload)
SELECT :client_id, g, (:client_id * 100000 + g) % 1000, md5((:client_id::text || ':' || g::text))
FROM generate_series(1, :iterations) AS g;
UPDATE cqb_mixed_write
SET bucket = bucket + 1,
    payload = md5(payload || ':updated'),
    updates = updates + 1
WHERE client_id = :client_id;
COMMIT;
\timing off
SQL
      cat >"$verify_sql" <<'SQL'
SELECT (count(*) + coalesce(sum(updates), 0))::bigint FROM cqb_mixed_write;
SQL
      ;;
    indexed-update)
      cat >"$setup_sql" <<'SQL'
\set ON_ERROR_STOP 1
DROP TABLE IF EXISTS cqb_indexed_update;
CREATE TABLE cqb_indexed_update (
  id integer PRIMARY KEY,
  bucket integer NOT NULL,
  payload text NOT NULL,
  updates integer NOT NULL DEFAULT 0
);
INSERT INTO cqb_indexed_update
SELECT i, i % 1000, md5(i::text), 0
FROM generate_series(1, :setup_rows) AS i;
CREATE INDEX cqb_indexed_update_bucket_idx ON cqb_indexed_update (bucket);
CREATE INDEX cqb_indexed_update_payload_idx ON cqb_indexed_update (payload);
ANALYZE cqb_indexed_update;
SQL
      cat >"$client_sql" <<'SQL'
\set ON_ERROR_STOP 1
\pset tuples_only on
SELECT pg_backend_pid();
\timing on
UPDATE cqb_indexed_update
SET bucket = bucket + 1,
    payload = md5(payload || ':u'),
    updates = updates + 1
WHERE id BETWEEN ((:client_id - 1) * :iterations + 1) AND (:client_id * :iterations);
\timing off
SQL
      cat >"$verify_sql" <<'SQL'
SELECT coalesce(sum(updates), 0)::bigint FROM cqb_indexed_update;
SQL
      ;;
    indexed-insert)
      cat >"$setup_sql" <<'SQL'
\set ON_ERROR_STOP 1
DROP TABLE IF EXISTS cqb_indexed_insert;
CREATE TABLE cqb_indexed_insert (
  id integer PRIMARY KEY,
  client_id integer NOT NULL,
  bucket integer NOT NULL,
  payload text NOT NULL
);
CREATE INDEX cqb_indexed_insert_client_idx ON cqb_indexed_insert (client_id);
CREATE INDEX cqb_indexed_insert_bucket_idx ON cqb_indexed_insert (bucket);
CREATE INDEX cqb_indexed_insert_payload_idx ON cqb_indexed_insert (payload);
SQL
      cat >"$client_sql" <<'SQL'
\set ON_ERROR_STOP 1
\pset tuples_only on
SELECT pg_backend_pid();
\timing on
INSERT INTO cqb_indexed_insert (id, client_id, bucket, payload)
SELECT ((:client_id - 1) * :iterations + g), :client_id, (:client_id * 100000 + g) % 1000,
       md5((:client_id::text || ':' || g::text))
FROM generate_series(1, :iterations) AS g;
\timing off
SQL
      cat >"$verify_sql" <<'SQL'
SELECT count(*)::bigint FROM cqb_indexed_insert;
SQL
      ;;
  esac
}

operation_count_for() {
  local workload="$1"
  case "$workload" in
    indexed-read) echo $((connections * (iterations + iterations / 10))) ;;
    mixed-write) echo $((connections * iterations * 2)) ;;
    *) echo $((connections * iterations)) ;;
  esac
}

expected_verify_count_for() {
  local workload="$1"
  case "$workload" in
    indexed-read) echo "$row_count" ;;
    mixed-write) echo $((connections * iterations * 2)) ;;
    indexed-update|indexed-insert) echo $((connections * iterations)) ;;
  esac
}

stop_pid() {
  local pid="${1:-}"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
}

wait_for_ready() {
  local conn="$1"
  local server_pid="$2"
  local wait_log="$3"
  : >"$wait_log"
  for _ in $(seq 1 300); do
    if "$NATIVE_INSTALL_DIR/bin/psql" "$conn" -X -q -c 'select 1' >>"$wait_log" 2>&1; then
      return 0
    fi
    if ! kill -0 "$server_pid" 2>/dev/null; then
      echo "server exited before readiness" >>"$wait_log"
      return 1
    fi
    sleep 0.1
  done
  return 1
}

start_native_server() {
  local pgdata="$1"
  local port="$2"
  local initdb_log="$3"
  local server_log="$4"
  local postgres_args

  "$NATIVE_INSTALL_DIR/bin/initdb" -D "$pgdata" -A trust --no-locale --encoding=UTF8 --no-instructions \
    >"$initdb_log" 2>&1
  postgres_args=(
    -D "$pgdata"
    -h 127.0.0.1
    -p "$port"
    -c unix_socket_directories=
    -c "max_connections=$((connections + 32))"
  )
  if [ "${#postgres_gucs[@]}" -gt 0 ]; then
    for guc in "${postgres_gucs[@]}"; do
      postgres_args+=(-c "$guc")
    done
  fi
  "$NATIVE_INSTALL_DIR/bin/postgres" "${postgres_args[@]}" >"$server_log" 2>&1 &
  echo "$!"
}

wasmer_bin=""
wasmer_bin_hash=""
wasmer_cache_dir=""
wasmer_compiler=""
wasmer_llvm_opt_level=""
wasmer_stack_size=""
wasmer_compiler_threads=""
wasmer_args=()
wasmer_env=()

prepare_wasix_runtime() {
  wasmer_bin="$(fresh_wasmer_bin)"
  wasmer_bin_hash="$(fresh_wasmer_bin_hash "$wasmer_bin")"
  wasmer_cache_dir="$(fresh_wasmer_cache_dir "$wasmer_bin")"
  wasmer_compiler="$(fresh_wasmer_compiler)"
  wasmer_llvm_opt_level="${WASMER_LLVM_OPT_LEVEL:-aggressive}"
  wasmer_stack_size="${WASMER_STACK_SIZE:-33554432}"
  wasmer_compiler_threads="${WASMER_COMPILER_THREADS:-$(fresh_jobs)}"
  fresh_require_wasmer_compiler_cli "$wasmer_bin" "$wasmer_compiler" run
  if [ "$skip_precompile" != "1" ]; then
    "$FRESH_ROOT/bin/precompile-wasix-core.sh" >/dev/null
  fi
}

build_wasmer_args() {
  local dev_shm="$1"
  wasmer_env=(
    "WASMER_DIR=$FRESH_WORK_ROOT/tools/wasmer-home"
    "WASMER_CACHE_DIR=$wasmer_cache_dir"
  )
  wasmer_args=(run --quiet)
  while IFS= read -r arg; do
    wasmer_args+=("$arg")
  done < <(fresh_wasmer_compiler_args_for "$wasmer_bin" run "$wasmer_compiler" "$wasmer_llvm_opt_level" "$wasmer_compiler_threads")
  wasmer_args+=(
    --stack-size "$wasmer_stack_size"
    --enable-exceptions
    --enable-threads
    --net
    --volume "$REPO_ROOT:$REPO_ROOT"
    --volume "$WASIX_INSTALL_DIR/lib:/lib"
    --volume "$dev_shm:/dev/shm"
  )
  if [ "${#wasmer_extra_args[@]}" -gt 0 ]; then
    wasmer_args+=("${wasmer_extra_args[@]}")
  fi
}

start_wasix_server() {
  local pgdata="$1"
  local dev_shm="$2"
  local port="$3"
  local initdb_log="$4"
  local server_log="$5"
  local perf_initdb_log="$6"
  local perf_server_log="$7"
  local postgres_args
  local initdb_env=()
  local server_env=()

  build_wasmer_args "$dev_shm"
  initdb_env=("${wasmer_env[@]}")
  server_env=("${wasmer_env[@]}")
  if [ "$wasix_perf_stats" = "1" ]; then
    initdb_env+=("WASIX_PERF_STATS=1" "WASIX_PERF_STATS_FILE=$perf_initdb_log")
    server_env+=("WASIX_PERF_STATS=1" "WASIX_PERF_STATS_FILE=$perf_server_log")
  fi
  if [ "$wasix_wait_dump_interval_ms" -gt 0 ]; then
    initdb_env+=(
      "WASIX_WAIT_DUMP_INTERVAL_MS=$wasix_wait_dump_interval_ms"
      "WASIX_WAIT_DUMP_FILE=$perf_initdb_log"
      "WASIX_WAIT_DUMP_MAX_PER_WAIT=$wasix_wait_dump_max_per_wait"
    )
    server_env+=(
      "WASIX_WAIT_DUMP_INTERVAL_MS=$wasix_wait_dump_interval_ms"
      "WASIX_WAIT_DUMP_FILE=$perf_server_log"
      "WASIX_WAIT_DUMP_MAX_PER_WAIT=$wasix_wait_dump_max_per_wait"
    )
  fi

  env "${initdb_env[@]}" \
    "$wasmer_bin" "${wasmer_args[@]}" "$WASIX_INSTALL_DIR/bin/initdb" -- \
      -D "$pgdata" -A trust --no-locale --encoding=UTF8 --no-instructions \
      >"$initdb_log" 2>&1

  postgres_args=(
    -D "$pgdata"
    -h 127.0.0.1
    -p "$port"
    -c unix_socket_directories=
    -c "max_connections=$((connections + 32))"
  )
  if [ "${#postgres_gucs[@]}" -gt 0 ]; then
    for guc in "${postgres_gucs[@]}"; do
      postgres_args+=(-c "$guc")
    done
  fi
  env "${server_env[@]}" \
    "$wasmer_bin" "${wasmer_args[@]}" "$WASIX_INSTALL_DIR/bin/postgres" -- \
      "${postgres_args[@]}" >"$server_log" 2>&1 &
  echo "$!"
}

run_workload() {
  local target="$1"
  local workload="$2"
  local conn="$3"
  local target_report_dir="$4"
  local server_log="$5"
  local resource_phase_file="$6"
  local server_pid="$7"
  local workload_report_dir="$target_report_dir/$workload"
  local setup_sql="$suite_root/sql/$workload.setup.sql"
  local client_sql="$suite_root/sql/$workload.client.sql"
  local verify_sql="$suite_root/sql/$workload.verify.sql"
  local setup_log="$workload_report_dir/setup.log"
  local verify_log="$workload_report_dir/verify.log"
  local operation_count expected_verify_count verified_count throughput fanout_start fanout_end fanout_wall
  local timed_out=0 ok_clients=0 failed_clients=0 status=0 pids=() client_logs=() client_start=()
  local client_status_files=() client_end_files=()
  local client client_log client_status_file client_end_file deadline running pid index
  local client_status client_end client_wall psql_time psql_count wait_status
  local setup_status setup_timed_out verify_status epoll_intr_count
  local sample_log sample_stderr sample_status sample_pid perfmap perfmap_copy symbol_prefix
  local pg_wait_samples pg_wait_summary pg_wait_stop pg_wait_pid relation_footprint

  mkdir -p "$workload_report_dir"
  write_workload_sql "$workload" "$setup_sql" "$client_sql" "$verify_sql"
  operation_count="$(operation_count_for "$workload")"
  expected_verify_count="$(expected_verify_count_for "$workload")"

  set_resource_phase "$resource_phase_file" "setup:$workload"
  set +e
  run_logged_timeout "$timeout_seconds" "$setup_log" \
    "$NATIVE_INSTALL_DIR/bin/psql" "$conn" -X -q -v ON_ERROR_STOP=1 \
      -v "row_count=$row_count" -v "setup_rows=$setup_rows" -f "$setup_sql"
  setup_status=$?
  set -e
  if [ "$setup_status" -ne 0 ]; then
    setup_timed_out=0
    [ "$setup_status" -eq 124 ] && setup_timed_out=1
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t0\t0.000\t0\t%s\t%s\t0\t%s\t%s\n' \
      "$target" "$workload" "$setup_status" "$connections" "$iterations" "$operation_count" \
      "" "$expected_verify_count" "$connections" "$setup_timed_out" "$server_log" \
      "$workload_report_dir" >>"$summary_tsv"
    set_resource_phase "$resource_phase_file" "idle"
    return "$setup_status"
  fi

  set_resource_phase "$resource_phase_file" "fanout:$workload"
  snapshot_memory_map "$target" "$server_pid" "fanout-$workload-before" "$workload_report_dir"
  fanout_start="$(now_ms)"
  sample_log="$workload_report_dir/sample.txt"
  sample_stderr="$workload_report_dir/sample.stderr.log"
  sample_status=0
  sample_pid=""
  pg_wait_samples="$workload_report_dir/pg-wait-samples.tsv"
  pg_wait_summary="$workload_report_dir/pg-wait-summary.tsv"
  pg_wait_stop="$workload_report_dir/pg-wait.stop"
  pg_wait_pid=""
  rm -f "$pg_wait_stop"
  if float_gt_zero "$pg_wait_sample_interval"; then
    sample_pg_wait_events "$target" "$workload" "$conn" "$pg_wait_stop" \
      "$pg_wait_samples" "$pg_wait_sample_interval" &
    pg_wait_pid="$!"
  fi
  if [ "$target" = "wasix" ] && float_gt_zero "$sample_seconds"; then
    (
      sleep "$sample_delay"
      if command -v sample >/dev/null 2>&1 && kill -0 "$server_pid" 2>/dev/null; then
        sample "$server_pid" "$sample_seconds" -file "$sample_log" >"$sample_stderr" 2>&1
      else
        printf 'sample command unavailable or server exited before sampling\n' >"$sample_stderr"
        exit 127
      fi
    ) &
    sample_pid="$!"
  fi
  for client in $(seq 1 "$connections"); do
    client_log="$workload_report_dir/client-$client.log"
    client_status_file="$workload_report_dir/client-$client.status"
    client_end_file="$workload_report_dir/client-$client.end_ms"
    rm -f "$client_status_file" "$client_end_file"
    client_logs+=("$client_log")
    client_status_files+=("$client_status_file")
    client_end_files+=("$client_end_file")
    client_start+=("$(now_ms)")
    (
      child_pid=""
      trap 'status=124; if [ -n "$child_pid" ]; then kill "$child_pid" 2>/dev/null || true; wait "$child_pid" 2>/dev/null || true; fi; printf "%s\n" "$status" >"$client_status_file"; now_ms >"$client_end_file"; exit "$status"' TERM INT
      PGCONNECT_TIMEOUT=10 "$NATIVE_INSTALL_DIR/bin/psql" "$conn" \
        -X -q \
        -v ON_ERROR_STOP=1 \
        -v "client_id=$client" \
        -v "connections=$connections" \
        -v "iterations=$iterations" \
        -v "row_count=$row_count" \
        -v "setup_rows=$setup_rows" \
        -f "$client_sql" >"$client_log" 2>&1 &
      child_pid=$!
      wait "$child_pid"
      status=$?
      printf "%s\n" "$status" >"$client_status_file"
      now_ms >"$client_end_file"
      exit "$status"
    ) &
    pids+=("$!")
  done

  deadline=$(( $(date +%s) + timeout_seconds ))
  while :; do
    running=0
    for client_status_file in "${client_status_files[@]}"; do
      if [ ! -f "$client_status_file" ]; then
        running=1
        break
      fi
    done
    [ "$running" -eq 0 ] && break
    if [ "$(date +%s)" -ge "$deadline" ]; then
      timed_out=1
      for pid in "${pids[@]}"; do
        kill "$pid" 2>/dev/null || true
      done
      sleep 0.5
      for pid in "${pids[@]}"; do
        kill -9 "$pid" 2>/dev/null || true
      done
      break
    fi
    sleep 0.05
  done

  fanout_end="$fanout_start"

  for index in "${!pids[@]}"; do
    pid="${pids[$index]}"
    client=$((index + 1))
    client_log="${client_logs[$index]}"
    client_status_file="${client_status_files[$index]}"
    client_end_file="${client_end_files[$index]}"
    set +e
    wait "$pid"
    wait_status=$?
    set -e
    if [ -f "$client_status_file" ]; then
      client_status="$(tr -d '[:space:]' <"$client_status_file")"
    else
      client_status=124
    fi
    case "$client_status" in ''|*[!0-9]*) client_status="$wait_status" ;; esac
    if [ "$timed_out" -eq 1 ] && [ "$client_status" -eq 143 ]; then
      client_status=124
    fi
    if [ -f "$client_end_file" ]; then
      client_end="$(tr -d '[:space:]' <"$client_end_file")"
    else
      client_end="$(now_ms)"
    fi
    case "$client_end" in ''|*[!0-9]*) client_end="$(now_ms)" ;; esac
    if [ "$client_end" -gt "$fanout_end" ]; then
      fanout_end="$client_end"
    fi
    client_wall=$((client_end - client_start[index]))
    psql_time="$(extract_psql_time_sum_ms "$client_log")"
    psql_count="$(extract_psql_time_count "$client_log")"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$target" "$workload" "$client" "$client_status" "$client_wall" \
      "$psql_time" "$psql_count" "$client_log" >>"$client_tsv"
    if [ "$client_status" -eq 0 ]; then
      ok_clients=$((ok_clients + 1))
    else
      failed_clients=$((failed_clients + 1))
      status=1
    fi
  done

  fanout_wall=$((fanout_end - fanout_start))
  throughput="$(calc_rate "$operation_count" "$fanout_wall")"
  if [ -n "$pg_wait_pid" ]; then
    touch "$pg_wait_stop"
    wait "$pg_wait_pid" 2>/dev/null || true
    summarize_pg_wait_events "$pg_wait_samples" "$pg_wait_summary"
  fi
  snapshot_memory_map "$target" "$server_pid" "fanout-$workload-after" "$workload_report_dir"

  if [ -n "$sample_pid" ]; then
    set +e
    wait "$sample_pid"
    sample_status=$?
    set -e
    perfmap="/tmp/perf-$server_pid.map"
    perfmap_copy="$workload_report_dir/perf.map"
    symbol_prefix="$workload_report_dir/symbolized-sample"
    if [ -s "$sample_log" ] && [ -s "$perfmap" ]; then
      cp "$perfmap" "$perfmap_copy"
      "$FRESH_ROOT/bin/symbolize-wasmer-sample.sh" \
        "$sample_log" \
        "$perfmap_copy" \
        "$symbol_prefix" \
        >"$workload_report_dir/symbolize.log" 2>&1 || true
    fi
    printf 'sample_status=%s\nsample_log=%s\nsample_stderr=%s\n' \
      "$sample_status" "$sample_log" "$sample_stderr" \
      >"$workload_report_dir/sample-summary.txt"
  fi

  set_resource_phase "$resource_phase_file" "verify:$workload"
  set +e
  run_logged_timeout "$timeout_seconds" "$verify_log" \
    "$NATIVE_INSTALL_DIR/bin/psql" "$conn" -X -q -A -t -v ON_ERROR_STOP=1 -f "$verify_sql"
  verify_status=$?
  set -e
  verified_count=""
  if [ "$verify_status" -eq 0 ]; then
    verified_count="$(tail -n 1 "$verify_log" | tr -d '[:space:]')"
  else
    status=1
  fi
  if [ "$verified_count" != "$expected_verify_count" ]; then
    status=1
  fi
  relation_footprint="$workload_report_dir/relation-footprint.tsv"
  capture_relation_footprint "$conn" "$workload" "$relation_footprint"
  snapshot_memory_map "$target" "$server_pid" "verify-$workload-after" "$workload_report_dir"

  epoll_intr_count=0
  if [ "$target" = "wasix" ] && [ -f "$server_log" ]; then
    epoll_intr_count="$(grep -c 'failed to epoll during deep sleep - intr' "$server_log" || true)"
    if [ "$epoll_intr_count" != "0" ]; then
      status=1
    fi
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$target" "$workload" "$status" "$connections" "$iterations" "$operation_count" \
    "$verified_count" "$expected_verify_count" "$fanout_wall" "$throughput" \
    "$ok_clients" "$failed_clients" "$timed_out" "$epoll_intr_count" "$server_log" \
    "$workload_report_dir" >>"$summary_tsv"
  set_resource_phase "$resource_phase_file" "idle"
  return "$status"
}

run_target() {
  local target="$1"
  local port="$2"
  local target_run_dir="$suite_root/$target"
  local target_report_dir="$report_dir/$target"
  local pgdata="$target_run_dir/pgdata"
  local dev_shm="$target_run_dir/dev-shm"
  local initdb_log="$target_report_dir/initdb.log"
  local server_log="$target_report_dir/server.log"
  local wasix_perf_initdb_log="$target_report_dir/wasix-perf-initdb.log"
  local wasix_perf_server_log="$target_report_dir/wasix-perf-server.log"
  local wait_log="$target_report_dir/wait.log"
  local resource_phase_file="$target_report_dir/resource-phase"
  local resource_stop_file="$target_report_dir/resource-stop"
  local resource_samples_tsv="$target_report_dir/resource-samples.tsv"
  local db_user="wasix"
  local conn
  local server_pid=""
  local resource_monitor_pid=""
  local target_status=0
  local start_status workload workload_status

  if [ "$target" = "native" ]; then
    db_user="$(id -un)"
  fi
  conn="postgresql://$db_user@127.0.0.1:$port/postgres"

  rm -rf "$target_run_dir" "$target_report_dir"
  mkdir -p "$pgdata" "$dev_shm" "$target_report_dir"
  rm -f "$resource_phase_file" "$resource_stop_file"
  set_resource_phase "$resource_phase_file" "startup"

  set +e
  if [ "$target" = "native" ]; then
    server_pid="$(start_native_server "$pgdata" "$port" "$initdb_log" "$server_log")"
    start_status=$?
  else
    server_pid="$(start_wasix_server "$pgdata" "$dev_shm" "$port" "$initdb_log" "$server_log" "$wasix_perf_initdb_log" "$wasix_perf_server_log")"
    start_status=$?
  fi
  set -e

  if [ "$start_status" -ne 0 ]; then
    printf '%s\tstartup\t%s\t%s\t%s\t0\t\t\t0\t0.000\t0\t0\t0\t0\t%s\t%s\n' \
      "$target" "$start_status" "$connections" "$iterations" "$server_log" "$target_report_dir" \
      >>"$summary_tsv"
    return 1
  fi

  monitor_resource_usage "$target" "$server_pid" "$resource_phase_file" "$resource_stop_file" \
    "$resource_samples_tsv" "$resource_sample_interval" &
  resource_monitor_pid="$!"

  set_resource_phase "$resource_phase_file" "readiness"
  if ! wait_for_ready "$conn" "$server_pid" "$wait_log"; then
    printf '%s\treadiness\t1\t%s\t%s\t0\t\t\t0\t0.000\t0\t0\t0\t0\t%s\t%s\n' \
      "$target" "$connections" "$iterations" "$server_log" "$target_report_dir" >>"$summary_tsv"
    set_resource_phase "$resource_phase_file" "stopping"
    stop_pid "$server_pid"
    touch "$resource_stop_file"
    wait "$resource_monitor_pid" 2>/dev/null || true
    summarize_resource_usage "$target" "$resource_samples_tsv" "$resource_tsv"
    return 1
  fi

  snapshot_memory_map "$target" "$server_pid" "readiness" "$target_report_dir"
  set_resource_phase "$resource_phase_file" "idle"
  for workload in "${workloads[@]}"; do
    if run_workload "$target" "$workload" "$conn" "$target_report_dir" "$server_log" "$resource_phase_file" "$server_pid"; then
      workload_status=0
    else
      workload_status=$?
    fi
    if [ "$workload_status" -ne 0 ]; then
      target_status=1
    fi
  done

  set_resource_phase "$resource_phase_file" "stopping"
  stop_pid "$server_pid"
  touch "$resource_stop_file"
  wait "$resource_monitor_pid" 2>/dev/null || true
  summarize_resource_usage "$target" "$resource_samples_tsv" "$resource_tsv"
  if [ "$target" = "wasix" ] && [ "$wasix_perf_stats" = "1" ] && [ -s "$wasix_perf_server_log" ]; then
    "$FRESH_ROOT/bin/summarize-wasix-perf-stats.sh" \
      "$wasix_perf_server_log" \
      "$target_report_dir/wasix-perf-server" \
      >"$target_report_dir/wasix-perf-summary.log" 2>&1 || true
  fi
  return "$target_status"
}

if [ "$need_wasix" -eq 1 ]; then
  prepare_wasix_runtime
  {
    printf -- '- Wasmer binary: `%s`\n' "$wasmer_bin"
    printf -- '- Wasmer binary hash: `%s`\n' "$wasmer_bin_hash"
    printf -- '- Wasmer version: `%s`\n' "$("$wasmer_bin" --version 2>/dev/null || true)"
    printf -- '- Wasmer cache dir: `%s`\n' "$wasmer_cache_dir"
    printf -- '- Wasmer compiler: `%s`\n' "$wasmer_compiler"
    printf -- '- Wasmer LLVM opt level: `%s`\n' "$wasmer_llvm_opt_level"
    printf -- '- WASMER_LLVM_NATIVE_CPU: `%s`\n' "${WASMER_LLVM_NATIVE_CPU:-0}"
    printf -- '- WASMER_LLVM_FULL_O3_PIPELINE: `%s`\n' "${WASMER_LLVM_FULL_O3_PIPELINE:-0}"
    printf -- '- WASMER_LLVM_INDIRECT_CALL_CACHE: `%s`\n' "${WASMER_LLVM_INDIRECT_CALL_CACHE:-0}"
    printf -- '- Wasmer stack size: `%s`\n' "$wasmer_stack_size"
    printf -- '- Wasmer compiler threads: `%s`\n' "$wasmer_compiler_threads"
    printf -- '- Skip precompile: `%s`\n\n' "$skip_precompile"
  } >>"$summary"
fi

overall_status=0
port="$start_port"
for target in "${targets[@]}"; do
  if run_target "$target" "$port"; then
    target_status=0
  else
    target_status=$?
  fi
  if [ "$target_status" -ne 0 ]; then
    overall_status=1
  fi
  port=$((port + 1))
done

{
  printf '\n## Results\n\n'
  printf -- '- Exit code: `%s`\n' "$overall_status"
  printf -- '- Summary TSV: `%s`\n' "$summary_tsv"
  printf -- '- Client TSV: `%s`\n' "$client_tsv"
  printf -- '- Resource TSV: `%s`\n' "$resource_tsv"
  if [ "$wasix_perf_stats" = "1" ]; then
    printf -- '- WASIX perf stats TSV: `%s/wasix/wasix-perf-server.tsv`\n' "$report_dir"
    printf -- '- WASIX perf stats top time TSV: `%s/wasix/wasix-perf-server.top-time.tsv`\n' "$report_dir"
  fi
  if [ "$wasix_wait_dump_interval_ms" -gt 0 ]; then
    printf -- '- WASIX wait dump log: `%s/wasix/wasix-perf-server.log`\n' "$report_dir"
  fi
  if [ "$memory_map_snapshots" = "1" ]; then
    printf -- '- Memory map snapshots: `%s/<target>/**/memory-maps/`\n' "$report_dir"
  fi
  if float_gt_zero "$sample_seconds"; then
    printf -- '- WASIX sample outputs: `%s/wasix/<workload>/sample.txt`\n' "$report_dir"
    printf -- '- WASIX symbolized sample top TSV: `%s/wasix/<workload>/symbolized-sample.top.tsv`\n' "$report_dir"
  fi
  if float_gt_zero "$pg_wait_sample_interval"; then
    printf -- '- PostgreSQL wait samples: `%s/<target>/<workload>/pg-wait-samples.tsv`\n' "$report_dir"
    printf -- '- PostgreSQL wait summaries: `%s/<target>/<workload>/pg-wait-summary.tsv`\n' "$report_dir"
  fi
} >>"$summary"

if [ "$overall_status" -ne 0 ]; then
  printf 'failed: concurrent query suite; see %s\n' "$summary" >&2
else
  printf 'passed: concurrent query suite; see %s\n' "$summary"
fi
exit "$overall_status"
