#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

profiles=()
workloads=()
postgres_gucs=()
wasmer_extra_args=()
skip_build=0
skip_native=0
skip_precompile=0
precompile_scope="${WASIX_PRECOMPILE_SCOPE:-runtime}"
start_port="${PGPORT:-55520}"
bench_rows="${WASIX_BENCH_ROWS:-100000}"
update_rows="${WASIX_BENCH_UPDATE_ROWS:-$bench_rows}"
transaction_rows="${WASIX_BENCH_TRANSACTION_ROWS:-$bench_rows}"
sql_timeout="${WASIX_BENCH_SQL_TIMEOUT:-120}"
warmup_runs="${WASIX_BENCH_WARMUP_RUNS:-0}"
measure_runs="${WASIX_BENCH_MEASURE_RUNS:-1}"
workload_dir="$FRESH_ROOT/bench/sql/query-perf"
run_label="${WASIX_BENCH_LABEL:-}"

default_workloads=(
  bulk-insert
  copy-out
  index-build
  indexed-insert
  indexed-point-loop
  indexed-read-hot
  indexed-read
  indexed-update
  md5-scan
  single-transaction-insert
  transaction-update-batches
  unlogged-bulk-insert
  unlogged-constant-insert
  unlogged-constant-insert-nocount
  wal-insert-stats
)

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--profile requires a WASIX_CORE_PROFILE value" >&2
        exit 2
      fi
      profiles+=("$(fresh_normalize_wasix_core_profile "$1")")
      ;;
    --profiles)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--profiles requires a space-separated profile list" >&2
        exit 2
      fi
      for profile in $1; do
        profiles+=("$(fresh_normalize_wasix_core_profile "$profile")")
      done
      ;;
    --workload)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--workload requires a workload name or SQL path" >&2
        exit 2
      fi
      workloads+=("$1")
      ;;
    --workloads)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--workloads requires a space-separated workload list" >&2
        exit 2
      fi
      for workload in $1; do
        workloads+=("$workload")
      done
      ;;
    --skip-build)
      skip_build=1
      ;;
    --skip-native)
      skip_native=1
      ;;
    --skip-precompile)
      skip_precompile=1
      ;;
    --precompile-scope)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--precompile-scope requires minimal, runtime, or all" >&2
        exit 2
      fi
      precompile_scope="$1"
      ;;
    --rows)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--rows requires a row count" >&2
        exit 2
      fi
      bench_rows="$1"
      ;;
    --update-rows)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--update-rows requires a row count" >&2
        exit 2
      fi
      update_rows="$1"
      ;;
    --transaction-rows)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--transaction-rows requires a row count" >&2
        exit 2
      fi
      transaction_rows="$1"
      ;;
    --sql-timeout)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--sql-timeout requires a timeout in seconds, or 0 to disable" >&2
        exit 2
      fi
      sql_timeout="$1"
      ;;
    --warmup-runs)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--warmup-runs requires a non-negative integer" >&2
        exit 2
      fi
      case "$1" in
        ''|*[!0-9]*)
          echo "--warmup-runs requires a non-negative integer" >&2
          exit 2
          ;;
      esac
      warmup_runs="$1"
      ;;
    --measure-runs)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--measure-runs requires a positive integer" >&2
        exit 2
      fi
      case "$1" in
        ''|*[!0-9]*|0)
          echo "--measure-runs requires a positive integer" >&2
          exit 2
          ;;
      esac
      measure_runs="$1"
      ;;
    --start-port)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--start-port requires a port number" >&2
        exit 2
      fi
      start_port="$1"
      ;;
    --label)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--label requires a run label" >&2
        exit 2
      fi
      case "$1" in
        ""|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*)
          echo "--label must start with a letter or number and contain only letters, numbers, '.', '_', and '-'" >&2
          exit 2
          ;;
      esac
      run_label="$1"
      ;;
    --postgres-guc)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--postgres-guc requires a name=value setting" >&2
        exit 2
      fi
      postgres_gucs+=("$1")
      ;;
    --wasmer-arg)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--wasmer-arg requires one wasmer run argument" >&2
        exit 2
      fi
      wasmer_extra_args+=("$1")
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

if [ "${#profiles[@]}" -eq 0 ]; then
  profiles=(safe-o2)
fi
if [ "${#workloads[@]}" -eq 0 ]; then
  workloads=("${default_workloads[@]}")
fi
if [ -n "${POSTGRES_GUCS:-}" ]; then
  for guc in $POSTGRES_GUCS; do
    postgres_gucs+=("$guc")
  done
fi
if [ -n "${WASMER_RUN_EXTRA_ARGS:-}" ]; then
  for arg in $WASMER_RUN_EXTRA_ARGS; do
    wasmer_extra_args+=("$arg")
  done
fi
case "$warmup_runs" in
  ''|*[!0-9]*)
    echo "WASIX_BENCH_WARMUP_RUNS/--warmup-runs requires a non-negative integer" >&2
    exit 2
    ;;
esac
case "$measure_runs" in
  ''|*[!0-9]*|0)
    echo "WASIX_BENCH_MEASURE_RUNS/--measure-runs requires a positive integer" >&2
    exit 2
    ;;
esac
case "$run_label" in
  "") ;;
  [!A-Za-z0-9]*|*[!A-Za-z0-9._-]*)
    echo "label must start with a letter or number and contain only letters, numbers, '.', '_', and '-'" >&2
    exit 2
    ;;
esac

fresh_ensure_dirs

query_report_dir="$FRESH_WORK_ROOT/reports/query-perf-matrix"
query_run_root="$FRESH_WORK_ROOT/run/query-perf-matrix"
if [ -n "$run_label" ]; then
  query_report_dir="$query_report_dir/$run_label"
  query_run_root="$query_run_root/$run_label"
fi
fresh_require_managed_generated_path "$query_report_dir" "query benchmark report root"
fresh_require_managed_generated_path "$query_run_root" "query benchmark run root"
summary_tsv="$query_report_dir/summary.tsv"
summary_stats_tsv="$query_report_dir/summary-stats.tsv"
ratio_stats_tsv="$query_report_dir/ratio-stats.tsv"
summary_md="$query_report_dir/summary.md"
mkdir -p "$query_report_dir" "$query_run_root"

now_ms() {
  if command -v perl >/dev/null 2>&1; then
    perl -MTime::HiRes=time -e 'printf "%.0f\n", time() * 1000'
  else
    printf '%s000\n' "$(date +%s)"
  fi
}

workload_path_for() {
  local workload="$1"
  case "$workload" in
    */*) printf '%s\n' "$workload" ;;
    *.sql) printf '%s/%s\n' "$workload_dir" "$workload" ;;
    *) printf '%s/%s.sql\n' "$workload_dir" "$workload" ;;
  esac
}

workload_name_for() {
  local workload="$1"
  basename "${workload%.sql}"
}

extract_psql_time_sum_ms() {
  local log="$1"
  awk '
    /^Time: [0-9.]+ ms/ {
      sum += $2
      count += 1
    }
    END {
      if (count == 0) {
        printf ""
      } else {
        printf "%.3f", sum
      }
    }
  ' "$log"
}

extract_psql_time_count() {
  local log="$1"
  awk '/^Time: [0-9.]+ ms/ { count += 1 } END { printf "%d", count }' "$log"
}

record_result() {
  local target="$1"
  local profile="$2"
  local workload="$3"
  local status="$4"
  local wall_ms="$5"
  local psql_time_ms="$6"
  local psql_time_count="$7"
  local log="$8"
  local notes="$9"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$target" "$profile" "$workload" "$status" "$wall_ms" "$psql_time_ms" \
    "$psql_time_count" "$log" "$notes" >>"$summary_tsv"
}

stop_pid() {
  local pid="${1:-}"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
}

run_logged_timeout() {
  local timeout_seconds="$1"
  shift
  local log="$1"
  shift
  local pid started_ms elapsed_seconds status

  "$@" >"$log" 2>&1 &
  pid=$!
  started_ms="$(now_ms)"
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$timeout_seconds" != "0" ]; then
      elapsed_seconds=$((( $(now_ms) - started_ms ) / 1000))
      if [ "$elapsed_seconds" -ge "$timeout_seconds" ]; then
        {
          printf '\nbenchmark command timed out after %s seconds\n' "$timeout_seconds"
          printf 'command:'
          printf ' %q' "$@"
          printf '\n'
        } >>"$log"
        kill "$pid" 2>/dev/null || true
        sleep 1
        kill -9 "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
        return 124
      fi
    fi
    sleep 0.1
  done
  if wait "$pid"; then
    return 0
  fi
  status=$?
  return "$status"
}

run_psql_workload() {
  local target="$1"
  local profile="$2"
  local workload="$3"
  local conn="$4"
  local report_root="$5"
  local sql_path workload_name log started_ms ended_ms wall_ms status psql_time_ms psql_time_count
  local warmup_index warmup_log measure_index workload_status

  sql_path="$(workload_path_for "$workload")"
  workload_name="$(workload_name_for "$workload")"
  log="$report_root/$workload_name.log"
  if [ ! -f "$sql_path" ]; then
    printf 'missing workload SQL: %s\n' "$sql_path" >"$log"
    record_result "$target" "$profile" "$workload_name" 2 0 "" 0 "$log" "missing workload"
    return 2
  fi

  for ((warmup_index = 1; warmup_index <= warmup_runs; warmup_index++)); do
    warmup_log="$report_root/$workload_name.warmup-$warmup_index.log"
    set +e
    run_logged_timeout "$sql_timeout" "$warmup_log" \
      "$NATIVE_INSTALL_DIR/bin/psql" \
      "$conn" \
      -X -q \
      -v "perf_rows=$bench_rows" \
      -v "update_rows=$update_rows" \
      -v "transaction_rows=$transaction_rows" \
      -f "$sql_path"
    status=$?
    set -e
    if [ "$status" -ne 0 ]; then
      record_result "$target" "$profile" "$workload_name" "$status" 0 "" 0 "$warmup_log" \
        "phase=warmup warmup_run=$warmup_index measure_runs=$measure_runs rows=$bench_rows update_rows=$update_rows transaction_rows=$transaction_rows timeout=${sql_timeout}s"
      return "$status"
    fi
  done

  workload_status=0
  for ((measure_index = 1; measure_index <= measure_runs; measure_index++)); do
    if [ "$measure_runs" -eq 1 ]; then
      log="$report_root/$workload_name.log"
    else
      log="$report_root/$workload_name.run-$measure_index.log"
    fi
    started_ms="$(now_ms)"
    set +e
    run_logged_timeout "$sql_timeout" "$log" \
      "$NATIVE_INSTALL_DIR/bin/psql" \
      "$conn" \
      -X -q \
      -v "perf_rows=$bench_rows" \
      -v "update_rows=$update_rows" \
      -v "transaction_rows=$transaction_rows" \
      -f "$sql_path"
    status=$?
    set -e
    ended_ms="$(now_ms)"
    wall_ms=$((ended_ms - started_ms))
    psql_time_ms="$(extract_psql_time_sum_ms "$log")"
    psql_time_count="$(extract_psql_time_count "$log")"
    record_result "$target" "$profile" "$workload_name" "$status" "$wall_ms" \
      "$psql_time_ms" "$psql_time_count" "$log" \
      "phase=measure measure_run=$measure_index measure_runs=$measure_runs rows=$bench_rows update_rows=$update_rows transaction_rows=$transaction_rows warmup_runs=$warmup_runs timeout=${sql_timeout}s"
    if [ "$status" -ne 0 ]; then
      workload_status="$status"
    fi
  done
  return "$workload_status"
}

write_stats() {
  perl -MList::Util=sum,min,max -e '
    use strict;
    use warnings;
    my ($summary, $stats, $ratios) = @ARGV;
    open my $in, "<", $summary or die "open $summary: $!";
    <$in>;
    my (%values, %samples, %statuses);
    while (my $line = <$in>) {
      chomp $line;
      my @f = split /\t/, $line, 9;
      next unless @f >= 9;
      my ($target, $profile, $workload, $status, $wall_ms, $psql_ms) = @f;
      my $key = join "\t", $target, $profile, $workload;
      $samples{$key}++;
      $statuses{$key}{$status}++;
      push @{ $values{$key} }, 0 + $psql_ms if $status == 0 && $psql_ms ne "";
    }
    close $in;

    open my $stats_out, ">", $stats or die "open $stats: $!";
    print $stats_out join("\t", qw(target profile workload samples ok_samples statuses min_ms median_ms mean_ms p95_ms max_ms)), "\n";
    my (%median_by, %targets_by_workload);
    for my $key (sort keys %samples) {
      my ($target, $profile, $workload) = split /\t/, $key;
      my @v = sort { $a <=> $b } @{ $values{$key} || [] };
      my $n = @v;
      my $status_text = join ",", map { "$_:$statuses{$key}{$_}" } sort { $a <=> $b } keys %{ $statuses{$key} };
      my ($min, $median, $mean, $p95, $max) = ("", "", "", "", "");
      if ($n) {
        $min = min(@v);
        $max = max(@v);
        $mean = sum(@v) / $n;
        $median = $n % 2 ? $v[int($n / 2)] : ($v[$n / 2 - 1] + $v[$n / 2]) / 2;
        my $p95_index = int(0.95 * $n + 0.999999) - 1;
        $p95_index = 0 if $p95_index < 0;
        $p95_index = $n - 1 if $p95_index >= $n;
        $p95 = $v[$p95_index];
        $median_by{$target}{$profile}{$workload} = $median;
        $targets_by_workload{$workload}{$target}{$profile} = 1;
      }
      printf $stats_out "%s\t%s\t%s\t%d\t%d\t%s\t%s\t%s\t%s\t%s\t%s\n",
        $target, $profile, $workload, $samples{$key}, $n, $status_text,
        map { $_ eq "" ? "" : sprintf("%.3f", $_) } ($min, $median, $mean, $p95, $max);
    }
    close $stats_out;

    open my $ratio_out, ">", $ratios or die "open $ratios: $!";
    print $ratio_out join("\t", qw(profile workload native_median_ms wasix_median_ms ratio_vs_native)), "\n";
    for my $workload (sort keys %targets_by_workload) {
      my $native = $median_by{native}{native}{$workload};
      next unless defined $native && $native > 0;
      for my $profile (sort keys %{ $targets_by_workload{$workload}{wasix} || {} }) {
        my $wasix = $median_by{wasix}{$profile}{$workload};
        next unless defined $wasix;
        printf $ratio_out "%s\t%s\t%.3f\t%.3f\t%.3f\n", $profile, $workload, $native, $wasix, $wasix / $native;
      }
    }
    close $ratio_out;
  ' "$summary_tsv" "$summary_stats_tsv" "$ratio_stats_tsv"
}

write_header() {
  local header_wasmer_bin="" header_wasmer_bin_hash="" header_wasmer_version="" header_wasmer_cache_dir=""
  local header_wasmer_compiler header_wasmer_llvm_opt_level header_wasmer_stack_size
  local header_wasmer_compiler_threads header_wasmer_artifact_version

  header_wasmer_compiler="$(fresh_wasmer_compiler)"
  header_wasmer_llvm_opt_level="${WASMER_LLVM_OPT_LEVEL:-aggressive}"
  header_wasmer_stack_size="${WASMER_STACK_SIZE:-33554432}"
  header_wasmer_compiler_threads="${WASMER_COMPILER_THREADS:-$(fresh_jobs)}"
  header_wasmer_artifact_version="${WASMER_CACHE_ARTIFACT_VERSION:-21}"
  if header_wasmer_bin="$(fresh_wasmer_bin 2>/dev/null)"; then
    header_wasmer_bin_hash="$(fresh_wasmer_bin_hash "$header_wasmer_bin")"
    header_wasmer_version="$(fresh_wasmer_version "$header_wasmer_bin" 2>/dev/null || true)"
    header_wasmer_cache_dir="$(fresh_wasmer_cache_dir "$header_wasmer_bin")"
  fi

  {
    printf '# WASIX Query Performance Matrix\n\n'
    printf -- '- Generated: `%s`\n' "$(fresh_timestamp)"
    printf -- '- Profiles: `%s`\n' "${profiles[*]}"
    printf -- '- Workloads: `%s`\n' "${workloads[*]}"
    printf -- '- Rows: `%s`\n' "$bench_rows"
    printf -- '- Update rows: `%s`\n' "$update_rows"
    printf -- '- Transaction rows: `%s`\n' "$transaction_rows"
    printf -- '- SQL timeout: `%s seconds`\n' "$sql_timeout"
    printf -- '- Warmup runs: `%s`\n' "$warmup_runs"
    printf -- '- Measure runs: `%s`\n' "$measure_runs"
    printf -- '- Label: `%s`\n' "${run_label:-default}"
    printf -- '- PostgreSQL GUCs: `%s`\n' "${postgres_gucs[*]:-}"
    printf -- '- Extra Wasmer args: `%s`\n' "${wasmer_extra_args[*]:-}"
    printf -- '- Wasmer binary: `%s`\n' "${header_wasmer_bin:-unresolved}"
    printf -- '- Wasmer binary hash: `%s`\n' "${header_wasmer_bin_hash:-unresolved}"
    printf -- '- Wasmer version: `%s`\n' "${header_wasmer_version:-unresolved}"
    printf -- '- Wasmer compiler: `%s`\n' "$header_wasmer_compiler"
    printf -- '- Wasmer LLVM opt level: `%s`\n' "$header_wasmer_llvm_opt_level"
    printf -- '- WASMER_LLVM_NATIVE_CPU: `%s`\n' "${WASMER_LLVM_NATIVE_CPU:-0}"
    printf -- '- WASMER_LLVM_FULL_O3_PIPELINE: `%s`\n' "${WASMER_LLVM_FULL_O3_PIPELINE:-0}"
    printf -- '- WASMER_LLVM_INDIRECT_CALL_CACHE: `%s`\n' "${WASMER_LLVM_INDIRECT_CALL_CACHE:-0}"
    printf -- '- Wasmer cache dir: `%s`\n' "${header_wasmer_cache_dir:-unresolved}"
    printf -- '- Pinned runtime: `%s`\n' "${FRESH_PINNED_RUNTIME_NAME:-}"
    printf -- '- Pinned runtime root: `%s`\n' "${FRESH_PINNED_RUNTIME_ROOT:-}"
    printf -- '- Pinned WASIX install dir: `%s`\n' "${FRESH_PINNED_WASIX_INSTALL_DIR:-}"
    printf -- '- Pinned Wasmer cache dir: `%s`\n' "${FRESH_PINNED_WASMER_CACHE_DIR:-}"
    printf -- '- Wasmer cache artifact version: `%s`\n' "$header_wasmer_artifact_version"
    printf -- '- Wasmer compiler threads: `%s`\n' "$header_wasmer_compiler_threads"
    printf -- '- Wasmer stack size: `%s`\n' "$header_wasmer_stack_size"
    printf -- '- Precompile scope: `%s`\n' "$precompile_scope"
    printf -- '- Skip precompile: `%s`\n' "$skip_precompile"
    printf -- '- Summary TSV: `%s`\n\n' "$summary_tsv"
    printf -- '- Summary stats TSV: `%s`\n' "$summary_stats_tsv"
    printf -- '- Ratio stats TSV: `%s`\n\n' "$ratio_stats_tsv"
    printf '## WASIX Profile Settings\n\n'
    for profile in "${profiles[@]}"; do
      fresh_resolve_wasix_core_profile "$profile"
      printf -- '- `%s`: %s\n' "$profile" "$FRESH_WASIX_CORE_PROFILE_DESCRIPTION"
      printf '  - CFLAGS: `%s`\n' "$FRESH_WASIX_CORE_EFFECTIVE_CFLAGS"
      printf '  - LDFLAGS: `%s`\n' "$FRESH_WASIX_CORE_EFFECTIVE_LDFLAGS"
      printf '  - wasm-opt: `%s`\n' "$FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT"
      printf '  - wasm-opt flags: `%s`\n' "$FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT_FLAGS"
      printf '  - suppress implicit wasm-opt defaults: `%s`\n' "$FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT_SUPPRESS_DEFAULT"
    done
    printf '\n'
    printf '## Measurement\n\n'
  printf 'Each SQL workload keeps setup outside `psql` timing and enables timing only for the measured operation(s). Optional warmup runs execute the same workload before measurement and are logged separately without contributing to aggregate stats. Repeated measured runs are recorded in the raw TSV and summarized by median/mean/p95 in the stats TSVs.\n'
  } >"$summary_md"

  printf 'target\tprofile\tworkload\tstatus\twall_ms\tpsql_time_ms\tpsql_time_count\tlog\tnotes\n' >"$summary_tsv"
}

bench_native() {
  local port="$1"
  local run_root="$query_run_root/native"
  local report_root="$query_report_dir/native"
  local pgdata="$run_root/pgdata"
  local initdb_log="$report_root/initdb.log"
  local server_log="$report_root/server.log"
  local wait_log="$report_root/wait.log"
  local server_pid="" conn status started_ms ended_ms
  local postgres_args

  fresh_require_managed_generated_path "$pgdata" "native query benchmark PGDATA"
  mkdir -p "$run_root" "$report_root"
  rm -rf "$pgdata"

  if [ "$skip_build" -ne 1 ]; then
    "$FRESH_ROOT/bin/build-native-oracle.sh" >/dev/null
  fi

  started_ms="$(now_ms)"
  set +e
  "$NATIVE_INSTALL_DIR/bin/initdb" \
    -D "$pgdata" \
    -A trust \
    --no-locale \
    --encoding=UTF8 \
    --no-instructions \
    >"$initdb_log" 2>&1
  status=$?
  set -e
  ended_ms="$(now_ms)"
  if [ "$status" -ne 0 ]; then
    record_result native native initdb "$status" "$((ended_ms - started_ms))" "" 0 "$initdb_log" "pgdata=$pgdata"
    return "$status"
  fi

  set +e
  postgres_args=(
    -D "$pgdata"
    -h 127.0.0.1
    -p "$port"
    -c unix_socket_directories=
  )
  if [ "${#postgres_gucs[@]}" -gt 0 ]; then
    for guc in "${postgres_gucs[@]}"; do
      postgres_args+=(-c "$guc")
    done
  fi
  "$NATIVE_INSTALL_DIR/bin/postgres" "${postgres_args[@]}" >"$server_log" 2>&1 &
  server_pid=$!
  set -e

  : >"$wait_log"
  status=2
  conn="postgresql://$(id -un)@127.0.0.1:$port/postgres"
  for _ in $(seq 1 300); do
    if "$NATIVE_INSTALL_DIR/bin/psql" "$conn" -X -q -c 'select 1' >>"$wait_log" 2>&1; then
      status=0
      break
    fi
    if ! kill -0 "$server_pid" 2>/dev/null; then
      echo "native server exited before readiness" >>"$wait_log"
      break
    fi
    sleep 0.1
  done
  if [ "$status" -ne 0 ]; then
    record_result native native readiness "$status" 0 "" 0 "$wait_log" "port=$port"
    stop_pid "$server_pid"
    return "$status"
  fi

  for workload in "${workloads[@]}"; do
    if ! run_psql_workload native native "$workload" "$conn" "$report_root"; then
      status=1
    fi
  done

  stop_pid "$server_pid"
  return "$status"
}

bench_wasix_profile() {
  local profile="$1"
  local port="$2"
  local install_dir run_root report_root pgdata dev_shm initdb_log server_log wait_log backend_log
  local wasmer_bin wasmer_cache_dir wasmer_compiler wasmer_llvm_opt_level wasmer_stack_size wasmer_compiler_threads
  local pinned_profile
  local server_pid="" conn status started_ms ended_ms
  local postgres_args

  install_dir="$(fresh_wasix_core_install_dir_for "$profile")"
  if [ -n "${FRESH_PINNED_WASIX_INSTALL_DIR:-}" ]; then
    pinned_profile="$(fresh_normalize_wasix_core_profile "${FRESH_PINNED_WASIX_CORE_PROFILE:-$profile}")"
    if [ "$profile" != "$pinned_profile" ]; then
      report_root="$query_report_dir/$profile"
      mkdir -p "$report_root"
      record_result wasix "$profile" build 2 0 "" 0 "$report_root/build.log" \
        "pinned install profile=$pinned_profile cannot satisfy requested profile=$profile"
      return 2
    fi
    install_dir="$FRESH_PINNED_WASIX_INSTALL_DIR"
  fi
  run_root="$query_run_root/$profile"
  report_root="$query_report_dir/$profile"
  pgdata="$run_root/pgdata"
  dev_shm="$run_root/dev-shm"
  initdb_log="$report_root/initdb.log"
  server_log="$report_root/server.log"
  wait_log="$report_root/wait.log"
  backend_log="$report_root/wasmer-backend.log"

  fresh_require_managed_generated_path "$pgdata" "WASIX query benchmark PGDATA"
  fresh_require_managed_generated_path "$dev_shm" "WASIX query benchmark shared-memory root"
  mkdir -p "$run_root" "$report_root"
  rm -rf "$pgdata" "$dev_shm"
  mkdir -p "$dev_shm"

  if [ -n "${FRESH_PINNED_WASIX_INSTALL_DIR:-}" ] && [ "$skip_build" -ne 1 ]; then
    printf 'pinned runtime %s requires --skip-build\n' "${FRESH_PINNED_RUNTIME_NAME:-$FRESH_PINNED_WASIX_INSTALL_DIR}" >"$report_root/build.log"
    record_result wasix "$profile" build 2 0 "" 0 "$report_root/build.log" \
      "pinned runtime requires --skip-build"
    return 2
  fi
  if [ -n "${FRESH_PINNED_WASMER_CACHE_DIR:-}" ] && [ "$skip_precompile" -ne 1 ]; then
    printf 'pinned runtime %s requires --skip-precompile\n' "${FRESH_PINNED_RUNTIME_NAME:-$FRESH_PINNED_WASMER_CACHE_DIR}" >"$report_root/precompile.log"
    record_result wasix "$profile" precompile 2 0 "" 0 "$report_root/precompile.log" \
      "pinned runtime requires --skip-precompile"
    return 2
  fi

  if [ "$skip_build" -ne 1 ]; then
    WASIX_CORE_PROFILE="$profile" \
      WASIX_BUILD_DIR="$(fresh_wasix_core_build_dir_for "$profile")" \
      WASIX_INSTALL_DIR="$install_dir" \
      REPORT_DIR="$(fresh_wasix_core_report_dir_for "$profile")" \
      RUN_DIR="$(fresh_wasix_core_run_dir_for "$profile")" \
      "$FRESH_ROOT/bin/build-wasix-core.sh" >/dev/null
  elif [ ! -x "$install_dir/bin/postgres" ]; then
    record_result wasix "$profile" build 2 0 "" 0 "$report_root/build.log" "missing install with --skip-build"
    return 2
  fi

  if [ "$skip_precompile" -ne 1 ]; then
    WASIX_CORE_PROFILE="$profile" \
      WASIX_BUILD_DIR="$(fresh_wasix_core_build_dir_for "$profile")" \
      WASIX_INSTALL_DIR="$install_dir" \
      REPORT_DIR="$(fresh_wasix_core_report_dir_for "$profile")" \
      RUN_DIR="$(fresh_wasix_core_run_dir_for "$profile")" \
      WASIX_PRECOMPILE_SCOPE="$precompile_scope" \
      "$FRESH_ROOT/bin/precompile-wasix-core.sh" >"$report_root/precompile.log" 2>&1
  else
    printf 'precompile skipped\n' >"$report_root/precompile.log"
  fi

  wasmer_bin="$(fresh_wasmer_bin)"
  wasmer_cache_dir="$(fresh_wasmer_cache_dir "$wasmer_bin")"
  wasmer_compiler="$(fresh_wasmer_compiler)"
  wasmer_llvm_opt_level="${WASMER_LLVM_OPT_LEVEL:-aggressive}"
  wasmer_stack_size="${WASMER_STACK_SIZE:-33554432}"
  wasmer_compiler_threads="${WASMER_COMPILER_THREADS:-$(fresh_jobs)}"
  if ! fresh_require_wasmer_compiler_cli "$wasmer_bin" "$wasmer_compiler" run >"$backend_log" 2>&1; then
    record_result wasix "$profile" backend 2 0 "" 0 "$backend_log" "compiler=$wasmer_compiler"
    return 2
  fi

  wasmer_env=(
    "WASMER_DIR=$FRESH_WORK_ROOT/tools/wasmer-home"
    "WASMER_CACHE_DIR=$wasmer_cache_dir"
  )
  wasmer_args=(
    run
    --quiet
  )
  while IFS= read -r arg; do
    wasmer_args+=("$arg")
  done < <(fresh_wasmer_compiler_args_for "$wasmer_bin" run "$wasmer_compiler" "$wasmer_llvm_opt_level" "$wasmer_compiler_threads")
  wasmer_args+=(
    --stack-size "$wasmer_stack_size"
    --enable-exceptions
    --enable-threads
    --net
    --volume "$REPO_ROOT:$REPO_ROOT"
    --volume "$install_dir/lib:/lib"
    --volume "$dev_shm:/dev/shm"
  )
  if [ "${#wasmer_extra_args[@]}" -gt 0 ]; then
    wasmer_args+=("${wasmer_extra_args[@]}")
  fi

  started_ms="$(now_ms)"
  set +e
  env "${wasmer_env[@]}" \
    "$wasmer_bin" "${wasmer_args[@]}" "$install_dir/bin/initdb" -- \
      -D "$pgdata" \
      -A trust \
      --no-locale \
      --encoding=UTF8 \
      --no-instructions \
      >"$initdb_log" 2>&1
  status=$?
  set -e
  ended_ms="$(now_ms)"
  if [ "$status" -ne 0 ]; then
    record_result wasix "$profile" initdb "$status" "$((ended_ms - started_ms))" "" 0 "$initdb_log" "pgdata=$pgdata"
    return "$status"
  fi

  set +e
  postgres_args=(
    -D "$pgdata"
    -h 127.0.0.1
    -p "$port"
    -c unix_socket_directories=
  )
  if [ "${#postgres_gucs[@]}" -gt 0 ]; then
    for guc in "${postgres_gucs[@]}"; do
      postgres_args+=(-c "$guc")
    done
  fi
  env "${wasmer_env[@]}" \
    "$wasmer_bin" "${wasmer_args[@]}" "$install_dir/bin/postgres" -- \
      "${postgres_args[@]}" >"$server_log" 2>&1 &
  server_pid=$!
  set -e

  : >"$wait_log"
  status=2
  conn="postgresql://wasix@127.0.0.1:$port/postgres"
  for _ in $(seq 1 300); do
    if "$NATIVE_INSTALL_DIR/bin/psql" "$conn" -X -q -c 'select 1' >>"$wait_log" 2>&1; then
      status=0
      break
    fi
    if ! kill -0 "$server_pid" 2>/dev/null; then
      echo "WASIX server exited before readiness" >>"$wait_log"
      break
    fi
    sleep 0.1
  done
  if [ "$status" -ne 0 ]; then
    record_result wasix "$profile" readiness "$status" 0 "" 0 "$wait_log" "port=$port"
    stop_pid "$server_pid"
    return "$status"
  fi

  for workload in "${workloads[@]}"; do
    if ! run_psql_workload wasix "$profile" "$workload" "$conn" "$report_root"; then
      status=1
    fi
  done

  stop_pid "$server_pid"
  return "$status"
}

write_header

overall_status=0
port="$start_port"

if [ "$skip_native" -ne 1 ]; then
  if ! bench_native "$port"; then
    overall_status=1
  fi
  port=$((port + 1))
fi

for profile in "${profiles[@]}"; do
  if ! bench_wasix_profile "$profile" "$port"; then
    overall_status=1
  fi
  port=$((port + 1))
done

write_stats

{
  printf '\n## Completion\n\n'
  printf -- '- Exit code: `%s`\n' "$overall_status"
  printf -- '- Finished: `%s`\n' "$(fresh_timestamp)"
} >>"$summary_md"

printf 'query performance matrix written to %s\n' "$summary_tsv"
exit "$overall_status"
