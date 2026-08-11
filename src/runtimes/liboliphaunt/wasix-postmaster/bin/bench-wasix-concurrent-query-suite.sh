#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
source "$FRESH_ROOT/lib/process-supervision.sh"
source "$FRESH_ROOT/lib/server-lifecycle.sh"
source "$FRESH_ROOT/lib/sealed-carrier.sh"
source "$FRESH_ROOT/lib/host-fd-telemetry.sh"
source "$FRESH_ROOT/lib/postgres-profiles.sh"
source "$FRESH_ROOT/lib/qualification-identities.sh"

usage() {
  cat <<'USAGE'
Usage: bench-wasix-concurrent-query-suite.sh [options]

Runs native PostgreSQL and WASIX PostgreSQL under the same concurrent client
fanout, then records bulk-batch wall throughput, summed psql-timed statement
duration, verification counts, and runtime epoll interruption counts. Every
client connects before the timed start gate and remains connected through an
untimed drain gate, so the fanout resource phase has a stable backend
population. These batch fields exclude connection/backend launch and teardown;
they are not per-query latency.

The optional native-libpq latency lane records raw CLOCK_MONOTONIC durations
for persistent SELECT 1 calls and, separately, complete
PQconnectdb -> SELECT 1 -> PQfinish reconnect/backend-launch operations.

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
  --sealed-carrier DIR  Run WASIX from a self-contained, compiler-free sealed
                       carrier. The carrier must contain bin/wasmer-headless,
                       bin/{initdb,postgres}, lib/, share/postgresql/, aot/,
                       manifest.json, and wasmer-build.receipt. This mode does
                       not use a Wasmer filesystem cache or precompilation.
  --require-zero-write-aot
                       Require direct activation from immutable AOT and
                       executable memory-image inodes. Reflink and streamed
                       compatibility modes are rejected. The loader emits a
                       machine audit receipt whose write and sync counters are
                       validated after shutdown. Requires sealed mode, Linux,
                       an unprivileged caller, and no CAP_LINUX_IMMUTABLE.
  --immutable-carrier-receipt FILE
                       External receipt created by
                       deploy-immutable-sealed-carrier.sh. Required with
                       --require-zero-write-aot and rejected otherwise. The
                       read-only verifier revalidates the exact full carrier
                       closure and receipt before any measured process starts.
  --immutable-carrier-verification-scope MODE
                       Immutable verification scope: `full` performs the
                       campaign-boundary cryptographic pass in this process;
                       `campaign-fast` performs only receipt-bound inode/+i
                       checks because an enclosing qualifier owns the full
                       start/end passes. Default: full.
  --timeout SECONDS     Absolute initdb/readiness/control/setup/client/verify
                       timeout. Process cleanup has a separate bounded grace.
                       Default: 120.
  --resource-interval S Process resource sample interval in seconds. Default: 0.5.
  --resource-detail MODE
                       Resource sampler detail: `full` records Linux PSS and
                       mapping accounting, `light` records only ps process
                       totals, and `off` disables the background sampler.
                       Use full for memory attribution and off for
                       throughput/latency qualification. Latency samples are
                       rejected unless this is off. Default: full.
  --shared-memory-provider ID
                       Host backing mounted at guest /dev/shm for the WASIX
                       target. `portable-file-v1` preserves the run-tree file
                       directory. Explicit `linux-tmpfs-v1` creates a private,
                       evidence-bound directory on Linux /dev/shm. Default:
                       portable-file-v1.
  --cgroup-memory-max SIZE
                       Launch only the measured server tree in a transient
                       systemd user scope with MemoryMax=SIZE.
  --cgroup-memory-high SIZE
                       Set MemoryHigh=SIZE on that server scope.
  --cgroup-swap-max SIZE
                       Set MemorySwapMax=SIZE on that server scope. Defaults
                       to 0 whenever a cgroup memory control is requested.
  --adaptive-cache-evidence-policy POLICY
                       Adaptive file-cache acceptance policy. The default
                       `portable-correctness-v1` accepts exact active or
                       observe-only fallback evidence. Opt-in
                       `constrained-linux-wal-action-v1` requires a sealed
                       Linux run with explicit finite MemoryMax/MemoryHigh,
                       adaptive-active admission, class-6 offers and action,
                       and zero telemetry/advice errors.
  --cold-ownership     Run only the Linux sealed-carrier cold-start lane. After
                       initdb, content-hash and individually evict every
                       regular carrier/PGDATA page, prove zero residency with
                       mincore, then immediately launch the postmaster in the
                       fresh cgroup. Requires full sampling and explicit
                       MemoryMax/MemoryHigh/MemorySwapMax limits.
  --cold-ownership-workloads
                       Keep explicitly selected WASIX workloads after the cold
                       first-query capture, proving page-residency/charge and
                       fanout/retention overlap in one cgroup. Storage-I/O
                       first-touch is claimed only when io.stat is available.
                       Requires
                       --cold-ownership and an explicit --workload(s).
  --max-peak-pss-kib N
                       Fail full-detail evidence if any required fan-out sample
                       exceeds this aggregate process-tree PSS ceiling.
  --max-peak-pss-anon-kib N
                       Fail if aggregate anonymous PSS exceeds this KiB ceiling.
  --max-peak-page-table-kib N
                       Fail if aggregate page-table memory exceeds this KiB ceiling.
  --max-cgroup-high-events-delta N
                       Fail if summed memory.events high deltas across required
                       fan-out phases exceed this count.
  --max-psi-some-stall-fraction F
                       Fail if summed cgroup PSI some-stall time divided by
                       elapsed fan-out time exceeds F in [0,1].
  --max-psi-full-stall-fraction F
                       Fail if the corresponding cgroup PSI full-stall fraction
                       exceeds F in [0,1]. Any memory budget requires full
                       resource detail; cgroup budgets require a dedicated scope.
  --quiescence-seconds S
                       Leave the server idle after readiness and each workload,
                       retaining resource samples and before/after memory maps.
                       Default: 0 (disabled).
  --checkpoint-policy POLICY
                       PostgreSQL checkpoint policy. `default` leaves server
                       defaults intact. `controlled` preserves fsync/WAL
                       durability, checkpoints synchronously after setup, and
                       fails if a checkpoint runs during fanout. The lifecycle
                       lane always owns the controlled policy so timed
                       maintenance cannot masquerade as reconnect retention.
                       Default: default.
  --runtime-footprint ID
                       Named PostgreSQL runtime-footprint profile. Supported:
                       embedded-concurrent.
  --durability ID      Named PostgreSQL durability profile. Supported: safe.
  --libpq-latency-samples N
                       Enable the true-latency lane with N measured samples
                       per mode and target. Default: 0 (disabled).
  --libpq-latency-warmup N
                       Warmup samples per latency mode. Warmups are retained
                       raw but excluded from percentiles. Default: 20.
  --libpq-latency-only Run only the two latency modes; do not create or run
                       bulk workloads. Requires --libpq-latency-samples.
                       The measured server inherits hard RLIMIT_NOFILE unchanged
                       and is forced to soft RLIMIT_NOFILE=1024. Linux evidence
                       also gates quiescent host-FD growth after reconnects.
  --pg-wait-sample-interval S
                       Sample pg_stat_activity wait events during each fanout
                       through one persistent diagnostic connection.
                       Default: 0 (disabled).
  --wasix-perf-stats   Enable WASIX perf-stats counters for the WASIX target.
                       Requires a Wasmer build with wasmer-wasix/perf-stats.
  --wasix-wait-dump-interval-ms MS
                       Dump compact runtime lifecycle state while waits remain
                       parked. This perturbs the wait hot path and is valid only
                       with --wasix-lifecycle-plateau, never a timed workload or
                       latency lane. Requires a wait-dump capable Wasmer build
                       but does not require perf counters. Default: 0.
  --wasix-wait-dump-max-per-wait N
                       Maximum wait-registry snapshots per individual parked
                       wait before logging one suppression marker. Use 0 for
                       unlimited. Default: 8.
  --wasix-wait-dump-verbose
                       Include per-state futex, shared-mapping, guest-FD, socket,
                       and epoll inventories in the untimed lifecycle log.
                       Rejected by every timed workload and latency lane.
  --wasix-lifecycle-plateau
                       Run only the untimed WASIX reconnect lifecycle lane.
                       It gates exact readiness/post-quiescence plateaus for
                       process, task, shared-futex registry, mapping, and guest
                       FD occupancy. Incompatible with latency/workload lanes.
  --wasix-lifecycle-reconnects N
                       Sequential reconnects in the lifecycle lane. Default: 64.
  --wasix-lifecycle-window-seconds S
                       Readiness and post-churn sampling window. Must provide
                       at least three samples spanning one second. Default: 5.
  --wasix-lifecycle-memory-checkpoint-every N
                       On Linux, capture one host-Wasmer smaps checkpoint after
                       every N reconnect clients have been reaped and the
                       explicit settling window has elapsed. Baseline and final
                       checkpoints are additionally runtime-fenced. Default: 0
                       (disabled).
  --wasix-lifecycle-memory-quiescence-seconds S
                       Settling window before each intermediate memory
                       checkpoint. No smaps reads occur while a reconnect client
                       is running. Default: 2.
  --max-lifecycle-pss-growth-kib N
                       Maximum full-run, terminal, and late-tail PSS growth in
                       the checkpoint lane.
  --max-lifecycle-pss-anon-growth-kib N
                       Corresponding Pss_Anon growth ceiling.
  --max-lifecycle-heap-growth-kib N
                       Corresponding [heap] mapping PSS growth ceiling. All
                       three ceilings are required when checkpoints are enabled.
  --max-lifecycle-late-pss-slope-kib-per-1000 N
                       Maximum late-tail Theil-Sen PSS slope in KiB per 1000
                       reconnects.
  --max-lifecycle-late-pss-anon-slope-kib-per-1000 N
                       Corresponding Pss_Anon late-tail slope ceiling.
  --max-lifecycle-late-heap-slope-kib-per-1000 N
                       Corresponding [heap] PSS late-tail slope ceiling. All
                       three slope ceilings are also required.
  --lifecycle-baseline-policy FILE
                       Checked-in policy below profiles/lifecycle-baselines/.
                       The default is exploratory/unbounded. A qualifying run
                       must select a separately frozen qualification-bounded
                       policy produced from an earlier exploratory run.
  --memory-map-snapshots
                       Capture vmmap/pmap snapshots at readiness and fanout
                       boundaries. Expensive and off by default.
  --sample-seconds S   Run sample(1) against the WASIX server during fanout.
                       Default: 0 (disabled).
  --sample-delay S     Delay after fanout starts before sample(1). Default: 0.2.
  --start-port PORT     First PostgreSQL port. Default: PGPORT or 55620.
  --label NAME          Report/run label. Default: timestamped.
  --discard-pgdata     After a fully successful target run and clean shutdown,
                       delete only that target's generated PGDATA and provider
                       backing. External linux-tmpfs-v1 backing is released
                       after owned processes drain; identity drift or surviving
                       objects fail closed and retain it for diagnosis.
                       Failed PGDATA and portable backing are retained; an
                       empty external tmpfs root is still safely released.
  --postgres-guc GUC    Extra postmaster -c name=value setting. May repeat.
  --wasmer-arg ARG      Extra wasmer run argument. May repeat.
  -h, --help            Show this help.
USAGE
}

connections="${WASIX_CONCURRENT_CONNECTIONS:-4}"
iterations="${WASIX_CONCURRENT_ITERATIONS:-1000}"
row_count="${WASIX_CONCURRENT_ROWS:-100000}"
timeout_seconds="${WASIX_CONCURRENT_TIMEOUT:-120}"
process_term_grace_ms="${WASIX_PROCESS_TERM_GRACE_MS:-1000}"
process_kill_grace_ms="${WASIX_PROCESS_KILL_GRACE_MS:-3000}"
resource_sample_interval="${WASIX_RESOURCE_SAMPLE_INTERVAL:-0.5}"
resource_detail="${WASIX_RESOURCE_DETAIL:-full}"
resource_detail_explicit=0
shared_memory_provider=portable-file-v1
shared_memory_provider_explicit=0
cgroup_memory_max="${WASIX_CGROUP_MEMORY_MAX:-}"
cgroup_memory_high="${WASIX_CGROUP_MEMORY_HIGH:-}"
cgroup_swap_max="${WASIX_CGROUP_SWAP_MAX:-}"
adaptive_cache_evidence_policy=portable-correctness-v1
adaptive_cache_evidence_policy_explicit=0
cold_ownership="${WASIX_COLD_OWNERSHIP:-0}"
cold_ownership_workloads=0
max_peak_pss_kib="${WASIX_MAX_PEAK_PSS_KIB:-}"
max_peak_pss_anon_kib="${WASIX_MAX_PEAK_PSS_ANON_KIB:-}"
max_peak_page_table_kib="${WASIX_MAX_PEAK_PAGE_TABLE_KIB:-}"
max_cgroup_high_events_delta="${WASIX_MAX_CGROUP_HIGH_EVENTS_DELTA:-}"
max_psi_some_stall_fraction="${WASIX_MAX_PSI_SOME_STALL_FRACTION:-}"
max_psi_full_stall_fraction="${WASIX_MAX_PSI_FULL_STALL_FRACTION:-}"
quiescence_seconds="${WASIX_QUIESCENCE_SECONDS:-0}"
checkpoint_policy="${WASIX_CHECKPOINT_POLICY:-default}"
runtime_footprint="${WASIX_RUNTIME_FOOTPRINT:-}"
durability_profile="${WASIX_DURABILITY_PROFILE:-}"
libpq_latency_samples="${WASIX_LIBPQ_LATENCY_SAMPLES:-0}"
libpq_latency_warmup="${WASIX_LIBPQ_LATENCY_WARMUP:-20}"
libpq_latency_soft_nofile=1024
libpq_latency_host_fd_allowance="${WASIX_LIBPQ_LATENCY_HOST_FD_ALLOWANCE:-4}"
libpq_latency_only=0
pg_wait_sample_interval="${WASIX_PG_WAIT_SAMPLE_INTERVAL:-0}"
start_port="${PGPORT:-55620}"
run_label="${WASIX_CONCURRENT_LABEL:-$(date -u +%Y%m%dT%H%M%SZ)}"
discard_pgdata=0
skip_build=0
skip_precompile="${WASIX_SKIP_PRECOMPILE:-0}"
skip_precompile_explicit=0
sealed_carrier=""
sealed_carrier_explicit=0
require_frozen_measurement_tools="${FRESH_REQUIRE_FROZEN_MEASUREMENT_TOOLS:-0}"
require_zero_write_aot=0
require_zero_write_aot_explicit=0
immutable_carrier_receipt=""
immutable_carrier_receipt_explicit=0
immutable_carrier_verification_scope=full
wasix_perf_stats="${WASIX_PERF_STATS:-0}"
wasix_wait_dump_interval_ms="${WASIX_PERF_WAIT_DUMP_INTERVAL_MS:-0}"
wasix_wait_dump_max_per_wait="${WASIX_WAIT_DUMP_MAX_PER_WAIT:-8}"
wasix_wait_dump_verbose="${WASIX_WAIT_DUMP_VERBOSE:-}"
wasix_lifecycle_plateau="${WASIX_LIFECYCLE_PLATEAU:-0}"
wasix_lifecycle_reconnects="${WASIX_LIFECYCLE_RECONNECTS:-64}"
wasix_lifecycle_window_seconds="${WASIX_LIFECYCLE_WINDOW_SECONDS:-5}"
wasix_lifecycle_memory_checkpoint_every="${WASIX_LIFECYCLE_MEMORY_CHECKPOINT_EVERY:-0}"
wasix_lifecycle_memory_quiescence_seconds="${WASIX_LIFECYCLE_MEMORY_QUIESCENCE_SECONDS:-2}"
max_lifecycle_pss_growth_kib="${WASIX_MAX_LIFECYCLE_PSS_GROWTH_KIB:-}"
max_lifecycle_pss_anon_growth_kib="${WASIX_MAX_LIFECYCLE_PSS_ANON_GROWTH_KIB:-}"
max_lifecycle_heap_growth_kib="${WASIX_MAX_LIFECYCLE_HEAP_GROWTH_KIB:-}"
max_late_lifecycle_pss_slope_kib_per_1000="${WASIX_MAX_LATE_LIFECYCLE_PSS_SLOPE_KIB_PER_1000:-}"
max_late_lifecycle_pss_anon_slope_kib_per_1000="${WASIX_MAX_LATE_LIFECYCLE_PSS_ANON_SLOPE_KIB_PER_1000:-}"
max_late_lifecycle_heap_slope_kib_per_1000="${WASIX_MAX_LATE_LIFECYCLE_HEAP_SLOPE_KIB_PER_1000:-}"
lifecycle_baseline_policy_source="$FRESH_ROOT/profiles/lifecycle-baselines/relative-stabilized-idle-postmaster-exploratory-v1.tsv"
lifecycle_baseline_policy_explicit=0
memory_map_snapshots="${WASIX_MEMORY_MAP_SNAPSHOTS:-0}"
sample_seconds="${WASIX_CONCURRENT_SAMPLE_SECONDS:-0}"
sample_delay="${WASIX_CONCURRENT_SAMPLE_DELAY:-0.2}"
targets=()
workloads=()
workloads_explicit=0
postgres_gucs=()
wasmer_extra_args=()
wasix_wait_dump_cli_config=0
wait_dump_environment_names=(
  WASIX_PERF_WAIT_DUMP_INTERVAL_MS
  WASIX_PERF_WAIT_DUMP_FILE
  WASIX_PERF_WAIT_DUMP_MAX_PER_WAIT
  WASIX_PERF_WAIT_DUMP_VERBOSE
  WASIX_WAIT_DUMP_INTERVAL_MS
  WASIX_WAIT_DUMP_FILE
  WASIX_WAIT_DUMP_MAX_PER_WAIT
  WASIX_WAIT_DUMP_VERBOSE
  WASIX_WAIT_DUMP_FENCE_REQUEST_FILE
  WASIX_WAIT_DUMP_FENCE_ACK_FILE
)
sealed_loader_environment_names=(
  OLIPHAUNT_WASIX_REQUIRE_ZERO_WRITE_AOT
  OLIPHAUNT_WASIX_SEALED_LOADER_AUDIT_FILE
  OLIPHAUNT_WASIX_CACHE_OFFER_TELEMETRY_FILE
)
ambient_wait_dump_environment=()
for wait_dump_name in "${wait_dump_environment_names[@]}"; do
  if [[ -v $wait_dump_name ]]; then
    ambient_wait_dump_environment+=("$wait_dump_name")
  fi
done

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
      workloads_explicit=1
      ;;
    --workloads)
      shift
      [ "$#" -gt 0 ] || { echo "--workloads requires a value" >&2; exit 2; }
      for workload in $1; do
        workloads+=("$workload")
      done
      workloads_explicit=1
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
      skip_precompile_explicit=1
      ;;
    --sealed-carrier)
      shift
      [ "$#" -gt 0 ] || { echo "--sealed-carrier requires a directory" >&2; exit 2; }
      [ "$sealed_carrier_explicit" -eq 0 ] || { echo "--sealed-carrier may only be specified once" >&2; exit 2; }
      sealed_carrier="$1"
      sealed_carrier_explicit=1
      ;;
    --require-zero-write-aot)
      [ "$require_zero_write_aot_explicit" -eq 0 ] || {
        echo '--require-zero-write-aot may only be specified once' >&2
        exit 2
      }
      require_zero_write_aot=1
      require_zero_write_aot_explicit=1
      ;;
    --immutable-carrier-receipt)
      shift
      [ "$#" -gt 0 ] || { echo '--immutable-carrier-receipt requires a file' >&2; exit 2; }
      [ "$immutable_carrier_receipt_explicit" -eq 0 ] || {
        echo '--immutable-carrier-receipt may only be specified once' >&2
        exit 2
      }
      immutable_carrier_receipt="$1"
      immutable_carrier_receipt_explicit=1
      ;;
    --immutable-carrier-verification-scope)
      shift
      [ "$#" -gt 0 ] || {
        echo '--immutable-carrier-verification-scope requires full or campaign-fast' >&2
        exit 2
      }
      immutable_carrier_verification_scope="$1"
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
    --resource-detail)
      shift
      [ "$#" -gt 0 ] || { echo "--resource-detail requires full, light, or off" >&2; exit 2; }
      resource_detail="$1"
      resource_detail_explicit=1
      ;;
    --shared-memory-provider)
      shift
      [ "$#" -gt 0 ] || { echo "--shared-memory-provider requires an ID" >&2; exit 2; }
      [ "$shared_memory_provider_explicit" -eq 0 ] || {
        echo "--shared-memory-provider may only be specified once" >&2
        exit 2
      }
      shared_memory_provider="$1"
      shared_memory_provider_explicit=1
      ;;
    --cgroup-memory-max)
      shift
      [ "$#" -gt 0 ] || { echo "--cgroup-memory-max requires a size" >&2; exit 2; }
      cgroup_memory_max="$1"
      ;;
    --cgroup-memory-high)
      shift
      [ "$#" -gt 0 ] || { echo "--cgroup-memory-high requires a size" >&2; exit 2; }
      cgroup_memory_high="$1"
      ;;
    --cgroup-swap-max)
      shift
      [ "$#" -gt 0 ] || { echo "--cgroup-swap-max requires a size" >&2; exit 2; }
      cgroup_swap_max="$1"
      ;;
    --adaptive-cache-evidence-policy)
      shift
      [ "$#" -gt 0 ] || {
        echo "--adaptive-cache-evidence-policy requires a policy ID" >&2
        exit 2
      }
      [ "$adaptive_cache_evidence_policy_explicit" -eq 0 ] || {
        echo "--adaptive-cache-evidence-policy may only be specified once" >&2
        exit 2
      }
      adaptive_cache_evidence_policy="$1"
      adaptive_cache_evidence_policy_explicit=1
      ;;
    --cold-ownership)
      cold_ownership=1
      ;;
    --cold-ownership-workloads)
      cold_ownership_workloads=1
      ;;
    --max-peak-pss-kib)
      shift
      [ "$#" -gt 0 ] || { echo "--max-peak-pss-kib requires a value" >&2; exit 2; }
      max_peak_pss_kib="$1"
      ;;
    --max-peak-pss-anon-kib)
      shift
      [ "$#" -gt 0 ] || { echo "--max-peak-pss-anon-kib requires a value" >&2; exit 2; }
      max_peak_pss_anon_kib="$1"
      ;;
    --max-peak-page-table-kib)
      shift
      [ "$#" -gt 0 ] || { echo "--max-peak-page-table-kib requires a value" >&2; exit 2; }
      max_peak_page_table_kib="$1"
      ;;
    --max-cgroup-high-events-delta)
      shift
      [ "$#" -gt 0 ] || { echo "--max-cgroup-high-events-delta requires a value" >&2; exit 2; }
      max_cgroup_high_events_delta="$1"
      ;;
    --max-psi-some-stall-fraction)
      shift
      [ "$#" -gt 0 ] || { echo "--max-psi-some-stall-fraction requires a value" >&2; exit 2; }
      max_psi_some_stall_fraction="$1"
      ;;
    --max-psi-full-stall-fraction)
      shift
      [ "$#" -gt 0 ] || { echo "--max-psi-full-stall-fraction requires a value" >&2; exit 2; }
      max_psi_full_stall_fraction="$1"
      ;;
    --quiescence-seconds)
      shift
      [ "$#" -gt 0 ] || { echo "--quiescence-seconds requires a value" >&2; exit 2; }
      quiescence_seconds="$1"
      ;;
    --checkpoint-policy)
      shift
      [ "$#" -gt 0 ] || { echo "--checkpoint-policy requires default or controlled" >&2; exit 2; }
      checkpoint_policy="$1"
      ;;
    --runtime-footprint)
      shift
      [ "$#" -gt 0 ] || { echo "--runtime-footprint requires an ID" >&2; exit 2; }
      runtime_footprint="$1"
      ;;
    --durability)
      shift
      [ "$#" -gt 0 ] || { echo "--durability requires an ID" >&2; exit 2; }
      durability_profile="$1"
      ;;
    --libpq-latency-samples)
      shift
      [ "$#" -gt 0 ] || { echo "--libpq-latency-samples requires a value" >&2; exit 2; }
      libpq_latency_samples="$1"
      ;;
    --libpq-latency-warmup)
      shift
      [ "$#" -gt 0 ] || { echo "--libpq-latency-warmup requires a value" >&2; exit 2; }
      libpq_latency_warmup="$1"
      ;;
    --libpq-latency-only)
      libpq_latency_only=1
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
      wasix_wait_dump_cli_config=1
      ;;
    --wasix-wait-dump-max-per-wait)
      shift
      [ "$#" -gt 0 ] || { echo "--wasix-wait-dump-max-per-wait requires a value" >&2; exit 2; }
      wasix_wait_dump_max_per_wait="$1"
      wasix_wait_dump_cli_config=1
      ;;
    --wasix-wait-dump-verbose)
      wasix_wait_dump_verbose=1
      wasix_wait_dump_cli_config=1
      ;;
    --wasix-lifecycle-plateau)
      wasix_lifecycle_plateau=1
      ;;
    --wasix-lifecycle-reconnects)
      shift
      [ "$#" -gt 0 ] || { echo "--wasix-lifecycle-reconnects requires a value" >&2; exit 2; }
      wasix_lifecycle_reconnects="$1"
      ;;
    --wasix-lifecycle-window-seconds)
      shift
      [ "$#" -gt 0 ] || { echo "--wasix-lifecycle-window-seconds requires a value" >&2; exit 2; }
      wasix_lifecycle_window_seconds="$1"
      ;;
    --wasix-lifecycle-memory-checkpoint-every)
      shift
      [ "$#" -gt 0 ] || { echo "--wasix-lifecycle-memory-checkpoint-every requires a value" >&2; exit 2; }
      wasix_lifecycle_memory_checkpoint_every="$1"
      ;;
    --wasix-lifecycle-memory-quiescence-seconds)
      shift
      [ "$#" -gt 0 ] || { echo "--wasix-lifecycle-memory-quiescence-seconds requires a value" >&2; exit 2; }
      wasix_lifecycle_memory_quiescence_seconds="$1"
      ;;
    --max-lifecycle-pss-growth-kib)
      shift
      [ "$#" -gt 0 ] || { echo "--max-lifecycle-pss-growth-kib requires a value" >&2; exit 2; }
      max_lifecycle_pss_growth_kib="$1"
      ;;
    --max-lifecycle-pss-anon-growth-kib)
      shift
      [ "$#" -gt 0 ] || { echo "--max-lifecycle-pss-anon-growth-kib requires a value" >&2; exit 2; }
      max_lifecycle_pss_anon_growth_kib="$1"
      ;;
    --max-lifecycle-heap-growth-kib)
      shift
      [ "$#" -gt 0 ] || { echo "--max-lifecycle-heap-growth-kib requires a value" >&2; exit 2; }
      max_lifecycle_heap_growth_kib="$1"
      ;;
    --max-lifecycle-late-pss-slope-kib-per-1000)
      shift
      [ "$#" -gt 0 ] || { echo "--max-lifecycle-late-pss-slope-kib-per-1000 requires a value" >&2; exit 2; }
      max_late_lifecycle_pss_slope_kib_per_1000="$1"
      ;;
    --max-lifecycle-late-pss-anon-slope-kib-per-1000)
      shift
      [ "$#" -gt 0 ] || { echo "--max-lifecycle-late-pss-anon-slope-kib-per-1000 requires a value" >&2; exit 2; }
      max_late_lifecycle_pss_anon_slope_kib_per_1000="$1"
      ;;
    --max-lifecycle-late-heap-slope-kib-per-1000)
      shift
      [ "$#" -gt 0 ] || { echo "--max-lifecycle-late-heap-slope-kib-per-1000 requires a value" >&2; exit 2; }
      max_late_lifecycle_heap_slope_kib_per_1000="$1"
      ;;
    --lifecycle-baseline-policy)
      shift
      [ "$#" -gt 0 ] || { echo "--lifecycle-baseline-policy requires a file" >&2; exit 2; }
      [ "$lifecycle_baseline_policy_explicit" -eq 0 ] || {
        echo "--lifecycle-baseline-policy may only be specified once" >&2
        exit 2
      }
      lifecycle_baseline_policy_source="$1"
      lifecycle_baseline_policy_explicit=1
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
    --discard-pgdata)
      discard_pgdata=1
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

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

is_nonnegative_integer() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

is_nonnegative_number() {
  [[ "$1" =~ ^([0-9]+([.][0-9]*)?|[.][0-9]+)$ ]]
}

is_positive_number() {
  is_nonnegative_number "$1" && awk -v value="$1" 'BEGIN { exit !((value + 0) > 0) }'
}

validate_unsigned_budget() {
  local option="$1"
  local value="$2"
  [ -z "$value" ] && return 0
  if ! is_nonnegative_integer "$value" ||
    ! awk -v value="$value" 'BEGIN { exit !(value <= 9007199254740991) }'
  then
    printf '%s requires a nonnegative integer in the exact supported range\n' \
      "$option" >&2
    exit 2
  fi
}

validate_fraction_budget() {
  local option="$1"
  local value="$2"
  [ -z "$value" ] && return 0
  if ! is_nonnegative_number "$value" ||
    ! awk -v value="$value" 'BEGIN { exit !(value >= 0 && value <= 1) }'
  then
    printf '%s requires a decimal fraction between 0 and 1 inclusive\n' \
      "$option" >&2
    exit 2
  fi
}

case "$require_frozen_measurement_tools" in
  0|1) ;;
  *)
    echo 'FRESH_REQUIRE_FROZEN_MEASUREMENT_TOOLS must be 0 or 1' >&2
    exit 2
    ;;
esac

is_positive_integer "$connections" || { echo "--connections requires a positive integer" >&2; exit 2; }
is_positive_integer "$iterations" || { echo "--iterations requires a positive integer" >&2; exit 2; }
is_positive_integer "$row_count" || { echo "--rows requires a positive integer" >&2; exit 2; }
is_positive_integer "$timeout_seconds" || { echo "--timeout requires a positive integer" >&2; exit 2; }
case "$process_term_grace_ms:$process_kill_grace_ms" in
  *[!0-9:]*|:*)
    echo "WASIX_PROCESS_TERM_GRACE_MS and WASIX_PROCESS_KILL_GRACE_MS require nonnegative integer milliseconds" >&2
    exit 2
    ;;
esac
export WASIX_PROCESS_TERM_GRACE_MS="$process_term_grace_ms"
export WASIX_PROCESS_KILL_GRACE_MS="$process_kill_grace_ms"
is_positive_number "$resource_sample_interval" || { echo "--resource-interval requires a positive number" >&2; exit 2; }
is_nonnegative_number "$quiescence_seconds" || { echo "--quiescence-seconds requires a non-negative number" >&2; exit 2; }
case "$resource_detail" in
  full|light|off) ;;
  *) echo "--resource-detail requires full, light, or off" >&2; exit 2 ;;
esac
case "$shared_memory_provider" in
  portable-file-v1|linux-tmpfs-v1) ;;
  *)
    echo "--shared-memory-provider requires portable-file-v1 or linux-tmpfs-v1" >&2
    exit 2
    ;;
esac
case "$adaptive_cache_evidence_policy" in
  portable-correctness-v1|constrained-linux-wal-action-v1) ;;
  *)
    echo "--adaptive-cache-evidence-policy requires portable-correctness-v1 or constrained-linux-wal-action-v1" >&2
    exit 2
    ;;
esac
validate_cgroup_size() {
  [[ "$1" =~ ^[0-9]+([KMGTPE]([i]?B)?)?$ ]]
}
cgroup_size_to_bytes() {
  python3 - "$1" <<'PY'
import re
import sys

match = re.fullmatch(r"([0-9]+)([KMGTPE])?(?:i?B)?", sys.argv[1])
if match is None:
    raise SystemExit(2)
value = int(match.group(1))
suffix = match.group(2)
if suffix is not None:
    value *= 1024 ** ("KMGTPE".index(suffix) + 1)
if value > 2**63 - 1:
    raise SystemExit(2)
print(value)
PY
}
for cgroup_size in "$cgroup_memory_max" "$cgroup_memory_high" "$cgroup_swap_max"; do
  if [ -n "$cgroup_size" ] && ! validate_cgroup_size "$cgroup_size"; then
    printf 'invalid cgroup size: %s\n' "$cgroup_size" >&2
    exit 2
  fi
done
validate_unsigned_budget --max-peak-pss-kib "$max_peak_pss_kib"
validate_unsigned_budget --max-peak-pss-anon-kib "$max_peak_pss_anon_kib"
validate_unsigned_budget --max-peak-page-table-kib "$max_peak_page_table_kib"
validate_unsigned_budget --max-cgroup-high-events-delta \
  "$max_cgroup_high_events_delta"
validate_fraction_budget --max-psi-some-stall-fraction \
  "$max_psi_some_stall_fraction"
validate_fraction_budget --max-psi-full-stall-fraction \
  "$max_psi_full_stall_fraction"
memory_budget_requested=0
if [ -n "$max_peak_pss_kib$max_peak_pss_anon_kib$max_peak_page_table_kib$max_cgroup_high_events_delta$max_psi_some_stall_fraction$max_psi_full_stall_fraction" ]; then
  memory_budget_requested=1
fi
cgroup_budget_requested=0
if [ -n "$max_cgroup_high_events_delta$max_psi_some_stall_fraction$max_psi_full_stall_fraction" ]; then
  cgroup_budget_requested=1
fi
if [ "$memory_budget_requested" -eq 1 ] && [ "$resource_detail" != full ]; then
  echo "memory performance budgets require --resource-detail full" >&2
  exit 2
fi
if [ "$cgroup_budget_requested" -eq 1 ] &&
  [ -z "$cgroup_memory_max$cgroup_memory_high$cgroup_swap_max" ]; then
  echo "cgroup event and PSI budgets require a dedicated cgroup memory scope" >&2
  exit 2
fi
if [ -n "$cgroup_memory_max$cgroup_memory_high$cgroup_swap_max" ]; then
  [ "$(uname -s)" = "Linux" ] || {
    echo "cgroup memory controls require Linux" >&2
    exit 2
  }
  command -v systemd-run >/dev/null 2>&1 || {
    echo "cgroup memory controls require systemd-run" >&2
    exit 127
  }
  if [ -z "$cgroup_swap_max" ]; then
    cgroup_swap_max=0
  fi
fi
cgroup_memory_max_bytes=none
cgroup_memory_high_bytes=none
cgroup_swap_max_bytes=none
if [ -n "$cgroup_memory_max" ]; then
  cgroup_memory_max_bytes="$(cgroup_size_to_bytes "$cgroup_memory_max")" || {
    echo "could not canonicalize cgroup MemoryMax" >&2
    exit 2
  }
fi
if [ -n "$cgroup_memory_high" ]; then
  cgroup_memory_high_bytes="$(cgroup_size_to_bytes "$cgroup_memory_high")" || {
    echo "could not canonicalize cgroup MemoryHigh" >&2
    exit 2
  }
fi
if [ -n "$cgroup_swap_max" ]; then
  cgroup_swap_max_bytes="$(cgroup_size_to_bytes "$cgroup_swap_max")" || {
    echo "could not canonicalize cgroup MemorySwapMax" >&2
    exit 2
  }
fi
if [ "$adaptive_cache_evidence_policy" = constrained-linux-wal-action-v1 ]; then
  [ "$(uname -s)" = Linux ] || {
    echo "constrained-linux-wal-action-v1 requires Linux" >&2
    exit 2
  }
  [ -n "$cgroup_memory_max" ] && [ -n "$cgroup_memory_high" ] &&
    [ -n "$cgroup_swap_max" ] || {
      echo "constrained-linux-wal-action-v1 requires explicit finite cgroup MemoryMax, MemoryHigh, and MemorySwapMax" >&2
      exit 2
    }
  if [[ "$cgroup_memory_max" =~ ^0+([KMGTPE]([i]?B)?)?$ ]] ||
    [[ "$cgroup_memory_high" =~ ^0+([KMGTPE]([i]?B)?)?$ ]]; then
    echo "constrained-linux-wal-action-v1 requires positive finite MemoryMax and MemoryHigh" >&2
    exit 2
  fi
fi
case "$checkpoint_policy" in
  default|controlled) ;;
  *) echo "--checkpoint-policy requires default or controlled" >&2; exit 2 ;;
esac
[[ "$libpq_latency_samples" =~ ^(0|[1-9][0-9]*)$ ]] || {
  echo "--libpq-latency-samples requires a nonnegative integer" >&2
  exit 2
}
[[ "$libpq_latency_warmup" =~ ^(0|[1-9][0-9]*)$ ]] || {
  echo "--libpq-latency-warmup requires a nonnegative integer" >&2
  exit 2
}
if ! awk -v samples="$libpq_latency_samples" -v warmup="$libpq_latency_warmup" \
  'BEGIN { exit !((samples + 0) <= 10000000 && (warmup + 0) <= 10000000) }'
then
  echo "libpq latency sample and warmup counts may not exceed 10000000" >&2
  exit 2
fi
if [ "$libpq_latency_only" -eq 1 ]; then
  [ "$libpq_latency_samples" -gt 0 ] || {
    echo "--libpq-latency-only requires --libpq-latency-samples greater than zero" >&2
    exit 2
  }
  [ "$workloads_explicit" -eq 0 ] || {
    echo "--libpq-latency-only cannot be combined with --workload or --workloads" >&2
    exit 2
  }
fi
if [ "$libpq_latency_samples" -gt 0 ] && [ "$resource_detail" != "off" ]; then
  echo "true libpq latency qualification requires --resource-detail off; run FD/PSS sampling as a separate diagnostic" >&2
  exit 2
fi
is_nonnegative_integer "$libpq_latency_host_fd_allowance" || {
  echo "WASIX_LIBPQ_LATENCY_HOST_FD_ALLOWANCE requires a nonnegative integer" >&2
  exit 2
}
is_nonnegative_number "$pg_wait_sample_interval" || { echo "--pg-wait-sample-interval requires a non-negative number" >&2; exit 2; }
is_nonnegative_number "$sample_seconds" || { echo "--sample-seconds requires a non-negative number" >&2; exit 2; }
is_nonnegative_number "$sample_delay" || { echo "--sample-delay requires a non-negative number" >&2; exit 2; }
is_nonnegative_integer "$wasix_wait_dump_interval_ms" || { echo "--wasix-wait-dump-interval-ms requires a non-negative integer" >&2; exit 2; }
is_nonnegative_integer "$wasix_wait_dump_max_per_wait" || { echo "--wasix-wait-dump-max-per-wait requires a non-negative integer" >&2; exit 2; }
is_positive_integer "$wasix_lifecycle_reconnects" || { echo "--wasix-lifecycle-reconnects requires a positive integer" >&2; exit 2; }
is_positive_integer "$wasix_lifecycle_window_seconds" || { echo "--wasix-lifecycle-window-seconds requires a positive integer" >&2; exit 2; }
is_nonnegative_integer "$wasix_lifecycle_memory_checkpoint_every" || {
  echo "--wasix-lifecycle-memory-checkpoint-every requires a non-negative integer" >&2
  exit 2
}
is_positive_number "$wasix_lifecycle_memory_quiescence_seconds" || {
  echo "--wasix-lifecycle-memory-quiescence-seconds requires a positive number" >&2
  exit 2
}
validate_unsigned_budget --max-lifecycle-pss-growth-kib \
  "$max_lifecycle_pss_growth_kib"
validate_unsigned_budget --max-lifecycle-pss-anon-growth-kib \
  "$max_lifecycle_pss_anon_growth_kib"
validate_unsigned_budget --max-lifecycle-heap-growth-kib \
  "$max_lifecycle_heap_growth_kib"
for lifecycle_slope_budget in \
  "$max_late_lifecycle_pss_slope_kib_per_1000" \
  "$max_late_lifecycle_pss_anon_slope_kib_per_1000" \
  "$max_late_lifecycle_heap_slope_kib_per_1000"; do
  [ -z "$lifecycle_slope_budget" ] || \
    is_nonnegative_number "$lifecycle_slope_budget" || {
      echo 'lifecycle late-tail slope ceilings require nonnegative numbers' >&2
      exit 2
    }
done
if ! is_positive_integer "$start_port" || [ "$start_port" -gt 65535 ]; then
  echo "--start-port requires a port number from 1 through 65535" >&2
  exit 2
fi
case "$run_label" in
  ""|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*)
    echo "--label must start with a letter or number and may only contain letters, numbers, '.', '_', and '-'" >&2
    exit 2
    ;;
esac
case "$(printf '%s' "$wasix_perf_stats" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) wasix_perf_stats=1 ;;
  0|false|no|off|"") wasix_perf_stats=0 ;;
  *) echo "WASIX_PERF_STATS must be 0/1, true/false, yes/no, or on/off" >&2; exit 2 ;;
esac
case "$(printf '%s' "$wasix_wait_dump_verbose" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) wasix_wait_dump_verbose=1 ;;
  0|false|no|off) wasix_wait_dump_verbose=0 ;;
  "") wasix_wait_dump_verbose="$wasix_perf_stats" ;;
  *) echo "WASIX_WAIT_DUMP_VERBOSE must be 0/1, true/false, yes/no, or on/off" >&2; exit 2 ;;
esac
case "$(printf '%s' "$wasix_lifecycle_plateau" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) wasix_lifecycle_plateau=1 ;;
  0|false|no|off|"") wasix_lifecycle_plateau=0 ;;
  *) echo "WASIX_LIFECYCLE_PLATEAU must be 0/1, true/false, yes/no, or on/off" >&2; exit 2 ;;
esac
lifecycle_memory_budget_count=0
for lifecycle_memory_budget in "$max_lifecycle_pss_growth_kib" \
  "$max_lifecycle_pss_anon_growth_kib" "$max_lifecycle_heap_growth_kib"; do
  [ -z "$lifecycle_memory_budget" ] || \
    lifecycle_memory_budget_count=$((lifecycle_memory_budget_count + 1))
done
lifecycle_memory_slope_budget_count=0
for lifecycle_slope_budget in \
  "$max_late_lifecycle_pss_slope_kib_per_1000" \
  "$max_late_lifecycle_pss_anon_slope_kib_per_1000" \
  "$max_late_lifecycle_heap_slope_kib_per_1000"; do
  [ -z "$lifecycle_slope_budget" ] || \
    lifecycle_memory_slope_budget_count=$((lifecycle_memory_slope_budget_count + 1))
done
if [ "$wasix_lifecycle_memory_checkpoint_every" -gt 0 ]; then
  [ "$wasix_lifecycle_plateau" -eq 1 ] || {
    echo "--wasix-lifecycle-memory-checkpoint-every requires --wasix-lifecycle-plateau" >&2
    exit 2
  }
  if [ "$(uname -s)" != Linux ] || [ ! -r /proc/self/smaps ] || \
    [ ! -r /proc/self/smaps_rollup ]; then
      echo "lifecycle memory checkpoints require Linux procfs smaps and smaps_rollup" >&2
      exit 2
  fi
  [ "$wasix_lifecycle_memory_checkpoint_every" -lt "$wasix_lifecycle_reconnects" ] || {
    echo "lifecycle memory checkpoint interval must be smaller than reconnect count" >&2
    exit 2
  }
  lifecycle_memory_checkpoint_count=$((
    (wasix_lifecycle_reconnects - 1) /
      wasix_lifecycle_memory_checkpoint_every + 2
  ))
  [ "$lifecycle_memory_checkpoint_count" -ge 5 ] || {
    echo "lifecycle memory plateau requires at least five checkpoints" >&2
    exit 2
  }
  [ "$lifecycle_memory_checkpoint_count" -le 257 ] || {
    echo "lifecycle memory checkpoint schedule is too dense for nonintrusive sampling" >&2
    exit 2
  }
  [ "$lifecycle_memory_budget_count" -eq 3 ] || {
    echo "lifecycle memory checkpoints require all PSS, Pss_Anon, and heap growth ceilings" >&2
    exit 2
  }
  [ "$lifecycle_memory_slope_budget_count" -eq 3 ] || {
    echo "lifecycle memory checkpoints require all PSS, Pss_Anon, and heap late-tail slope ceilings" >&2
    exit 2
  }
  awk -v lifecycle="$wasix_lifecycle_window_seconds" \
    -v memory="$wasix_lifecycle_memory_quiescence_seconds" \
    'BEGIN { exit !(lifecycle >= memory) }' || {
      echo "lifecycle sampling window must be at least the memory quiescence window" >&2
      exit 2
    }
elif [ "$lifecycle_memory_budget_count" -ne 0 ] || \
  [ "$lifecycle_memory_slope_budget_count" -ne 0 ]; then
  echo "lifecycle memory growth ceilings require --wasix-lifecycle-memory-checkpoint-every" >&2
  exit 2
fi
case "$(printf '%s' "$memory_map_snapshots" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) memory_map_snapshots=1 ;;
  0|false|no|off|"") memory_map_snapshots=0 ;;
  *) echo "WASIX_MEMORY_MAP_SNAPSHOTS must be 0/1, true/false, yes/no, or on/off" >&2; exit 2 ;;
esac
case "$(printf '%s' "$cold_ownership" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) cold_ownership=1 ;;
  0|false|no|off|"") cold_ownership=0 ;;
  *) echo "WASIX_COLD_OWNERSHIP must be 0/1, true/false, yes/no, or on/off" >&2; exit 2 ;;
esac
case "$immutable_carrier_verification_scope" in
  full|campaign-fast) ;;
  *)
    echo '--immutable-carrier-verification-scope requires full or campaign-fast' >&2
    exit 2
    ;;
esac

[ "$cold_ownership_workloads" -eq 0 ] || {
  [ "$cold_ownership" -eq 1 ] && [ "$workloads_explicit" -eq 1 ] || {
    echo '--cold-ownership-workloads requires --cold-ownership and explicit --workload(s)' >&2
    exit 2
  }
}

if [ "$cold_ownership" -eq 1 ]; then
  [ "$(uname -s)" = Linux ] || {
    echo "--cold-ownership requires Linux" >&2
    exit 2
  }
  [ -r /sys/fs/cgroup/cgroup.controllers ] || {
    echo "--cold-ownership requires a cgroup-v2 host" >&2
    exit 2
  }
  [ "$resource_detail" = full ] || {
    echo "--cold-ownership requires --resource-detail full" >&2
    exit 2
  }
  [ -n "$cgroup_memory_max" ] && [ -n "$cgroup_memory_high" ] &&
    [ -n "$cgroup_swap_max" ] || {
      echo "--cold-ownership requires explicit cgroup MemoryMax, MemoryHigh, and MemorySwapMax limits" >&2
      exit 2
    }
  [ "$libpq_latency_samples" -eq 0 ] && [ "$libpq_latency_only" -eq 0 ] || {
    echo "--cold-ownership cannot be combined with the separately instrumented libpq latency lane" >&2
    exit 2
  }
  [ "$wasix_lifecycle_plateau" -eq 0 ] || {
    echo "--cold-ownership cannot be combined with lifecycle plateau qualification" >&2
    exit 2
  }
  [ "$workloads_explicit" -eq 0 ] || [ "$cold_ownership_workloads" -eq 1 ] || {
    echo "--cold-ownership is startup-only and cannot be combined with workload selection" >&2
    exit 2
  }
  if awk -v value="$quiescence_seconds" 'BEGIN { exit !((value + 0) > 0) }'; then
    echo "--cold-ownership forbids post-readiness quiescence" >&2
    exit 2
  fi
fi

if [ "$wasix_lifecycle_plateau" -eq 1 ]; then
  [ "$memory_budget_requested" -eq 0 ] || {
    echo "--wasix-lifecycle-plateau cannot be combined with fan-out memory budgets" >&2
    exit 2
  }
  [ "$libpq_latency_samples" -eq 0 ] && [ "$libpq_latency_only" -eq 0 ] || {
    echo "--wasix-lifecycle-plateau is an untimed lane and cannot be combined with libpq latency" >&2
    exit 2
  }
  [ "$workloads_explicit" -eq 0 ] || {
    echo "--wasix-lifecycle-plateau cannot be combined with workload selection" >&2
    exit 2
  }
  [ "$wasix_perf_stats" -eq 0 ] || {
    echo "--wasix-lifecycle-plateau forbids WASIX perf stats" >&2
    exit 2
  }
  if [ "$resource_detail_explicit" -eq 1 ] && [ "$resource_detail" != off ]; then
    echo "--wasix-lifecycle-plateau requires --resource-detail off" >&2
    exit 2
  fi
  resource_detail=off
  wasix_wait_dump_max_per_wait=0
  if [ "$wasix_wait_dump_interval_ms" -eq 0 ]; then
    wasix_wait_dump_interval_ms=100
  fi
  if [ $((wasix_lifecycle_window_seconds * 1000)) -lt $((wasix_wait_dump_interval_ms * 2 + 1000)) ]; then
    echo "--wasix-lifecycle-window-seconds is too short for three snapshots spanning one second at the configured wait-dump interval" >&2
    exit 2
  fi
  if [[ -v WASIX_WAIT_DUMP_FILE ]] || [[ -v WASIX_PERF_WAIT_DUMP_FILE ]] ||
    [[ -v WASIX_WAIT_DUMP_FENCE_REQUEST_FILE ]] ||
    [[ -v WASIX_WAIT_DUMP_FENCE_ACK_FILE ]]; then
    echo "--wasix-lifecycle-plateau owns its wait-dump log, fence-request, and committed-ACK paths; unset ambient wait-dump path variables" >&2
    exit 2
  fi
  # This lane isolates reconnect ownership from legitimate timed-checkpoint
  # state. Checkpoint/recycle behavior is qualified independently; allowing a
  # five-minute checkpoint here makes the terminal tuple depend on run speed.
  checkpoint_policy=controlled
else
  [ "$lifecycle_baseline_policy_explicit" -eq 0 ] || {
    echo "--lifecycle-baseline-policy requires --wasix-lifecycle-plateau" >&2
    exit 2
  }
  if [ "$wasix_wait_dump_cli_config" -eq 1 ] ||
    [ "${#ambient_wait_dump_environment[@]}" -ne 0 ]; then
    printf 'WASIX wait-dump instrumentation is an untimed lifecycle diagnostic only; remove wait-dump options/environment from timed benchmark lanes (found: %s)\n' \
      "${ambient_wait_dump_environment[*]:-command-line option}" >&2
    exit 2
  fi
  # Keep the disabled receipt canonical rather than retaining inert defaults.
  wasix_wait_dump_interval_ms=0
  wasix_wait_dump_max_per_wait=0
  wasix_wait_dump_verbose=0
fi

fresh_postgres_explicit_rows "${postgres_gucs[@]}" >/dev/null || exit
explicit_postgres_guc_names=()
for guc in "${postgres_gucs[@]}"; do
  explicit_postgres_guc_names+=("${guc%%=*}")
done

profile_resolution_active=0
if [ -n "$runtime_footprint$durability_profile" ]; then
  profile_resolution_active=1
  fresh_resolve_postgres_profiles "$runtime_footprint" "$durability_profile" \
    "${postgres_gucs[@]}" || exit
  effective_postgres_gucs=("${FRESH_POSTGRES_PROFILE_GUCS[@]}")
else
  effective_postgres_gucs=("${postgres_gucs[@]}")
fi
for guc in "${postgres_gucs[@]}"; do
  case "$guc" in
    *=*) ;;
    *) printf -- '--postgres-guc requires name=value, got: %s\n' "$guc" >&2; exit 2 ;;
  esac
  if [ "$checkpoint_policy" = "controlled" ]; then
    guc_name="$(printf '%s' "${guc%%=*}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
    case "$guc_name" in
      checkpoint_timeout|max_wal_size|min_wal_size|fsync|synchronous_commit|full_page_writes)
        printf 'controlled checkpoint policy owns PostgreSQL setting %s; remove the conflicting --postgres-guc\n' \
          "$guc_name" >&2
        exit 2
        ;;
    esac
  fi
done
if [ "$checkpoint_policy" = "controlled" ]; then
  effective_postgres_gucs+=(
    checkpoint_timeout=1h
    max_wal_size=8GB
    min_wal_size=1GB
  )
  if [ "$durability_profile" != safe ]; then
    effective_postgres_gucs+=(
      fsync=on
      synchronous_commit=on
      full_page_writes=on
    )
  fi
fi

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

sealed_carrier_root=""
sealed_manifest=""
sealed_receipt=""
sealed_initdb_module=""
sealed_postgres_module=""
sealed_lib_dir=""
sealed_manifest_hash=""
sealed_receipt_hash=""
sealed_payload_inventory=""
sealed_payload_inventory_hash=""
sealed_executor_role=""
sealed_executor_receipt_relative=""
sealed_executor_receipt_hash=""
sealed_executor_hash=""
immutable_carrier_receipt_sha256="none"
immutable_carrier_receipt_dev="none"
immutable_carrier_receipt_ino="none"
immutable_carrier_closure_identity="none"
immutable_carrier_core_profile="none"
immutable_carrier_guest_build_recipe_sha256="none"
immutable_carrier_postgres_module_sha256="none"
sealed_full_identity_captured=0

verify_immutable_carrier_deployment() {
  local receipt_parent receipt_stat receipt_identity

  [ -n "$immutable_carrier_receipt" ] || {
    echo '--require-zero-write-aot requires --immutable-carrier-receipt' >&2
    return 2
  }
  receipt_parent="$(dirname "$immutable_carrier_receipt")"
  [ -d "$receipt_parent" ] && [ ! -L "$receipt_parent" ] || {
    printf 'immutable carrier receipt parent must be a non-symlink directory: %s\n' \
      "$receipt_parent" >&2
    return 2
  }
  immutable_carrier_receipt="$(cd "$receipt_parent" && pwd -P)/$(basename "$immutable_carrier_receipt")"
  [ -f "$immutable_carrier_receipt" ] && [ ! -L "$immutable_carrier_receipt" ] || {
    printf 'immutable carrier receipt must be a regular non-symlink file: %s\n' \
      "$immutable_carrier_receipt" >&2
    return 2
  }
  case "$immutable_carrier_receipt/" in
    "$sealed_carrier_root/"|"$sealed_carrier_root/"*)
      echo 'immutable deployment receipt must remain outside the sealed carrier' >&2
      return 2
      ;;
  esac
  "$FRESH_ROOT/bin/verify-immutable-sealed-carrier.sh" \
    --sealed-carrier "$sealed_carrier_root" \
    --receipt "$immutable_carrier_receipt" --fast || return
  receipt_identity="$(python3 - "$immutable_carrier_receipt" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding="ascii") as stream:
    receipt = json.load(stream)
if receipt.get("schema") != "oliphaunt.wasix-postmaster.immutable-carrier-deployment.v2":
    raise SystemExit("immutable carrier receipt schema differs")
carrier = receipt.get("carrier")
if not isinstance(carrier, dict):
    raise SystemExit("immutable carrier receipt identity differs")
entries = receipt.get("entries")
if not isinstance(entries, list):
    raise SystemExit("immutable carrier receipt entries differ")
postgres_entries = [
    entry for entry in entries
    if isinstance(entry, dict) and entry.get("path") == "bin/postgres"
]
if len(postgres_entries) != 1:
    raise SystemExit("immutable carrier receipt PostgreSQL module differs")
values = (
    carrier.get("closure-identity"),
    carrier.get("manifest-sha256"),
    carrier.get("wasmer-build-receipt-sha256"),
    carrier.get("payload-inventory-sha256"),
    carrier.get("headless-sha256"),
    receipt.get("core_profile"),
    receipt.get("guest_build_recipe_sha256"),
    postgres_entries[0].get("sha256"),
)
if any(not isinstance(value, str) for value in values):
    raise SystemExit("immutable carrier receipt identity value differs")
if any(re.fullmatch(r"[0-9a-f]{64}", value) is None for value in values[:5]):
    raise SystemExit("immutable carrier receipt SHA-256 differs")
if values[5] not in {"release-o3", "safe-o2"}:
    raise SystemExit("immutable carrier receipt core profile differs")
if re.fullmatch(r"[0-9a-f]{64}", values[6]) is None:
    raise SystemExit("immutable carrier receipt guest build recipe differs")
if re.fullmatch(r"[0-9a-f]{64}", values[7]) is None:
    raise SystemExit("immutable carrier receipt PostgreSQL module differs")
print(*values, sep="\t")
PY
  )" || return
  IFS=$'\t' read -r immutable_carrier_closure_identity \
    FRESH_QUALIFICATION_CARRIER_MANIFEST_SHA256 \
    FRESH_QUALIFICATION_CARRIER_RECEIPT_SHA256 \
    FRESH_QUALIFICATION_CARRIER_PAYLOAD_SHA256 \
    FRESH_QUALIFICATION_CARRIER_HEADLESS_SHA256 \
    immutable_carrier_core_profile \
    immutable_carrier_guest_build_recipe_sha256 \
    immutable_carrier_postgres_module_sha256 <<<"$receipt_identity"
  if [ "$immutable_carrier_verification_scope" = full ]; then
    [ "$sealed_full_identity_captured" -eq 1 ] || {
      echo 'full immutable verification scope has no cryptographic carrier capture' >&2
      return 125
    }
    [ "$immutable_carrier_closure_identity" = \
      "$FRESH_QUALIFICATION_CARRIER_CLOSURE_IDENTITY" ] &&
      [ "$immutable_carrier_core_profile" = \
        "$FRESH_QUALIFICATION_CORE_PROFILE" ] &&
      [ "$immutable_carrier_guest_build_recipe_sha256" = \
        "$FRESH_QUALIFICATION_GUEST_BUILD_RECIPE_SHA256" ] || {
      echo 'immutable deployment receipt differs from full carrier verification' >&2
      return 125
    }
  else
    FRESH_QUALIFICATION_CARRIER_CLOSURE_IDENTITY="$immutable_carrier_closure_identity"
    FRESH_QUALIFICATION_CORE_PROFILE="$immutable_carrier_core_profile"
    FRESH_QUALIFICATION_GUEST_BUILD_RECIPE_SHA256="$immutable_carrier_guest_build_recipe_sha256"
  fi
  immutable_carrier_receipt_sha256="$(fresh_wasmer_bin_hash "$immutable_carrier_receipt")" || return
  receipt_stat="$(stat -c '%d %i' -- "$immutable_carrier_receipt")" || return
  read -r immutable_carrier_receipt_dev immutable_carrier_receipt_ino \
    <<<"$receipt_stat"
  [[ "$immutable_carrier_receipt_dev" =~ ^[0-9]+$ ]] &&
    [[ "$immutable_carrier_receipt_ino" =~ ^[0-9]+$ ]] || {
      echo 'immutable carrier receipt device/inode identity is invalid' >&2
      return 125
    }
}

reject_sealed_compiler_configuration() {
  local arg env_name env_value

  if [ "$skip_precompile_explicit" -eq 1 ]; then
    echo "--skip-precompile cannot be combined with --sealed-carrier; sealed mode never precompiles" >&2
    return 2
  fi
  case "$(printf '%s' "$skip_precompile" | tr '[:upper:]' '[:lower:]')" in
    0|false|no|off|"") ;;
    1|true|yes|on)
      echo "WASIX_SKIP_PRECOMPILE cannot be enabled with --sealed-carrier; sealed mode has no compiler cache" >&2
      return 2
      ;;
    *)
      echo "WASIX_SKIP_PRECOMPILE must be 0/1, true/false, yes/no, or on/off" >&2
      return 2
      ;;
  esac

  for env_name in \
    WASMER_BIN \
    WASMER_BUILD_RECEIPT \
    WASMER_COMPILER \
    WASMER_BACKEND \
    WASMER_COMPILER_THREADS \
    WASMER_LLVM_OPT_LEVEL \
    WASMER_LLVM_NATIVE_CPU \
    WASMER_LLVM_FULL_O3_PIPELINE \
    WASMER_LLVM_INDIRECT_CALL_CACHE \
    WASMER_LLVM_VOLATILE_MEMOPS \
    WASMER_DIR \
    WASMER_CACHE_DIR
  do
    env_value="$(printenv "$env_name" 2>/dev/null || true)"
    if [ -n "$env_value" ]; then
      printf '%s is incompatible with --sealed-carrier; the carrier fixes runtime, receipt, compiler, and cache provenance\n' \
        "$env_name" >&2
      return 2
    fi
  done

  for arg in "${wasmer_extra_args[@]}"; do
    case "$arg" in
      --llvm|--llvm=*|--cranelift|--cranelift=*|--singlepass|--singlepass=*|\
      --compiler|--compiler=*|--compiler-threads|--compiler-threads=*|\
      --llvm-opt-level|--llvm-opt-level=*|--llvm-full-o3-pipeline|\
      --llvm-indirect-call-cache|--disable-non-volatile-memops|\
      --enable-verifier|--compiler-debug-dir|--compiler-debug-dir=*|\
      --profiler|--profiler=*|--enable-nan-canonicalization|\
      --wasmer-dir|--wasmer-dir=*|--cache-dir|--cache-dir=*|--disable-cache|\
      --engine|--engine=*|--stack-size|--stack-size=*|--disable-threads|\
      --net|--net=*|\
      --use|--use=*|--include-webc|--include-webc=*|--map-command|--map-command=*|\
      --sealed-module-manifest|--sealed-module-manifest=*)
        printf 'compiler/sealed-loader option cannot be supplied through --wasmer-arg in sealed mode: %s\n' \
          "$arg" >&2
        return 2
        ;;
    esac
  done
}

require_sealed_regular_file() {
  local label="$1"
  local path="$2"

  if [ ! -f "$path" ] || [ -L "$path" ]; then
    printf 'sealed carrier %s must be a regular non-symlink file: %s\n' "$label" "$path" >&2
    return 2
  fi
}

require_sealed_directory() {
  local label="$1"
  local path="$2"

  if [ ! -d "$path" ] || [ -L "$path" ]; then
    printf 'sealed carrier %s must be a non-symlink directory: %s\n' "$label" "$path" >&2
    return 2
  fi
}

validate_sealed_carrier_layout() {
  local carrier="$1"
  local artifact artifact_name symlink_path unexpected_aot_entry
  local artifacts=()

  case "$carrier" in
    *$'\n'*|*$'\r'*|*$'\t'*)
      echo "--sealed-carrier may not contain tabs or newlines" >&2
      return 2
      ;;
  esac
  require_sealed_directory root "$carrier" || return
  sealed_carrier_root="$(cd "$carrier" && pwd -P)"
  if [ "$require_zero_write_aot" -eq 1 ]; then
    if [ "$immutable_carrier_verification_scope" = full ]; then
      fresh_capture_qualification_carrier_identity "$sealed_carrier_root" || return
      sealed_full_identity_captured=1
    fi
  else
    fresh_verify_sealed_headless_carrier "$sealed_carrier_root" || return
  fi

  if ! symlink_path="$(find "$sealed_carrier_root" -type l -print -quit 2>/dev/null)"; then
    printf 'unable to inspect sealed carrier for symlinks: %s\n' "$sealed_carrier_root" >&2
    return 2
  fi
  if [ -n "$symlink_path" ]; then
    printf 'sealed carrier must not contain symlinks: %s\n' "$symlink_path" >&2
    return 2
  fi

  sealed_manifest="$sealed_carrier_root/manifest.json"
  sealed_receipt="$sealed_carrier_root/wasmer-build.receipt"
  sealed_payload_inventory="$sealed_carrier_root/payload.files"
  sealed_initdb_module="$sealed_carrier_root/bin/initdb"
  sealed_postgres_module="$sealed_carrier_root/bin/postgres"
  sealed_lib_dir="$sealed_carrier_root/lib"

  fresh_sealed_executor_selection "$sealed_carrier_root" || return
  sealed_executor_role="$FRESH_SEALED_EXECUTOR_ROLE"
  sealed_executor_receipt_relative="$FRESH_SEALED_EXECUTOR_RECEIPT_RELATIVE"
  sealed_executor_receipt_hash="$FRESH_SEALED_EXECUTOR_RECEIPT_SHA256"
  sealed_executor_hash="$FRESH_SEALED_EXECUTOR_SHA256"
  require_sealed_regular_file selected-executor-receipt \
    "$sealed_carrier_root/$sealed_executor_receipt_relative" || return

  require_sealed_regular_file headless-runtime "$sealed_carrier_root/bin/wasmer-headless" || return
  [ -x "$sealed_carrier_root/bin/wasmer-headless" ] || {
    printf 'sealed carrier headless runtime is not executable: %s\n' \
      "$sealed_carrier_root/bin/wasmer-headless" >&2
    return 2
  }
  require_sealed_regular_file manifest "$sealed_manifest" || return
  require_sealed_regular_file build-receipt "$sealed_receipt" || return
  require_sealed_regular_file initdb-module "$sealed_initdb_module" || return
  require_sealed_regular_file postgres-module "$sealed_postgres_module" || return
  require_sealed_regular_file libpq-module "$sealed_lib_dir/libpq.so.5.18" || return
  require_sealed_regular_file dict-snowball-module "$sealed_lib_dir/postgresql/dict_snowball.so" || return
  require_sealed_regular_file plpgsql-module "$sealed_lib_dir/postgresql/plpgsql.so" || return

  require_sealed_directory postgres-share "$sealed_carrier_root/share/postgresql" || return
  require_sealed_regular_file postgres-bootstrap "$sealed_carrier_root/share/postgresql/postgres.bki" || return
  require_sealed_regular_file postgres-config-sample "$sealed_carrier_root/share/postgresql/postgresql.conf.sample" || return
  require_sealed_regular_file postgres-hba-sample "$sealed_carrier_root/share/postgresql/pg_hba.conf.sample" || return

  require_sealed_directory aot-artifacts "$sealed_carrier_root/aot" || return
  if ! unexpected_aot_entry="$(find "$sealed_carrier_root/aot" -mindepth 1 ! -type f -print -quit 2>/dev/null)"; then
    printf 'unable to inspect sealed carrier AOT directory: %s\n' "$sealed_carrier_root/aot" >&2
    return 2
  fi
  if [ -n "$unexpected_aot_entry" ]; then
    printf 'sealed carrier aot/ may only contain regular artifact files: %s\n' \
      "$unexpected_aot_entry" >&2
    return 2
  fi
  shopt -s nullglob
  artifacts=("$sealed_carrier_root"/aot/*.bin)
  shopt -u nullglob
  if [ "${#artifacts[@]}" -ne 5 ]; then
    printf 'sealed carrier must contain exactly the signed five-module AOT closure; found %s artifacts in %s\n' \
      "${#artifacts[@]}" "$sealed_carrier_root/aot" >&2
    return 2
  fi
  for artifact in "${artifacts[@]}"; do
    require_sealed_regular_file AOT-artifact "$artifact" || return
    artifact_name="$(basename "$artifact")"
    if [[ ! "$artifact_name" =~ ^[0-9A-F]{64}\.bin$ ]]; then
      printf 'sealed carrier AOT artifact name must be an uppercase module SHA-256: %s\n' \
        "$artifact" >&2
      return 2
    fi
  done

  sealed_manifest_hash="$(fresh_wasmer_bin_hash "$sealed_manifest")"
  sealed_receipt_hash="$(fresh_wasmer_bin_hash "$sealed_receipt")"
  sealed_payload_inventory_hash="$(fresh_wasmer_bin_hash "$sealed_payload_inventory")"
  sealed_carrier_core_profile="$(python3 - "$sealed_manifest" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="ascii") as stream:
    manifest = json.load(stream)
profile = manifest.get("core-profile")
if profile not in {"release-o3", "safe-o2"}:
    raise SystemExit("sealed manifest core profile differs")
print(profile)
PY
  )" || return
  # A sealed carrier is the execution authority.  Do not let the ambient
  # source-build default mislabel evidence from its receipt-bound guest/AOT.
  WASIX_CORE_PROFILE="$sealed_carrier_core_profile"
}

require_sealed_output_disjoint() {
  local label="$1"
  local mutable_path="$2"

  case "$mutable_path/" in
    "$sealed_carrier_root/"|"$sealed_carrier_root/"*)
      printf 'sealed carrier overlaps mutable %s output: carrier=%s output=%s\n' \
        "$label" "$sealed_carrier_root" "$mutable_path" >&2
      return 2
      ;;
  esac
  case "$sealed_carrier_root/" in
    "$mutable_path/"|"$mutable_path/"*)
      printf 'sealed carrier is nested inside mutable %s output: carrier=%s output=%s\n' \
        "$label" "$sealed_carrier_root" "$mutable_path" >&2
      return 2
      ;;
  esac
}

if [ "$cold_ownership" -eq 1 ] && [ "$cold_ownership_workloads" -eq 0 ]; then
  workloads=()
elif [ "$wasix_lifecycle_plateau" -eq 1 ]; then
  workloads=()
elif [ "$libpq_latency_only" -eq 1 ]; then
  workloads=()
elif [ "${#workloads[@]}" -eq 0 ]; then
  workloads=("${default_workloads[@]}")
fi
if [ "${#targets[@]}" -eq 0 ]; then
  if [ "$wasix_lifecycle_plateau" -eq 1 ] || [ "$cold_ownership" -eq 1 ]; then
    targets=(wasix)
  else
    targets=(native wasix)
  fi
fi

normalized_workloads=()
seen_values=""
for workload in "${workloads[@]}"; do
  workload="$(normalize_workload "$workload")"
  case " $seen_values " in
    *" $workload "*) printf 'duplicate workload: %s\n' "$workload" >&2; exit 2 ;;
  esac
  seen_values="$seen_values $workload"
  normalized_workloads+=("$workload")
done
workloads=("${normalized_workloads[@]}")

normalized_targets=()
seen_values=""
for target in "${targets[@]}"; do
  target="$(normalize_target "$target")"
  case " $seen_values " in
    *" $target "*) printf 'duplicate target: %s\n' "$target" >&2; exit 2 ;;
  esac
  seen_values="$seen_values $target"
  normalized_targets+=("$target")
done
targets=("${normalized_targets[@]}")
if [ "$wasix_lifecycle_plateau" -eq 1 ] &&
  { [ "${#targets[@]}" -ne 1 ] || [ "${targets[0]}" != wasix ]; }; then
  echo "--wasix-lifecycle-plateau requires exactly --target wasix" >&2
  exit 2
fi
if [ "$cold_ownership" -eq 1 ] &&
  { [ "${#targets[@]}" -ne 1 ] || [ "${targets[0]}" != wasix ]; }; then
  echo "--cold-ownership requires exactly --target wasix" >&2
  exit 2
fi
if [ $((start_port + ${#targets[@]} - 1)) -gt 65535 ]; then
  echo "target ports exceed 65535; choose a lower --start-port" >&2
  exit 2
fi

need_wasix=0
for target in "${targets[@]}"; do
  [ "$target" = "wasix" ] && need_wasix=1
done
if [ "$shared_memory_provider_explicit" -eq 1 ] && [ "$need_wasix" -ne 1 ]; then
  echo "--shared-memory-provider requires the wasix target" >&2
  exit 2
fi
if [ "$shared_memory_provider" = linux-tmpfs-v1 ] &&
  [ "$(uname -s)" != Linux ]; then
  echo "linux-tmpfs-v1 requires Linux" >&2
  exit 2
fi

wasix_runtime_mode="compiler"
if [ -n "$sealed_carrier" ]; then
  [ "$need_wasix" -eq 1 ] || {
    echo "--sealed-carrier requires the wasix target" >&2
    exit 2
  }
  if is_positive_number "$sample_seconds"; then
    echo "--sample-seconds is unavailable with --sealed-carrier; sealed-headless execution does not expose the perfmap profiler" >&2
    exit 2
  fi
  reject_sealed_compiler_configuration
  validate_sealed_carrier_layout "$sealed_carrier"
  wasix_runtime_mode="sealed-headless"
fi
if [ "$require_zero_write_aot" -eq 1 ]; then
  [ "$wasix_runtime_mode" = sealed-headless ] || {
    echo '--require-zero-write-aot requires --sealed-carrier' >&2
    exit 2
  }
  [ "$(uname -s)" = Linux ] || {
    echo '--require-zero-write-aot requires Linux intrinsic immutability evidence' >&2
    exit 2
  }
  [ "$(id -u)" -ne 0 ] || {
    echo '--require-zero-write-aot benchmark execution must be unprivileged' >&2
    exit 2
  }
  cap_eff="$(awk '$1 == "CapEff:" { print $2 }' /proc/self/status)"
  [[ "$cap_eff" =~ ^[0-9a-fA-F]+$ ]] || {
    echo 'could not read exact CapEff for zero-write qualification' >&2
    exit 2
  }
  if (( (16#$cap_eff & (1 << 9)) != 0 )); then
    echo '--require-zero-write-aot refuses a caller with effective CAP_LINUX_IMMUTABLE' >&2
    exit 2
  fi
  verify_immutable_carrier_deployment
elif [ "$immutable_carrier_receipt_explicit" -eq 1 ]; then
  echo '--immutable-carrier-receipt requires --require-zero-write-aot' >&2
  exit 2
fi
if [ "$immutable_carrier_verification_scope" = campaign-fast ] &&
  [ "$require_zero_write_aot" -ne 1 ]; then
  echo '--immutable-carrier-verification-scope campaign-fast requires --require-zero-write-aot' >&2
  exit 2
fi
if [ "$cold_ownership" -eq 1 ] && [ "$wasix_runtime_mode" != sealed-headless ]; then
  echo "--cold-ownership requires --sealed-carrier" >&2
  exit 2
fi
if [ "$adaptive_cache_evidence_policy" = constrained-linux-wal-action-v1 ]; then
  [ "$need_wasix" -eq 1 ] || {
    echo "constrained-linux-wal-action-v1 requires the wasix target" >&2
    exit 2
  }
  [ "$wasix_runtime_mode" = sealed-headless ] || {
    echo "constrained-linux-wal-action-v1 requires --sealed-carrier" >&2
    exit 2
  }
  [ "${#workloads[@]}" -gt 0 ] || {
    echo "constrained-linux-wal-action-v1 requires a workload lane" >&2
    exit 2
  }
fi

fresh_ensure_dirs

if ! command -v perl >/dev/null 2>&1 ||
  ! perl -MTime::HiRes=clock_gettime,CLOCK_MONOTONIC -e 'clock_gettime(CLOCK_MONOTONIC)' \
    >/dev/null 2>&1; then
  echo "benchmark requires Perl Time::HiRes with CLOCK_MONOTONIC" >&2
  exit 127
fi

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

if [ "$need_wasix" -eq 1 ]; then
  if [ "$wasix_runtime_mode" = "compiler" ] &&
    { [ ! -x "$WASIX_INSTALL_DIR/bin/postgres" ] || [ ! -x "$WASIX_INSTALL_DIR/bin/initdb" ]; }; then
    if [ "$skip_build" -eq 1 ]; then
      printf 'missing WASIX install with --skip-build: %s\n' "$WASIX_INSTALL_DIR" >&2
      exit 2
    fi
    "$FRESH_ROOT/bin/build-wasix-core.sh" >/dev/null
  fi
fi

libpq_latency_probe_bin=""
libpq_latency_probe_sha256=""
libpq_latency_probe_source_sha256=""
libpq_latency_compiler=""
libpq_latency_libpq_path=""
libpq_latency_libpq_sha256=""

build_libpq_latency_probe() {
  local output="$1"
  local source="$FRESH_ROOT/probes/libpq_latency_probe.c"
  local pg_config="$NATIVE_INSTALL_DIR/bin/pg_config"
  local cc_bin="${CC:-cc}"
  local include_dir lib_dir pending linker_lib canonical_lib linked_lib linked_canonical
  local host_os

  command -v "$cc_bin" >/dev/null 2>&1 || {
    printf 'libpq latency lane requires a C compiler executable: %s\n' "$cc_bin" >&2
    return 127
  }
  [ -x "$pg_config" ] || {
    printf 'libpq latency lane requires native pg_config: %s\n' "$pg_config" >&2
    return 2
  }
  if [ ! -f "$source" ] || [ -L "$source" ]; then
    printf 'libpq latency probe source must be a regular non-symlink file: %s\n' "$source" >&2
    return 2
  fi
  include_dir="$($pg_config --includedir)"
  lib_dir="$($pg_config --libdir)"
  [ -f "$include_dir/libpq-fe.h" ] || {
    printf 'native libpq header is missing: %s\n' "$include_dir/libpq-fe.h" >&2
    return 2
  }
  [ -d "$lib_dir" ] || {
    printf 'native libpq directory is missing: %s\n' "$lib_dir" >&2
    return 2
  }
  case "$include_dir$lib_dir$output" in
    *$'\t'*|*$'\n'*|*$'\r'*)
      echo "libpq latency build paths may not contain tabs or newlines" >&2
      return 2
      ;;
  esac

  host_os="$(uname -s)"
  case "$host_os" in
    Linux) linker_lib="$lib_dir/libpq.so" ;;
    Darwin) linker_lib="$lib_dir/libpq.dylib" ;;
    *)
      printf 'libpq latency shared-library provenance is unsupported on host: %s\n' "$host_os" >&2
      return 2
      ;;
  esac
  [ -e "$linker_lib" ] || {
    printf 'native libpq linker library is missing: %s\n' "$linker_lib" >&2
    return 2
  }
  if ! canonical_lib="$(perl -MCwd=abs_path -e '
    my $path = abs_path($ARGV[0]);
    exit 1 unless defined($path);
    print $path;
  ' "$linker_lib")"
  then
    printf 'could not canonicalize native libpq linker library: %s\n' "$linker_lib" >&2
    return 2
  fi
  if [ ! -f "$canonical_lib" ] || [ -L "$canonical_lib" ]; then
    printf 'native libpq canonical library is not a regular file: %s\n' "$canonical_lib" >&2
    return 2
  fi

  pending="$(mktemp "$(dirname "$output")/.libpq-latency-probe.XXXXXX")"
  if ! "$cc_bin" -std=c11 -O2 -g0 -Wall -Wextra -Werror -Wpedantic \
    -Wconversion -Wshadow -I"$include_dir" "$source" \
    -L"$lib_dir" "-Wl,-rpath,$lib_dir" -lpq -o "$pending"
  then
    rm -f -- "$pending"
    return 1
  fi
  chmod 0755 "$pending"
  if [ "$host_os" = "Linux" ]; then
    command -v ldd >/dev/null 2>&1 || {
      rm -f -- "$pending"
      echo "libpq latency provenance verification requires ldd on Linux" >&2
      return 127
    }
    linked_lib="$(env -u LD_LIBRARY_PATH -u LD_PRELOAD -u LD_AUDIT \
      ldd "$pending" | awk '$1 ~ /^libpq[.]so/ && $2 == "=>" { print $3 }')"
    case "$linked_lib" in
      ""|*$'\n'*)
        rm -f -- "$pending"
        echo "could not resolve one exact libpq dependency for latency probe" >&2
        return 2
        ;;
    esac
    if ! linked_canonical="$(perl -MCwd=abs_path -e '
      my $path = abs_path($ARGV[0]);
      exit 1 unless defined($path);
      print $path;
    ' "$linked_lib")"
    then
      rm -f -- "$pending"
      printf 'could not canonicalize linked libpq dependency: %s\n' "$linked_lib" >&2
      return 2
    fi
    if [ "$linked_canonical" != "$canonical_lib" ]; then
      rm -f -- "$pending"
      printf 'latency probe resolved unexpected libpq: expected=%s actual=%s\n' \
        "$canonical_lib" "$linked_canonical" >&2
      return 2
    fi
  elif [ "$host_os" = "Darwin" ]; then
    command -v otool >/dev/null 2>&1 || {
      rm -f -- "$pending"
      echo "libpq latency provenance verification requires otool on macOS" >&2
      return 127
    }
    linked_lib="$(otool -L "$pending" | awk 'NR > 1 && $1 ~ /libpq/ { print $1 }')"
    case "$linked_lib" in
      ""|*$'\n'*)
        rm -f -- "$pending"
        echo "could not resolve one exact libpq dependency for latency probe" >&2
        return 2
        ;;
      @rpath/*) linked_lib="$lib_dir/${linked_lib##*/}" ;;
    esac
    if ! linked_canonical="$(perl -MCwd=abs_path -e '
      my $path = abs_path($ARGV[0]);
      exit 1 unless defined($path);
      print $path;
    ' "$linked_lib")"
    then
      rm -f -- "$pending"
      printf 'could not canonicalize linked libpq dependency: %s\n' "$linked_lib" >&2
      return 2
    fi
    if [ "$linked_canonical" != "$canonical_lib" ]; then
      rm -f -- "$pending"
      printf 'latency probe resolved unexpected libpq: expected=%s actual=%s\n' \
        "$canonical_lib" "$linked_canonical" >&2
      return 2
    fi
  fi
  mv "$pending" "$output"
  libpq_latency_probe_bin="$output"
  libpq_latency_probe_sha256="$(fresh_wasmer_bin_hash "$output")"
  libpq_latency_probe_source_sha256="$(fresh_wasmer_bin_hash "$source")"
  libpq_latency_compiler="$($cc_bin --version 2>/dev/null | awk 'NR == 1 { print }')"
  libpq_latency_libpq_path="$canonical_lib"
  libpq_latency_libpq_sha256="$(fresh_wasmer_bin_hash "$canonical_lib")"
}

now_ms() {
  perl -MTime::HiRes=clock_gettime,CLOCK_MONOTONIC \
    -e 'printf "%.0f\n", clock_gettime(CLOCK_MONOTONIC) * 1000'
}

now_ns() {
  perl -MTime::HiRes=clock_gettime,CLOCK_MONOTONIC \
    -e 'printf "%.0f\n", clock_gettime(CLOCK_MONOTONIC) * 1000000000'
}

new_lifecycle_nonce() {
  local nonce

  nonce="$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d '[:space:]')"
  if [[ "$nonce" =~ ^[0-9a-f]{32}$ ]]; then
    printf '%s\n' "$nonce"
    return 0
  fi
  echo "could not create a 128-bit lifecycle evidence nonce" >&2
  return 1
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

  fresh_run_process_group_timeout "$timeout" -- "$@" >"$log" 2>&1
}

collect_linux_process_tree() (
  local root_pid="$1"
  local proc_root="$2"
  local pid task_dir children_file children child
  local queue_index=0
  local -a queue task_dirs
  local -A discovered queued

  case "$root_pid" in
    ''|0|0*|*[!0-9]*) return 2 ;;
  esac
  case "$proc_root" in
    /*) ;;
    *) return 2 ;;
  esac

  # Linux exposes each task's immediate children directly.  Walking those
  # files is O(the measured tree), unlike `ps -axo`, whose two full-system
  # scans made one nominal 100 ms sample take seconds on a busy host.  Scan
  # every thread because a child belongs to the specific task that created it.
  shopt -s nullglob
  queue=("$root_pid")
  queued["$root_pid"]=1
  while [ "$queue_index" -lt "${#queue[@]}" ]; do
    pid="${queue[$queue_index]}"
    queue_index=$((queue_index + 1))
    [ -z "${discovered[$pid]+x}" ] || continue
    discovered["$pid"]=1
    if [ ! -d "$proc_root/$pid" ]; then
      [ "$pid" != "$root_pid" ] || return 1
      continue
    fi
    printf '%s\n' "$pid"
    task_dirs=("$proc_root/$pid/task/"[0-9]*)
    [ "${#task_dirs[@]}" -gt 0 ] || return 1
    for task_dir in "${task_dirs[@]}"; do
      children_file="$task_dir/children"
      if [ ! -r "$children_file" ]; then
        # A non-leader thread can exit between glob expansion and the read.
        [ ! -d "$task_dir" ] && continue
        return 1
      fi
      children="$(<"$children_file")" || return 1
      for child in $children; do
        case "$child" in
          ''|0|0*|*[!0-9]*) return 1 ;;
        esac
        if [ -z "${queued[$child]+x}" ]; then
          queue+=("$child")
          queued["$child"]=1
        fi
      done
    done
  done
)

collect_process_tree() {
  local root_pid="$1"

  if [ -r "/proc/$root_pid/task/$root_pid/children" ]; then
    collect_linux_process_tree "$root_pid" /proc
    return
  fi
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

collect_cgroup_process_set() {
  local root_pid="$1"
  local cgroup_dir="$2"
  local pid
  local root_seen=0
  local -A seen

  case "$root_pid" in
    ''|0|0*|*[!0-9]*) return 2 ;;
  esac
  case "$cgroup_dir" in
    /*) ;;
    *) return 2 ;;
  esac
  [ -d "$cgroup_dir" ] && [ -r "$cgroup_dir/cgroup.procs" ] || return 1
  while IFS= read -r pid; do
    case "$pid" in
      ''|0|0*|*[!0-9]*) return 1 ;;
    esac
    [ -z "${seen[$pid]+x}" ] || return 1
    seen["$pid"]=1
    [ "$pid" != "$root_pid" ] || root_seen=1
    printf '%s\n' "$pid"
  done <"$cgroup_dir/cgroup.procs"
  [ "$root_seen" -eq 1 ]
}

collect_process_tree_snapshot() {
  local root_pid="$1"
  local cgroup_dir="${2:-}"
  local pid identity
  local failed=0
  local process_tree

  if [ -n "$cgroup_dir" ]; then
    # The benchmark-created transient scope contains only the measured server
    # tree.  Its cgroup.procs file is both stronger and O(scope), avoiding the
    # kernel-documented sibling-omission race in procfs `children` during exit.
    process_tree="$(collect_cgroup_process_set "$root_pid" "$cgroup_dir")" || return 1
  else
    process_tree="$(collect_process_tree "$root_pid")" || return 1
  fi
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    identity="$(fresh_process_birth_identity "$pid" 2>/dev/null || true)"
    if [ -z "$identity" ]; then
      failed=1
      continue
    fi
    printf '%s\t%s\n' "$pid" "$identity"
  done < <(printf '%s\n' "$process_tree" | sort -n)
  [ "$failed" -eq 0 ]
}

collect_linux_smaps_rollup() {
  local pids="$1"
  local pid rollup

  [ -d /proc ] || {
    printf '0\t0\t0\t0\t0\t0\t0\t0\t0\t0\t0\t0\t0\n'
    return
  }

  {
    for pid in $pids; do
      rollup="/proc/$pid/smaps_rollup"
      [ -r "$rollup" ] || continue
      awk '
        /^Pss:[[:space:]]/ { pss = $2 }
        /^Pss_Anon:[[:space:]]/ { pss_anon = $2 }
        /^Pss_File:[[:space:]]/ { pss_file = $2 }
        /^Pss_Shmem:[[:space:]]/ { pss_shmem = $2 }
        /^Private_Clean:[[:space:]]/ { private_clean += $2; private += $2 }
        /^Private_Dirty:[[:space:]]/ { private_dirty += $2; private += $2 }
        /^Private_Hugetlb:[[:space:]]/ { private += $2 }
        /^Shared_Clean:[[:space:]]/ { shared += $2 }
        /^Shared_Dirty:[[:space:]]/ { shared += $2 }
        /^Shared_Hugetlb:[[:space:]]/ { shared += $2 }
        /^Anonymous:[[:space:]]/ { anonymous = $2 }
        /^Swap:[[:space:]]/ { swap = $2 }
        /^Threads:[[:space:]]/ { threads = $2 }
        /^VmPTE:[[:space:]]/ { vm_pte = $2 }
        END {
          printf "%.0f\t%.0f\t%.0f\t%.0f\t%.0f\t%.0f\t%.0f\t%.0f\t1\t%.0f\t%.0f\t%.0f\t%.0f\n",
            pss,
            pss_anon,
            pss_file,
            pss_shmem,
            private,
            shared,
            anonymous,
            swap,
            threads,
            vm_pte,
            private_clean,
            private_dirty
        }
      ' "$rollup" "/proc/$pid/status" 2>/dev/null || true
    done
  } | awk -F '\t' '
    {
      pss += $1
      pss_anon += $2
      pss_file += $3
      pss_shmem += $4
      private += $5
      shared += $6
      anonymous += $7
      swap += $8
      processes += $9
      threads += $10
      vm_pte += $11
      private_clean += $12
      private_dirty += $13
    }
    END {
      printf "%.0f\t%.0f\t%.0f\t%.0f\t%.0f\t%.0f\t%.0f\t%.0f\t%d\t%d\t%.0f\t%.0f\t%.0f\n",
        pss,
        pss_anon,
        pss_file,
        pss_shmem,
        private,
        shared,
        anonymous,
        swap,
        processes,
        threads,
        vm_pte,
        private_clean,
        private_dirty
    }
  '
}

set_resource_phase() {
  local phase_file="$1"
  local phase="$2"
  printf '%s\n' "$phase" >"$phase_file" 2>/dev/null || true
}

print_empty_linux_cgroup_metrics() {
  local column

  for ((column = 1; column < 34; column++)); do
    printf '\t'
  done
  printf '\n'
}

cgroup_read_value=""
read_optional_cgroup_numeric() {
  local path="$1"
  local label="$2"
  local value=""

  cgroup_read_value=""
  [ -r "$path" ] || return 0
  if ! value="$(<"$path")"; then
    # A transient scope can disappear between the readability check and read.
    [ ! -e "$path" ] && return 0
    printf 'unable to read cgroup %s: %s\n' "$label" "$path" >&2
    return 1
  fi
  case "$value" in
    ""|*[!0-9]*)
      printf 'malformed cgroup %s (expected an unsigned integer): %s\n' \
        "$label" "$path" >&2
      return 1
      ;;
  esac
  cgroup_read_value="$value"
}

cgroup_read_limit=""
read_optional_cgroup_limit() {
  local path="$1"
  local label="$2"
  local value=""

  cgroup_read_limit=""
  [ -r "$path" ] || return 0
  if ! value="$(<"$path")"; then
    [ ! -e "$path" ] && return 0
    printf 'unable to read cgroup %s: %s\n' "$label" "$path" >&2
    return 1
  fi
  case "$value" in
    max) ;;
    ""|*[!0-9]*)
      printf 'malformed cgroup %s (expected an unsigned integer or max): %s\n' \
        "$label" "$path" >&2
      return 1
      ;;
  esac
  cgroup_read_limit="$value"
}

parse_cgroup_memory_stat() {
  awk '
    BEGIN {
      required["anon"] = 1
      required["file"] = 1
      required["shmem"] = 1
      required["kernel"] = 1
      required["pagetables"] = 1
      required["slab"] = 1
      required["file_dirty"] = 1
      required["file_writeback"] = 1
    }
    $1 in required {
      if (NF != 2 || $2 !~ /^[0-9]+$/ || seen[$1]++) {
        malformed = 1
      } else {
        value[$1] = $2
      }
    }
    END {
      for (key in required) {
        if (!seen[key]) {
          malformed = 1
        }
      }
      if (malformed) {
        exit 1
      }
      printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
        value["anon"],
        value["file"],
        value["shmem"],
        value["kernel"],
        value["pagetables"],
        value["slab"],
        value["file_dirty"],
        value["file_writeback"]
    }
  '
}

parse_cgroup_memory_stat_file_cache() {
  # These are exact memory.stat keys. In particular, pgscan and pgsteal are
  # already aggregate counters; their overlapping component keys must not be
  # summed into them. Kernel/configuration-dependent absence remains explicit.
  awk '
    BEGIN {
      requested[1] = "active_file"
      requested[2] = "inactive_file"
      requested[3] = "file_mapped"
      requested[4] = "workingset_refault_file"
      requested[5] = "workingset_activate_file"
      requested[6] = "workingset_restore_file"
      requested[7] = "pgscan"
      requested[8] = "pgsteal"
      for (i = 1; i <= 8; i++) selected[requested[i]] = 1
    }
    $1 in selected {
      if (NF != 2 || $2 !~ /^[0-9]+$/ || seen[$1]++) {
        malformed = 1
      } else {
        value[$1] = $2
      }
    }
    END {
      if (malformed) exit 1
      for (i = 1; i <= 8; i++) {
        key = requested[i]
        if (i > 1) printf "\t"
        if (seen[key]) {
          printf "%s", value[key]
        } else {
          if (missing != "") missing = missing ","
          missing = missing key
        }
      }
      printf "\t%s\t%s\n", (missing == "" ? "complete" : "partial"),
        (missing == "" ? "none" : missing)
    }
  '
}

cgroup_has_child_cgroup() {
  local root="$1"
  local entry

  for entry in "$root"/*; do
    [ -d "$entry" ] || continue
    return 0
  done
  return 1
}

parse_cgroup_memory_pressure() {
  awk '
    $1 == "some" || $1 == "full" {
      kind = $1
      if (seen[kind]++) {
        malformed = 1
      }
      found_total = 0
      for (i = 2; i <= NF; i++) {
        part_count = split($i, part, "=")
        if (part[1] == "total") {
          if (found_total || part_count != 2 || part[2] !~ /^[0-9]+$/) {
            malformed = 1
          } else {
            total[kind] = part[2]
            found_total = 1
          }
        }
      }
      if (!found_total) {
        malformed = 1
      }
    }
    END {
      if (!seen["some"] || !seen["full"] || malformed) {
        exit 1
      }
      printf "%s\t%s\n", total["some"], total["full"]
    }
  '
}

parse_cgroup_memory_events() {
  awk '
    BEGIN {
      required["high"] = 1
      required["max"] = 1
      required["oom"] = 1
      required["oom_kill"] = 1
    }
    $1 in required {
      if (NF != 2 || $2 !~ /^[0-9]+$/ || seen[$1]++) {
        malformed = 1
      } else {
        value[$1] = $2
      }
    }
    END {
      for (key in required) {
        if (!seen[key]) {
          malformed = 1
        }
      }
      if (malformed) {
        exit 1
      }
      printf "%s\t%s\t%s\t%s\n",
        value["high"], value["max"], value["oom"], value["oom_kill"]
    }
  '
}

collect_linux_cgroup_metrics() {
  local root_pid="$1"
  local cgroup_relative cgroup_dir
  local memory_current="" memory_peak="" swap_current="" swap_peak="" pids_current=""
  local event_high="" event_max="" event_oom="" event_oom_kill="" events event_metrics
  local memory_events_path="" memory_events_source=""
  local memory_max="" memory_high="" swap_max=""
  local memory_stat="" memory_stat_metrics memory_stat_file_cache_metrics
  local memory_pressure="" memory_pressure_metrics

  event_metrics="$(printf '\t\t\t')"
  memory_stat_metrics="$(printf '\t\t\t\t\t\t\t')"
  memory_stat_file_cache_metrics="$(printf '\t\t\t\t\t\t\t\tpartial\tactive_file,inactive_file,file_mapped,workingset_refault_file,workingset_activate_file,workingset_restore_file,pgscan,pgsteal')"
  memory_pressure_metrics="$(printf '\t')"

  if [ -z "$cgroup_memory_max$cgroup_memory_high$cgroup_swap_max" ] ||
    [ ! -r "/proc/$root_pid/cgroup" ]; then
    print_empty_linux_cgroup_metrics
    return
  fi
  cgroup_relative="$(awk -F: '$1 == "0" { print $3; exit }' "/proc/$root_pid/cgroup")"
  if [ -z "$cgroup_relative" ]; then
    [ ! -e "/proc/$root_pid/cgroup" ] && {
      print_empty_linux_cgroup_metrics
      return
    }
    printf 'malformed cgroup-v2 membership for pid %s: %s\n' \
      "$root_pid" "/proc/$root_pid/cgroup" >&2
    return 1
  fi
  case "$cgroup_relative" in
    /*) ;;
    *)
      printf 'unsafe cgroup-v2 relative path for pid %s: %s\n' \
        "$root_pid" "$cgroup_relative" >&2
      return 1
      ;;
  esac
  cgroup_dir="/sys/fs/cgroup$cgroup_relative"
  [ -d "$cgroup_dir" ] || {
    print_empty_linux_cgroup_metrics
    return
  }
  read_optional_cgroup_numeric "$cgroup_dir/memory.current" memory.current || return
  memory_current="$cgroup_read_value"
  read_optional_cgroup_numeric "$cgroup_dir/memory.peak" memory.peak || return
  memory_peak="$cgroup_read_value"
  read_optional_cgroup_numeric "$cgroup_dir/memory.swap.current" memory.swap.current || return
  swap_current="$cgroup_read_value"
  read_optional_cgroup_numeric "$cgroup_dir/memory.swap.peak" memory.swap.peak || return
  swap_peak="$cgroup_read_value"
  read_optional_cgroup_numeric "$cgroup_dir/pids.current" pids.current || return
  pids_current="$cgroup_read_value"
  read_optional_cgroup_limit "$cgroup_dir/memory.max" memory.max || return
  memory_max="$cgroup_read_limit"
  read_optional_cgroup_limit "$cgroup_dir/memory.high" memory.high || return
  memory_high="$cgroup_read_limit"
  read_optional_cgroup_limit "$cgroup_dir/memory.swap.max" memory.swap.max || return
  swap_max="$cgroup_read_limit"
  memory_events_path="$cgroup_dir/memory.events"
  memory_events_source="memory.events"
  if ! cgroup_has_child_cgroup "$cgroup_dir" &&
    [ -e "$cgroup_dir/memory.events.local" ]; then
    memory_events_path="$cgroup_dir/memory.events.local"
    memory_events_source="memory.events.local"
  fi
  if [ -r "$memory_events_path" ]; then
    events="$(<"$memory_events_path")"
    if ! event_metrics="$(printf '%s\n' "$events" | parse_cgroup_memory_events)"; then
      [ ! -e "$memory_events_path" ] || {
        printf 'malformed cgroup memory events: %s\n' "$memory_events_path" >&2
        return 1
      }
      event_metrics="$(printf '\t\t\t')"
    fi
    IFS=$'\t' read -r event_high event_max event_oom event_oom_kill <<<"$event_metrics"
  fi
  if [ -r "$cgroup_dir/memory.stat" ]; then
    memory_stat="$(<"$cgroup_dir/memory.stat")"
    if ! memory_stat_metrics="$(printf '%s\n' "$memory_stat" | parse_cgroup_memory_stat)"; then
      [ ! -e "$cgroup_dir/memory.stat" ] || {
        printf 'malformed cgroup memory.stat: %s\n' "$cgroup_dir/memory.stat" >&2
        return 1
      }
      memory_stat_metrics="$(printf '\t\t\t\t\t\t\t')"
    fi
    if ! memory_stat_file_cache_metrics="$(
      printf '%s\n' "$memory_stat" | parse_cgroup_memory_stat_file_cache
    )"; then
      [ ! -e "$cgroup_dir/memory.stat" ] || {
        printf 'malformed cgroup memory.stat file-cache fields: %s\n' \
          "$cgroup_dir/memory.stat" >&2
        return 1
      }
      memory_stat_file_cache_metrics="$(printf '\t\t\t\t\t\t\t\tpartial\tactive_file,inactive_file,file_mapped,workingset_refault_file,workingset_activate_file,workingset_restore_file,pgscan,pgsteal')"
    fi
  fi
  if [ -r "$cgroup_dir/memory.pressure" ]; then
    memory_pressure="$(<"$cgroup_dir/memory.pressure")"
    if ! memory_pressure_metrics="$(printf '%s\n' "$memory_pressure" | parse_cgroup_memory_pressure)"; then
      [ ! -e "$cgroup_dir/memory.pressure" ] || {
        printf 'malformed cgroup memory.pressure: %s\n' "$cgroup_dir/memory.pressure" >&2
        return 1
      }
      memory_pressure_metrics="$(printf '\t')"
    fi
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$cgroup_relative" "$memory_current" "$memory_peak" "$swap_current" "$swap_peak" \
    "$pids_current" "${event_high:-}" "${event_max:-}" "${event_oom:-}" \
    "${event_oom_kill:-}" "$memory_max" "$memory_high" "$swap_max" \
    "$memory_stat_metrics" "$memory_pressure_metrics" \
    "$memory_stat_file_cache_metrics" "$memory_events_source"
}

monitor_resource_usage() {
  local target="$1"
  local root_pid="$2"
  local phase_file="$3"
  local stop_file="$4"
  local samples_tsv="$5"
  local interval="$6"
  local detail="$7"
  local server_cgroup_dir="${8:-}"
  local now phase phase_after pids pid_csv metrics cgroup_metrics_all cgroup_metrics
  local cgroup_file_cache_metrics host_fd_metrics
  local host_kernel snapshot_before snapshot_after tree_status expected_processes
  local observed_smaps smaps_status cgroup_status empty_smaps empty_cgroup
  local empty_cgroup_file_cache
  local process_tree_race_retries=0
  local process_tree_race_retry_limit=3
  local phase_transition_retries=0
  local phase_transition_retry_limit=3

  host_kernel="$(uname -s 2>/dev/null || printf 'unknown')"
  empty_smaps="$(printf '\t\t\t\t\t\t\t\t\t\t\t\t')"
  empty_cgroup="$(printf '\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t')"
  empty_cgroup_file_cache="$(printf '\t\t\t\t\t\t\t\t\t\t')"
  printf 'monotonic_ms\ttarget\tphase\troot_pid\tprocess_count\trss_kb_total\tvsz_kb_total\tcpu_percent_total\tmax_rss_kb_per_pid\tpids\tpss_kb_total\tpss_anon_kb_total\tpss_file_kb_total\tpss_shmem_kb_total\tprivate_kb_total\tshared_mapped_kb_total\tanonymous_mapped_kb_total\tswap_kb_total\tsmaps_process_count\thost_thread_count_total\tpage_table_kb_total\tprivate_clean_kb_total\tprivate_dirty_kb_total\tcgroup_path\tcgroup_memory_current_bytes\tcgroup_scope_memory_peak_bytes\tcgroup_swap_current_bytes\tcgroup_scope_swap_peak_bytes\tcgroup_pids_current\tcgroup_scope_event_high_total\tcgroup_scope_event_max_total\tcgroup_scope_event_oom_total\tcgroup_scope_event_oom_kill_total\tcgroup_memory_max\tcgroup_memory_high\tcgroup_swap_max\tcgroup_memory_stat_anon_bytes\tcgroup_memory_stat_file_bytes\tcgroup_memory_stat_shmem_bytes\tcgroup_memory_stat_kernel_bytes\tcgroup_memory_stat_pagetables_bytes\tcgroup_memory_stat_slab_bytes\tcgroup_memory_stat_file_dirty_bytes\tcgroup_memory_stat_file_writeback_bytes\tcgroup_memory_pressure_some_total_usec\tcgroup_memory_pressure_full_total_usec\thost_open_fd_count_total\thost_open_fd_observed_process_count\thost_open_fd_expected_process_count\thost_open_fd_status\tsmaps_expected_process_count\tsmaps_observed_process_count\tsmaps_status\tcgroup_status\tcgroup_memory_stat_active_file_bytes\tcgroup_memory_stat_inactive_file_bytes\tcgroup_memory_stat_file_mapped_bytes\tcgroup_memory_stat_workingset_refault_file_pages_total\tcgroup_memory_stat_workingset_activate_file_pages_total\tcgroup_memory_stat_workingset_restore_file_pages_total\tcgroup_memory_stat_pgscan_pages_total\tcgroup_memory_stat_pgsteal_pages_total\tcgroup_memory_stat_file_cache_status\tcgroup_memory_stat_file_cache_missing_keys\tcgroup_memory_events_source\tprocess_tree_status\n' >"$samples_tsv"
  while :; do
    now="$(now_ms)"
    phase="$(tr -d '[:space:]' <"$phase_file" 2>/dev/null || true)"
    [ -n "$phase" ] || phase="unknown"
    tree_status="ok"
    snapshot_before=""
    if ! snapshot_before="$(collect_process_tree_snapshot "$root_pid" "$server_cgroup_dir")"; then
      tree_status="raced"
    fi
    pids="$(printf '%s\n' "$snapshot_before" | awk -F '\t' 'NF >= 2 { print $1 }' | tr '\n' ' ')"
    expected_processes="$(printf '%s\n' "$snapshot_before" | awk -F '\t' 'NF >= 2 { count++ } END { print count + 0 }')"
    if [ -n "$pids" ]; then
      if ! cgroup_metrics_all="$(collect_linux_cgroup_metrics "$root_pid")"; then
        return 1
      fi
      if ! host_fd_metrics="$(fresh_collect_host_fd_occupancy "$host_kernel" /proc "$pids")"; then
        return 1
      fi
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
      if [ "$(printf '%s\n' "$metrics" | awk -F '\t' '{ print $1 }')" != "$expected_processes" ]; then
        tree_status="raced"
      fi
      if [ "$detail" = "full" ]; then
        smaps_metrics="$(collect_linux_smaps_rollup "$pids")"
        observed_smaps="$(printf '%s\n' "$smaps_metrics" | awk -F '\t' '{ print $9 }')"
        smaps_status="ok"
      else
        smaps_metrics="$empty_smaps"
        observed_smaps=0
        smaps_status="disabled"
      fi
      snapshot_after=""
      if ! snapshot_after="$(collect_process_tree_snapshot "$root_pid" "$server_cgroup_dir")" ||
        [ "$snapshot_before" != "$snapshot_after" ]; then
        tree_status="raced"
      fi
      phase_after="$(tr -d '[:space:]' <"$phase_file" 2>/dev/null || true)"
      [ -n "$phase_after" ] || phase_after="unknown"
      if [ "$phase_after" != "$phase" ]; then
        if [ "$phase_transition_retries" -lt "$phase_transition_retry_limit" ]; then
          phase_transition_retries=$((phase_transition_retries + 1))
          printf 'resource sample phase changed during capture; retry=%s/%s target=%s from=%s to=%s\n' \
            "$phase_transition_retries" "$phase_transition_retry_limit" \
            "$target" "$phase" "$phase_after" >&2
          continue
        fi
        printf 'resource sample phase remained unstable after %s retries; target=%s from=%s to=%s\n' \
          "$phase_transition_retry_limit" "$target" "$phase" \
          "$phase_after" >&2
        return 1
      fi
      if [ "$tree_status" != "ok" ] &&
        [ "$process_tree_race_retries" -lt "$process_tree_race_retry_limit" ]; then
        process_tree_race_retries=$((process_tree_race_retries + 1))
        printf 'resource sample process-tree race; retry=%s/%s target=%s phase=%s\n' \
          "$process_tree_race_retries" "$process_tree_race_retry_limit" \
          "$target" "$phase" >&2
        # A native PostgreSQL backend may enter or exit between the two tree
        # snapshots.  Discard every metric from that non-atomic attempt and
        # retry immediately; only a stable capture, or an explicitly exhausted
        # bounded retry, is eligible for a samples.tsv row.
        continue
      fi
      process_tree_race_retries=0
      if [ "$tree_status" != "ok" ]; then
        smaps_status="raced"
        smaps_metrics="$empty_smaps"
        host_fd_metrics="$(printf '\t0\t%s\traced' "$expected_processes")"
        metrics=$'0\t0\t0\t0.0\t0'
        pids=""
      elif [ "$detail" = "full" ]; then
        if [ "$host_kernel" != "Linux" ] || [ ! -d /proc ]; then
          smaps_status="unsupported"
        elif [ "$observed_smaps" != "$expected_processes" ]; then
          smaps_status="unreadable"
        fi
        if [ "$smaps_status" != "ok" ]; then
          smaps_metrics="$empty_smaps"
        fi
      fi
      if [ -z "$cgroup_memory_max$cgroup_memory_high$cgroup_swap_max" ]; then
        cgroup_status="disabled"
        cgroup_metrics="$empty_cgroup"
        cgroup_file_cache_metrics="$empty_cgroup_file_cache"
      elif printf '%s\n' "$cgroup_metrics_all" | awk -F '\t' '
        BEGIN {
          key[24] = "active_file"
          key[25] = "inactive_file"
          key[26] = "file_mapped"
          key[27] = "workingset_refault_file"
          key[28] = "workingset_activate_file"
          key[29] = "workingset_restore_file"
          key[30] = "pgscan"
          key[31] = "pgsteal"
        }
        NF != 34 { exit 1 }
        {
          for (i = 1; i <= 23; i++) if ($i == "") exit 1
          for (i = 24; i <= 31; i++)
            if ($i != "" && $i !~ /^[0-9]+$/) exit 1
          if ($32 == "complete") {
            if ($33 != "none") exit 1
            for (i = 24; i <= 31; i++) if ($i == "") exit 1
          } else if ($32 == "partial") {
            if ($33 == "" || $33 == "none") exit 1
            count = split($33, listed, ",")
            for (i = 1; i <= count; i++) {
              if (!(listed[i] ~ /^(active_file|inactive_file|file_mapped|workingset_refault_file|workingset_activate_file|workingset_restore_file|pgscan|pgsteal)$/) ||
                  missing[listed[i]]++) exit 1
            }
            for (i = 24; i <= 31; i++)
              if (($i == "") != (key[i] in missing)) exit 1
          } else {
            exit 1
          }
          if ($34 !~ /^memory[.]events([.]local)?$/) exit 1
        }
      '; then
        cgroup_status="ok"
        cgroup_metrics="$(printf '%s\n' "$cgroup_metrics_all" | cut -f 1-23)"
        cgroup_file_cache_metrics="$(printf '%s\n' "$cgroup_metrics_all" | cut -f 24-34)"
      else
        cgroup_status="unavailable"
        cgroup_metrics="$empty_cgroup"
        cgroup_file_cache_metrics="$empty_cgroup_file_cache"
      fi
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$now" "$target" "$phase" "$root_pid" "$metrics" "$pids" "$smaps_metrics" \
        "$cgroup_metrics" "$host_fd_metrics" "$expected_processes" \
        "$observed_smaps" "$smaps_status" "$cgroup_status" \
        "$cgroup_file_cache_metrics" "$tree_status" \
        >>"$samples_tsv"
      phase_transition_retries=0
    else
      if [ "$process_tree_race_retries" -lt "$process_tree_race_retry_limit" ]; then
        process_tree_race_retries=$((process_tree_race_retries + 1))
        printf 'resource sample empty process tree; retry=%s/%s target=%s phase=%s\n' \
          "$process_tree_race_retries" "$process_tree_race_retry_limit" \
          "$target" "$phase" >&2
        continue
      fi
      process_tree_race_retries=0
      if [ -z "$cgroup_memory_max$cgroup_memory_high$cgroup_swap_max" ]; then
        cgroup_status="disabled"
      else
        cgroup_status="unavailable"
      fi
      printf '%s\t%s\t%s\t%s\t0\t0\t0\t0.0\t0\t\t%s\t%s\t\t0\t0\traced\t0\t0\traced\t%s\t%s\traced\n' \
        "$now" "$target" "$phase" "$root_pid" "$empty_smaps" "$empty_cgroup" \
        "$cgroup_status" "$empty_cgroup_file_cache" >>"$samples_tsv"
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
    function observe_file_cache_counter(phase, name, value, timestamp, key) {
      if (value == "") return
      key = phase SUBSEP name
      if (!counter_samples[key]) {
        counter_first[key] = value + 0
        counter_first_ms[key] = timestamp + 0
      } else if ((value + 0) < counter_last[key]) {
        malformed_cgroup = 1
      }
      counter_last[key] = value + 0
      counter_last_ms[key] = timestamp + 0
      counter_samples[key] += 1
    }
    function counter_summary_value(phase, name, kind, key, elapsed, delta) {
      key = phase SUBSEP name
      if (!cgroup_valid_samples[phase] ||
          counter_samples[key] != cgroup_valid_samples[phase]) return ""
      delta = counter_last[key] - counter_first[key]
      if (kind == "start") return sprintf("%.0f", counter_first[key])
      if (kind == "end") return sprintf("%.0f", counter_last[key])
      if (kind == "delta") return sprintf("%.0f", delta)
      elapsed = counter_last_ms[key] - counter_first_ms[key]
      if (kind == "rate" && elapsed > 0)
        return sprintf("%.6f", delta * 1000.0 / elapsed)
      return ""
    }
    function phase_file_cache_missing_keys(phase, result, item_index, name) {
      ordered[1] = "active_file"
      ordered[2] = "inactive_file"
      ordered[3] = "file_mapped"
      ordered[4] = "workingset_refault_file"
      ordered[5] = "workingset_activate_file"
      ordered[6] = "workingset_restore_file"
      ordered[7] = "pgscan"
      ordered[8] = "pgsteal"
      result = ""
      for (item_index = 1; item_index <= 8; item_index++) {
        name = ordered[item_index]
        if (phase_missing[phase SUBSEP name])
          result = result (result == "" ? "" : ",") name
      }
      return (result == "" ? "none" : result)
    }
    NR == 1 { next }
    {
      phase = $3
      if (phase == "") {
        phase = "unknown"
      }
      host_fd_count = $47
      host_fd_observed = $48
      host_fd_expected = $49
      host_fd_status = $50
      smaps_expected = $51
      smaps_observed = $52
      smaps_status = $53
      cgroup_status = $54
      file_cache_status = $63
      file_cache_missing = $64
      memory_events_source = $65
      process_tree_status = $66
      if (process_tree_status == "ok") {
        process_pid_text = $10
        sub(/[[:space:]]+$/, "", process_pid_text)
        process_pid_count = split(process_pid_text, process_pids, /[[:space:]]+/)
        if ($5 !~ /^[1-9][0-9]*$/ ||
            $6 !~ /^[0-9]+$/ || $7 !~ /^[0-9]+$/ ||
            $8 !~ /^[0-9]+([.][0-9]+)?$/ || $9 !~ /^[0-9]+$/ ||
            $10 !~ /^[0-9]+([[:space:]]+[0-9]+)*[[:space:]]*$/ ||
            process_pid_count != ($5 + 0) ||
            smaps_expected !~ /^[0-9]+$/ ||
            ($5 + 0) != (smaps_expected + 0)) {
          malformed_process_tree = 1
        }
      } else if (process_tree_status == "raced") {
        if ($5 != "0" || $6 != "0" || $7 != "0" ||
            $8 !~ /^0([.]0+)?$/ || $9 != "0" || $10 != "") {
          malformed_process_tree = 1
        }
      } else {
        malformed_process_tree = 1
      }
      if (host_fd_status == "ok") {
        if (host_fd_count !~ /^[0-9]+$/ ||
            host_fd_observed !~ /^[0-9]+$/ ||
            host_fd_expected !~ /^[0-9]+$/ ||
            (host_fd_expected + 0) < 1 ||
            (host_fd_observed + 0) != (host_fd_expected + 0)) {
          malformed_host_fd = 1
        } else {
          host_fd_valid_samples[phase] += 1
          if (!have_peak_host_fd[phase] ||
              (host_fd_count + 0) > peak_host_fd[phase]) {
            peak_host_fd[phase] = host_fd_count + 0
          }
          have_peak_host_fd[phase] = 1
        }
      } else if (host_fd_status == "unsupported") {
        if (host_fd_count != "" || host_fd_observed != "0" ||
            host_fd_expected !~ /^[0-9]+$/) {
          malformed_host_fd = 1
        }
        host_fd_unsupported_samples[phase] += 1
      } else if (host_fd_status == "unreadable") {
        if (host_fd_count != "" ||
            host_fd_observed !~ /^[0-9]+$/ ||
            host_fd_expected !~ /^[0-9]+$/ ||
            (host_fd_expected + 0) < 1 ||
            (host_fd_observed + 0) >= (host_fd_expected + 0)) {
          malformed_host_fd = 1
        }
        host_fd_unreadable_samples[phase] += 1
      } else if (host_fd_status == "raced") {
        if (host_fd_count != "" ||
            host_fd_observed !~ /^[0-9]+$/ ||
            host_fd_expected !~ /^[0-9]+$/ ||
            (host_fd_observed + 0) > (host_fd_expected + 0) ||
            ((host_fd_expected + 0) > 0 &&
             (host_fd_observed + 0) == (host_fd_expected + 0))) {
          malformed_host_fd = 1
        }
        host_fd_raced_samples[phase] += 1
      } else {
        malformed_host_fd = 1
      }
      smaps_fields_blank = 1
      smaps_fields_numeric = 1
      for (column = 11; column <= 23; column++) {
        if ($column != "") {
          smaps_fields_blank = 0
        }
        if ($column !~ /^[0-9]+$/) {
          smaps_fields_numeric = 0
        }
      }
      if (smaps_status == "ok") {
        if (smaps_expected !~ /^[0-9]+$/ ||
            smaps_observed !~ /^[0-9]+$/ ||
            (smaps_expected + 0) < 1 ||
            (smaps_observed + 0) != (smaps_expected + 0) ||
            ($19 + 0) != (smaps_observed + 0) ||
            !smaps_fields_numeric) {
          malformed_smaps = 1
        } else {
          smaps_valid_samples[phase] += 1
        }
      } else if (smaps_status == "unsupported" || smaps_status == "disabled") {
        if (smaps_expected !~ /^[0-9]+$/ ||
            (smaps_expected + 0) < 1 || smaps_observed != "0" ||
            !smaps_fields_blank) {
          malformed_smaps = 1
        }
        if (smaps_status == "unsupported") {
          smaps_unsupported_samples[phase] += 1
        } else {
          smaps_disabled_samples[phase] += 1
        }
      } else if (smaps_status == "unreadable") {
        if (smaps_expected !~ /^[0-9]+$/ ||
            smaps_observed !~ /^[0-9]+$/ ||
            (smaps_expected + 0) < 1 ||
            (smaps_observed + 0) >= (smaps_expected + 0) ||
            !smaps_fields_blank) {
          malformed_smaps = 1
        }
        smaps_unreadable_samples[phase] += 1
      } else if (smaps_status == "raced") {
        if (smaps_expected !~ /^[0-9]+$/ ||
            smaps_observed !~ /^[0-9]+$/ ||
            (smaps_observed + 0) > (smaps_expected + 0) ||
            !smaps_fields_blank) {
          malformed_smaps = 1
        }
        smaps_raced_samples[phase] += 1
      } else {
        malformed_smaps = 1
      }
      cgroup_fields_blank = 1
      cgroup_fields_complete = 1
      for (column = 24; column <= 46; column++) {
        if ($column != "") {
          cgroup_fields_blank = 0
        } else {
          cgroup_fields_complete = 0
        }
      }
      file_cache_fields_blank = 1
      for (column = 55; column <= 65; column++) {
        if ($column != "") file_cache_fields_blank = 0
      }
      if (cgroup_status == "ok") {
        if (!cgroup_fields_complete || $24 !~ /^\// ||
            $25 !~ /^[0-9]+$/ || $26 !~ /^[0-9]+$/ ||
            $27 !~ /^[0-9]+$/ || $28 !~ /^[0-9]+$/ ||
            $29 !~ /^[0-9]+$/ || $30 !~ /^[0-9]+$/ ||
            $31 !~ /^[0-9]+$/ || $32 !~ /^[0-9]+$/ ||
            $33 !~ /^[0-9]+$/ ||
            $34 !~ /^(max|[0-9]+)$/ ||
            $35 !~ /^(max|[0-9]+)$/ ||
            $36 !~ /^(max|[0-9]+)$/) {
          malformed_cgroup = 1
        }
        for (column = 37; column <= 46; column++) {
          if ($column !~ /^[0-9]+$/) {
            malformed_cgroup = 1
          }
        }
        optional_key[55] = "active_file"
        optional_key[56] = "inactive_file"
        optional_key[57] = "file_mapped"
        optional_key[58] = "workingset_refault_file"
        optional_key[59] = "workingset_activate_file"
        optional_key[60] = "workingset_restore_file"
        optional_key[61] = "pgscan"
        optional_key[62] = "pgsteal"
        for (column = 55; column <= 62; column++)
          delete optional_missing[optional_key[column]]
        for (column = 55; column <= 62; column++) {
          if ($column != "" && $column !~ /^[0-9]+$/) malformed_cgroup = 1
        }
        if (file_cache_status == "complete") {
          if (file_cache_missing != "none") malformed_cgroup = 1
          for (column = 55; column <= 62; column++)
            if ($column == "") malformed_cgroup = 1
          file_cache_complete_samples[phase] += 1
        } else if (file_cache_status == "partial") {
          if (file_cache_missing == "" || file_cache_missing == "none") {
            malformed_cgroup = 1
          } else {
            optional_count = split(file_cache_missing, listed_optional, ",")
            for (optional_index = 1; optional_index <= optional_count; optional_index++) {
              optional_name = listed_optional[optional_index]
              if (!(optional_name ~ /^(active_file|inactive_file|file_mapped|workingset_refault_file|workingset_activate_file|workingset_restore_file|pgscan|pgsteal)$/) ||
                  optional_missing[optional_name]++) malformed_cgroup = 1
              phase_missing[phase SUBSEP optional_name] = 1
            }
            for (column = 55; column <= 62; column++)
              if (($column == "") != (optional_key[column] in optional_missing))
                malformed_cgroup = 1
          }
          file_cache_partial_samples[phase] += 1
        } else {
          malformed_cgroup = 1
        }
        if (memory_events_source !~ /^memory[.]events([.]local)?$/) {
          malformed_cgroup = 1
        } else if (whole_run_memory_events_source == "") {
          whole_run_memory_events_source = memory_events_source
        } else if (whole_run_memory_events_source != memory_events_source) {
          malformed_cgroup = 1
        }
        cgroup_valid_samples[phase] += 1
      } else if (cgroup_status == "disabled" || cgroup_status == "unavailable") {
        if (!cgroup_fields_blank || !file_cache_fields_blank) {
          malformed_cgroup = 1
        }
        if (cgroup_status == "disabled") {
          cgroup_disabled_samples[phase] += 1
        } else {
          cgroup_unavailable_samples[phase] += 1
        }
      } else {
        malformed_cgroup = 1
      }
      samples_count[phase] += 1
      if (process_tree_status == "ok") {
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
      if (smaps_status == "ok" && ($11 + 0) > peak_pss[phase]) {
        peak_pss[phase] = $11 + 0
      }
      if (smaps_status == "ok" && ($12 + 0) > peak_pss_anon[phase]) {
        peak_pss_anon[phase] = $12 + 0
      }
      if (smaps_status == "ok" && ($13 + 0) > peak_pss_file[phase]) {
        peak_pss_file[phase] = $13 + 0
      }
      if (smaps_status == "ok" && ($14 + 0) > peak_pss_shmem[phase]) {
        peak_pss_shmem[phase] = $14 + 0
      }
      if (smaps_status == "ok" && ($15 + 0) > peak_private[phase]) {
        peak_private[phase] = $15 + 0
      }
      if (smaps_status == "ok" && ($16 + 0) > peak_shared[phase]) {
        peak_shared[phase] = $16 + 0
      }
      if (smaps_status == "ok" && ($17 + 0) > peak_anonymous[phase]) {
        peak_anonymous[phase] = $17 + 0
      }
      if (smaps_status == "ok" && ($18 + 0) > peak_swap[phase]) {
        peak_swap[phase] = $18 + 0
      }
      if (smaps_status == "ok") {
        smaps_samples[phase] += 1
      }
      if (smaps_status == "ok" && ($20 + 0) > peak_threads[phase]) {
        peak_threads[phase] = $20 + 0
      }
      if (smaps_status == "ok" && ($21 + 0) > peak_page_tables[phase]) {
        peak_page_tables[phase] = $21 + 0
      }
      if (smaps_status == "ok" && ($22 + 0) > peak_private_clean[phase]) {
        peak_private_clean[phase] = $22 + 0
      }
      if (smaps_status == "ok" && ($23 + 0) > peak_private_dirty[phase]) {
        peak_private_dirty[phase] = $23 + 0
      }
      if (cgroup_status == "ok" && $24 != "") {
        whole_run_cgroup_path = $24
      }
      if (cgroup_status == "ok" && ($25 + 0) > peak_cgroup_memory_current[phase]) {
        peak_cgroup_memory_current[phase] = $25 + 0
      }
      if (cgroup_status == "ok" && ($26 + 0) > whole_run_cgroup_memory_peak) {
        whole_run_cgroup_memory_peak = $26 + 0
      }
      if (cgroup_status == "ok" && ($27 + 0) > peak_cgroup_swap_current[phase]) {
        peak_cgroup_swap_current[phase] = $27 + 0
      }
      if (cgroup_status == "ok" && ($28 + 0) > whole_run_cgroup_swap_peak) {
        whole_run_cgroup_swap_peak = $28 + 0
      }
      if (cgroup_status == "ok" && ($29 + 0) > peak_cgroup_pids[phase]) {
        peak_cgroup_pids[phase] = $29 + 0
      }
      if (cgroup_status == "ok" && ($30 + 0) > whole_run_cgroup_event_high) {
        whole_run_cgroup_event_high = $30 + 0
      }
      if (cgroup_status == "ok" && ($31 + 0) > whole_run_cgroup_event_max) {
        whole_run_cgroup_event_max = $31 + 0
      }
      if (cgroup_status == "ok" && ($32 + 0) > whole_run_cgroup_event_oom) {
        whole_run_cgroup_event_oom = $32 + 0
      }
      if (cgroup_status == "ok" && ($33 + 0) > whole_run_cgroup_event_oom_kill) {
        whole_run_cgroup_event_oom_kill = $33 + 0
      }
      if (cgroup_status == "ok" && $34 != "") {
        whole_run_cgroup_memory_max = $34
      }
      if (cgroup_status == "ok" && $35 != "") {
        whole_run_cgroup_memory_high = $35
      }
      if (cgroup_status == "ok" && $36 != "") {
        whole_run_cgroup_swap_max = $36
      }
      if (cgroup_status == "ok" && ($37 + 0) > peak_cgroup_memory_stat_anon[phase]) {
        peak_cgroup_memory_stat_anon[phase] = $37 + 0
      }
      if (cgroup_status == "ok" && ($38 + 0) > peak_cgroup_memory_stat_file[phase]) {
        peak_cgroup_memory_stat_file[phase] = $38 + 0
      }
      if (cgroup_status == "ok" && ($39 + 0) > peak_cgroup_memory_stat_shmem[phase]) {
        peak_cgroup_memory_stat_shmem[phase] = $39 + 0
      }
      if (cgroup_status == "ok" && ($40 + 0) > peak_cgroup_memory_stat_kernel[phase]) {
        peak_cgroup_memory_stat_kernel[phase] = $40 + 0
      }
      if (cgroup_status == "ok" && ($41 + 0) > peak_cgroup_memory_stat_pagetables[phase]) {
        peak_cgroup_memory_stat_pagetables[phase] = $41 + 0
      }
      if (cgroup_status == "ok" && ($42 + 0) > peak_cgroup_memory_stat_slab[phase]) {
        peak_cgroup_memory_stat_slab[phase] = $42 + 0
      }
      if (cgroup_status == "ok" && ($43 + 0) > peak_cgroup_memory_stat_file_dirty[phase]) {
        peak_cgroup_memory_stat_file_dirty[phase] = $43 + 0
      }
      if (cgroup_status == "ok" && ($44 + 0) > peak_cgroup_memory_stat_file_writeback[phase]) {
        peak_cgroup_memory_stat_file_writeback[phase] = $44 + 0
      }
      if (cgroup_status == "ok" && ($45 + 0) > whole_run_cgroup_memory_pressure_some_total) {
        whole_run_cgroup_memory_pressure_some_total = $45 + 0
      }
      if (cgroup_status == "ok" && ($46 + 0) > whole_run_cgroup_memory_pressure_full_total) {
        whole_run_cgroup_memory_pressure_full_total = $46 + 0
      }
      if (cgroup_status == "ok") {
        if ($1 !~ /^[0-9]+$/) {
          malformed_cgroup = 1
        } else {
          if (!have_file_cache_window[phase]) {
            file_cache_first_ms[phase] = $1 + 0
            have_file_cache_window[phase] = 1
          } else if (($1 + 0) <= file_cache_last_ms[phase]) {
            malformed_cgroup = 1
          }
          file_cache_last_ms[phase] = $1 + 0
          if ($55 != "" && (!have_peak_active_file[phase] ||
              ($55 + 0) > peak_active_file[phase])) {
            peak_active_file[phase] = $55 + 0
            have_peak_active_file[phase] = 1
          }
          if ($56 != "" && (!have_peak_inactive_file[phase] ||
              ($56 + 0) > peak_inactive_file[phase])) {
            peak_inactive_file[phase] = $56 + 0
            have_peak_inactive_file[phase] = 1
          }
          if ($57 != "" && (!have_peak_file_mapped[phase] ||
              ($57 + 0) > peak_file_mapped[phase])) {
            peak_file_mapped[phase] = $57 + 0
            have_peak_file_mapped[phase] = 1
          }
          observe_file_cache_counter(phase, "workingset_refault_file", $58, $1)
          observe_file_cache_counter(phase, "workingset_activate_file", $59, $1)
          observe_file_cache_counter(phase, "workingset_restore_file", $60, $1)
          observe_file_cache_counter(phase, "pgscan", $61, $1)
          observe_file_cache_counter(phase, "pgsteal", $62, $1)
        }
      }
    }
    END {
      if (malformed_process_tree || malformed_host_fd || malformed_smaps ||
          malformed_cgroup) {
        exit 1
      }
      for (phase in samples_count) {
        active_file_peak = (have_peak_active_file[phase] ?
          sprintf("%.0f", peak_active_file[phase]) : "")
        active_file_peak_mb = (have_peak_active_file[phase] ?
          sprintf("%.3f", peak_active_file[phase] / 1048576.0) : "")
        inactive_file_peak = (have_peak_inactive_file[phase] ?
          sprintf("%.0f", peak_inactive_file[phase]) : "")
        inactive_file_peak_mb = (have_peak_inactive_file[phase] ?
          sprintf("%.3f", peak_inactive_file[phase] / 1048576.0) : "")
        file_mapped_peak = (have_peak_file_mapped[phase] ?
          sprintf("%.0f", peak_file_mapped[phase]) : "")
        file_mapped_peak_mb = (have_peak_file_mapped[phase] ?
          sprintf("%.3f", peak_file_mapped[phase] / 1048576.0) : "")
        if (!cgroup_valid_samples[phase]) {
          phase_file_cache_status = "unavailable"
          phase_file_cache_missing = "not-sampled"
          phase_events_source = "unavailable"
          phase_file_cache_elapsed_ms = ""
        } else {
          phase_file_cache_status = (file_cache_partial_samples[phase] ?
            "partial" : "complete")
          phase_file_cache_missing = phase_file_cache_missing_keys(phase)
          phase_events_source = whole_run_memory_events_source
          phase_file_cache_elapsed_ms = sprintf("%.0f",
            file_cache_last_ms[phase] - file_cache_first_ms[phase])
        }
        printf "%s\t%s\t%d\t%.3f\t%d\t%.1f\t%d\t%d\t%s\t%d\t%.3f\t%d\t%.3f\t%d\t%.3f\t%d\t%.3f\t%d\t%.3f\t%d\t%.3f\t%d\t%.3f\t%d\t%d\t%d\t%d\t%.3f\t%d\t%.3f\t%d\t%.3f\t%s\t%.0f\t%.3f\t%.0f\t%.3f\t%.0f\t%.3f\t%.0f\t%.3f\t%.0f\t%.0f\t%.0f\t%.0f\t%.0f\t%s\t%s\t%s",
          target,
          phase,
          peak_rss[phase],
          peak_rss[phase] / 1024.0,
          peak_vsz[phase],
          peak_cpu[phase],
          peak_processes[phase],
          samples_count[phase],
          samples,
          peak_pss[phase],
          peak_pss[phase] / 1024.0,
          peak_pss_anon[phase],
          peak_pss_anon[phase] / 1024.0,
          peak_pss_file[phase],
          peak_pss_file[phase] / 1024.0,
          peak_pss_shmem[phase],
          peak_pss_shmem[phase] / 1024.0,
          peak_private[phase],
          peak_private[phase] / 1024.0,
          peak_shared[phase],
          peak_shared[phase] / 1024.0,
          peak_anonymous[phase],
          peak_anonymous[phase] / 1024.0,
          peak_swap[phase],
          smaps_samples[phase],
          peak_threads[phase],
          peak_page_tables[phase],
          peak_page_tables[phase] / 1024.0,
          peak_private_clean[phase],
          peak_private_clean[phase] / 1024.0,
          peak_private_dirty[phase],
          peak_private_dirty[phase] / 1024.0,
          whole_run_cgroup_path,
          peak_cgroup_memory_current[phase],
          peak_cgroup_memory_current[phase] / 1048576.0,
          whole_run_cgroup_memory_peak,
          whole_run_cgroup_memory_peak / 1048576.0,
          peak_cgroup_swap_current[phase],
          peak_cgroup_swap_current[phase] / 1048576.0,
          whole_run_cgroup_swap_peak,
          whole_run_cgroup_swap_peak / 1048576.0,
          peak_cgroup_pids[phase],
          whole_run_cgroup_event_high,
          whole_run_cgroup_event_max,
          whole_run_cgroup_event_oom,
          whole_run_cgroup_event_oom_kill,
          whole_run_cgroup_memory_max,
          whole_run_cgroup_memory_high,
          whole_run_cgroup_swap_max
        printf "\t%.0f\t%.3f\t%.0f\t%.3f\t%.0f\t%.3f\t%.0f\t%.3f\t%.0f\t%.3f\t%.0f\t%.3f\t%.0f\t%.3f\t%.0f\t%.3f\t%.0f\t%.0f",
          peak_cgroup_memory_stat_anon[phase],
          peak_cgroup_memory_stat_anon[phase] / 1048576.0,
          peak_cgroup_memory_stat_file[phase],
          peak_cgroup_memory_stat_file[phase] / 1048576.0,
          peak_cgroup_memory_stat_shmem[phase],
          peak_cgroup_memory_stat_shmem[phase] / 1048576.0,
          peak_cgroup_memory_stat_kernel[phase],
          peak_cgroup_memory_stat_kernel[phase] / 1048576.0,
          peak_cgroup_memory_stat_pagetables[phase],
          peak_cgroup_memory_stat_pagetables[phase] / 1048576.0,
          peak_cgroup_memory_stat_slab[phase],
          peak_cgroup_memory_stat_slab[phase] / 1048576.0,
          peak_cgroup_memory_stat_file_dirty[phase],
          peak_cgroup_memory_stat_file_dirty[phase] / 1048576.0,
          peak_cgroup_memory_stat_file_writeback[phase],
          peak_cgroup_memory_stat_file_writeback[phase] / 1048576.0,
          whole_run_cgroup_memory_pressure_some_total,
          whole_run_cgroup_memory_pressure_full_total
        printf "\t%s\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d",
          (have_peak_host_fd[phase] ? sprintf("%.0f", peak_host_fd[phase]) : ""),
          host_fd_valid_samples[phase],
          host_fd_unsupported_samples[phase],
          host_fd_unreadable_samples[phase],
          host_fd_raced_samples[phase],
          smaps_valid_samples[phase],
          smaps_unsupported_samples[phase],
          smaps_disabled_samples[phase],
          smaps_unreadable_samples[phase],
          smaps_raced_samples[phase],
          cgroup_valid_samples[phase],
          cgroup_disabled_samples[phase],
          cgroup_unavailable_samples[phase]
        printf "\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s",
          active_file_peak,
          active_file_peak_mb,
          inactive_file_peak,
          inactive_file_peak_mb,
          file_mapped_peak,
          file_mapped_peak_mb,
          phase_file_cache_status,
          phase_file_cache_missing,
          phase_events_source,
          phase_file_cache_elapsed_ms
        printf "\t%s\t%s\t%s\t%s",
          counter_summary_value(phase, "workingset_refault_file", "start"),
          counter_summary_value(phase, "workingset_refault_file", "end"),
          counter_summary_value(phase, "workingset_refault_file", "delta"),
          counter_summary_value(phase, "workingset_refault_file", "rate")
        printf "\t%s\t%s\t%s\t%s",
          counter_summary_value(phase, "workingset_activate_file", "start"),
          counter_summary_value(phase, "workingset_activate_file", "end"),
          counter_summary_value(phase, "workingset_activate_file", "delta"),
          counter_summary_value(phase, "workingset_activate_file", "rate")
        printf "\t%s\t%s\t%s\t%s",
          counter_summary_value(phase, "workingset_restore_file", "start"),
          counter_summary_value(phase, "workingset_restore_file", "end"),
          counter_summary_value(phase, "workingset_restore_file", "delta"),
          counter_summary_value(phase, "workingset_restore_file", "rate")
        printf "\t%s\t%s\t%s\t%s",
          counter_summary_value(phase, "pgscan", "start"),
          counter_summary_value(phase, "pgscan", "end"),
          counter_summary_value(phase, "pgscan", "delta"),
          counter_summary_value(phase, "pgscan", "rate")
        printf "\t%s\t%s\t%s\t%s\n",
          counter_summary_value(phase, "pgsteal", "start"),
          counter_summary_value(phase, "pgsteal", "end"),
          counter_summary_value(phase, "pgsteal", "delta"),
          counter_summary_value(phase, "pgsteal", "rate")
      }
    }
  ' "$samples_tsv" | sort >>"$out_tsv"
}

summarize_resource_usage_checked() {
  local target="$1"
  local samples_tsv="$2"
  local out_tsv="$3"

  if ! summarize_resource_usage "$target" "$samples_tsv" "$out_tsv"; then
    printf 'resource evidence summary validation failed for %s; see %s\n' \
      "$target" "$samples_tsv" >&2
    return 1
  fi
}

sample_pg_wait_events() {
  local target="$1"
  local workload="$2"
  local conn="$3"
  local samples_tsv="$4"
  local interval="$5"
  local sampler_sql="${samples_tsv%.tsv}.sql"
  local sampler_stderr="${samples_tsv%.tsv}.stderr.log"

  printf 'unix_ms\ttarget\tworkload\tpid\twait_event_type\twait_event\tstate\tbackend_type\tbackend_xid\tblocking_pids\textend_lock_modes\textend_lock_granted\textend_lock_waitstart\textend_lock_relations\n' >"$samples_tsv"
  {
    printf 'WITH sampled_at AS MATERIALIZED (\n'
    printf '  SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS unix_ms\n'
    printf ')\n'
    printf 'SELECT\n'
    printf '  sampled_at.unix_ms,\n'
    printf "  :'sample_target',\n"
    printf "  :'sample_workload',\n"
    printf '  pid,\n'
    printf "  coalesce(wait_event_type, ''),\n"
    printf "  coalesce(wait_event, ''),\n"
    printf "  coalesce(state, ''),\n"
    printf "  coalesce(backend_type, ''),\n"
    printf "  coalesce(backend_xid::text, ''),\n"
    printf "  array_to_string(pg_blocking_pids(activity.pid), ','),\n"
    printf "  coalesce(extension_lock.modes, ''),\n"
    printf "  coalesce(extension_lock.granted, ''),\n"
    printf "  coalesce(extension_lock.waitstart, ''),\n"
    printf "  coalesce(extension_lock.relations, '')\n"
    printf 'FROM pg_stat_activity AS activity\n'
    printf 'CROSS JOIN sampled_at\n'
    printf 'LEFT JOIN LATERAL (\n'
    printf '  SELECT\n'
    printf "    string_agg(held_lock.mode, ',' ORDER BY held_lock.mode) AS modes,\n"
    printf "    string_agg(held_lock.granted::text, ',' ORDER BY held_lock.mode) AS granted,\n"
    printf "    min(held_lock.waitstart)::text AS waitstart,\n"
    printf "    string_agg(coalesce(held_lock.relation::regclass::text, held_lock.relation::text), ',' ORDER BY held_lock.relation) AS relations\n"
    printf '  FROM pg_locks AS held_lock\n'
    printf "  WHERE held_lock.pid = activity.pid AND held_lock.locktype = 'extend'\n"
    printf ') AS extension_lock ON true\n'
    printf 'WHERE activity.pid <> pg_backend_pid()\n'
    printf 'ORDER BY activity.backend_type, activity.pid;\n'
    printf '\\watch %s\n' "$interval"
  } >"$sampler_sql"

  exec "$NATIVE_INSTALL_DIR/bin/psql" "$conn" -XAtq -F $'\t' \
    -v ON_ERROR_STOP=1 \
    -v "sample_target=$target" \
    -v "sample_workload=$workload" \
    -f "$sampler_sql" >>"$samples_tsv" 2>"$sampler_stderr"
}

summarize_pg_wait_events() {
  local samples_tsv="$1"
  local out_tsv="$2"

  {
    printf "wait_event_type\twait_event\tstate\tbackend_type\tsample_rows\tbackend_observations\tmax_count\n"
    awk -F '\t' '
      NR == 1 { next }
      {
        key = $5 "\t" $6 "\t" $7 "\t" $8
        sample_key = $1 SUBSEP key
        observations[key] += 1
        if (!seen_sample[sample_key]++) {
          samples[key] += 1
        }
        per_sample[sample_key] += 1
        if (per_sample[sample_key] > max_count[key]) {
          max_count[key] = per_sample[sample_key]
        }
      }
      END {
        for (key in observations) {
          printf "%s\t%d\t%d\t%d\n", key, samples[key], observations[key], max_count[key]
        }
      }
    ' "$samples_tsv" | sort -t $'\t' -k6,6nr
  } >"$out_tsv"
}

capture_relation_footprint() {
  local conn="$1"
  local workload="$2"
  local out_tsv="$3"

  fresh_run_process_group_timeout "$timeout_seconds" -- \
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

capture_checkpoint_state() {
  local conn="$1"
  local out_tsv="$2"
  local capture="$out_tsv.capture"
  local row

  if ! fresh_run_process_group_timeout "$timeout_seconds" -- \
    "$NATIVE_INSTALL_DIR/bin/psql" "$conn" -XAtq -F $'\t' -v ON_ERROR_STOP=1 -c "
    SELECT
      checkpointer.num_timed::text,
      checkpointer.num_requested::text,
      checkpointer.num_done::text,
      wal.wal_bytes::text
    FROM pg_stat_checkpointer AS checkpointer
    CROSS JOIN pg_stat_wal AS wal
  " >"$capture" 2>"$out_tsv.stderr"; then
    rm -f "$capture"
    return 1
  fi
  row="$(<"$capture")"
  rm -f "$capture"
  case "$row" in
    *$'\n'*)
      printf 'checkpoint state returned more than one row\n' >&2
      return 1
      ;;
  esac
  if ! awk -F '\t' '
    NF == 4 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ &&
      $3 ~ /^[0-9]+$/ && $4 ~ /^[0-9]+$/ { valid = 1 }
    END { exit !valid }
  ' <<<"$row"; then
    printf 'invalid checkpoint state row: %s\n' "$row" >&2
    return 1
  fi
  printf '%s\n' "$row" >"$out_tsv"
}

capture_pg_stat_io() {
  local conn="$1"
  local out_csv="$2"

  fresh_run_process_group_timeout "$timeout_seconds" -- \
    "$NATIVE_INSTALL_DIR/bin/psql" "$conn" -X --csv -v ON_ERROR_STOP=1 -c "
    SELECT
      backend_type,
      object,
      context,
      reads,
      read_bytes,
      read_time,
      writes,
      write_bytes,
      write_time,
      writebacks,
      writeback_time,
      extends,
      extend_bytes,
      extend_time,
      hits,
      evictions,
      reuses,
      fsyncs,
      fsync_time,
      stats_reset
    FROM pg_stat_io
    ORDER BY backend_type, object, context
  " >"$out_csv" 2>"$out_csv.stderr"
}

capture_checkpoint_settings() {
  local conn="$1"
  local out_tsv="$2"
  local name names_sql="" separator="" seen_names=" "

  for name in \
    autovacuum_worker_slots \
    backend_flush_after \
    bgwriter_flush_after \
    checkpoint_flush_after \
    checkpoint_timeout \
    io_method \
    max_wal_size \
    min_wal_size \
    max_connections \
    max_wal_senders \
    max_worker_processes \
    shared_buffers \
    wal_segment_size \
    fsync \
    synchronous_commit \
    full_page_writes \
    "${explicit_postgres_guc_names[@]}"; do
    case "$seen_names" in
      *" $name "*) continue ;;
    esac
    seen_names+="$name "
    names_sql+="$separator'$name'"
    separator=,
  done

  {
    printf 'name\tsetting\tunit\tsource\n'
    fresh_run_process_group_timeout "$timeout_seconds" -- \
      "$NATIVE_INSTALL_DIR/bin/psql" "$conn" -XAtq -F $'\t' -v ON_ERROR_STOP=1 -c "
      SELECT name, setting, coalesce(unit, ''), source
      FROM pg_settings
      WHERE name IN ($names_sql)
      ORDER BY name
    "
  } >"$out_tsv" 2>"$out_tsv.stderr"
}

validate_controlled_checkpoint_settings() {
  local conn="$1"
  local validation_log="$2"
  local result

  if ! fresh_run_process_group_timeout "$timeout_seconds" -- \
    "$NATIVE_INSTALL_DIR/bin/psql" "$conn" -XAtq -v ON_ERROR_STOP=1 -c "
    SELECT
      current_setting('checkpoint_timeout')::interval = interval '1 hour'
      AND pg_size_bytes(current_setting('max_wal_size')) = 8589934592
      AND pg_size_bytes(current_setting('min_wal_size')) = 1073741824
      AND current_setting('fsync') = 'on'
      AND current_setting('synchronous_commit') = 'on'
      AND current_setting('full_page_writes') = 'on'
  " >"$validation_log" 2>"$validation_log.stderr"; then
    return 1
  fi
  result="$(tr -d '[:space:]' <"$validation_log")"
  [ "$result" = "t" ] || {
    printf 'controlled checkpoint settings were not applied by PostgreSQL\n' >&2
    return 1
  }
}

prepare_fanout_checkpoint_state() {
  local conn="$1"
  local workload_report_dir="$2"
  local settings_tsv="$workload_report_dir/checkpoint-settings.tsv"
  local checkpoint_log="$workload_report_dir/checkpoint-before.log"
  local before_state="$workload_report_dir/checkpoint-before.tsv"
  local before_io="$workload_report_dir/pg-stat-io-before.csv"

  capture_checkpoint_settings "$conn" "$settings_tsv" || return
  if [ "$checkpoint_policy" = "controlled" ]; then
    validate_controlled_checkpoint_settings \
      "$conn" "$workload_report_dir/checkpoint-settings-validation.log" || return
    run_logged_timeout "$timeout_seconds" "$checkpoint_log" \
      "$NATIVE_INSTALL_DIR/bin/psql" "$conn" -Xq -v ON_ERROR_STOP=1 -c CHECKPOINT || return
  else
    printf 'checkpoint policy is default; no pre-fanout CHECKPOINT was requested\n' \
      >"$checkpoint_log"
  fi
  capture_checkpoint_state "$conn" "$before_state" || return
  capture_pg_stat_io "$conn" "$before_io" || return
}

finish_fanout_checkpoint_state() {
  local target="$1"
  local workload="$2"
  local conn="$3"
  local workload_report_dir="$4"
  local before_state="$workload_report_dir/checkpoint-before.tsv"
  local after_state="$workload_report_dir/checkpoint-after.tsv"
  local before_io="$workload_report_dir/pg-stat-io-before.csv"
  local after_io="$workload_report_dir/pg-stat-io-after.csv"
  local io_delta="$workload_report_dir/pg-stat-io-delta.tsv"
  local io_delta_log="$workload_report_dir/pg-stat-io-delta.log"
  local io_delta_status="passed"
  local before_timed before_requested before_done before_wal
  local after_timed after_requested after_done after_wal
  local delta_timed delta_requested delta_done delta_wal checkpoint_status

  capture_checkpoint_state "$conn" "$after_state" || return
  capture_pg_stat_io "$conn" "$after_io" || return
  if ! python3 "$FRESH_ROOT/bin/delta-pg-stat-io.py" \
    "$before_io" "$after_io" "$io_delta" >"$io_delta_log" 2>&1; then
    io_delta_status="failed"
  fi
  IFS=$'\t' read -r before_timed before_requested before_done before_wal <"$before_state"
  IFS=$'\t' read -r after_timed after_requested after_done after_wal <"$after_state"
  delta_timed=$((after_timed - before_timed))
  delta_requested=$((after_requested - before_requested))
  delta_done=$((after_done - before_done))
  delta_wal=$((after_wal - before_wal))
  checkpoint_status="observed"
  if [ "$checkpoint_policy" = "controlled" ]; then
    checkpoint_status="passed"
    if [ "$delta_timed" -ne 0 ] || [ "$delta_requested" -ne 0 ] ||
      [ "$delta_done" -ne 0 ] || [ "$delta_wal" -lt 0 ] ||
      [ "$delta_wal" -gt "$checkpoint_wal_budget_bytes" ]; then
      checkpoint_status="failed"
    fi
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$target" "$workload" "$checkpoint_policy" "$checkpoint_status" \
    "$before_timed" "$after_timed" "$delta_timed" \
    "$before_requested" "$after_requested" "$delta_requested" \
    "$before_done" "$after_done" "$delta_done" \
    "$before_wal" "$after_wal" "$delta_wal" "$checkpoint_wal_budget_bytes" \
    "$before_state" "$after_state" "$before_io" "$after_io" \
    "$io_delta" "$io_delta_status" >>"$checkpoint_tsv"

  [ "$checkpoint_status" != "failed" ] && [ "$io_delta_status" = "passed" ]
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
    if [ -r "/proc/$pid/smaps" ]; then
      cp "/proc/$pid/smaps" "$snapshot_dir/$safe_label.$pid.smaps.txt" 2>/dev/null || true
      cp "/proc/$pid/smaps_rollup" "$snapshot_dir/$safe_label.$pid.smaps-rollup.txt" 2>/dev/null || true
      cp "/proc/$pid/status" "$snapshot_dir/$safe_label.$pid.status.txt" 2>/dev/null || true
      cp "/proc/$pid/numa_maps" "$snapshot_dir/$safe_label.$pid.numa-maps.txt" 2>/dev/null || true
      if [ -s "$snapshot_dir/$safe_label.$pid.smaps.txt" ]; then
        bash "$FRESH_ROOT/bin/summarize-linux-smaps.sh" \
          "$snapshot_dir/$safe_label.$pid.smaps.txt" \
          "$snapshot_dir/$safe_label.$pid.smaps-mappings.tsv" \
          "$snapshot_dir/$safe_label.$pid.smaps-categories.tsv" || true
      fi
    fi
    if command -v vmmap >/dev/null 2>&1; then
      vmmap -summary "$pid" >"$snapshot_dir/$safe_label.$pid.vmmap.txt" 2>&1 || true
    elif command -v pmap >/dev/null 2>&1; then
      pmap -x "$pid" >"$snapshot_dir/$safe_label.$pid.pmap.txt" 2>&1 || true
    fi
  done
}

capture_measurement_tool_closure() {
  local closure_id="${FRESH_MEASUREMENT_TOOL_CLOSURE_ID:-}"
  local closure_manifest="${FRESH_MEASUREMENT_TOOL_CLOSURE_MANIFEST:-}"
  local closure_manifest_sha256="${FRESH_MEASUREMENT_TOOL_CLOSURE_MANIFEST_SHA256:-}"
  local verifier="$FRESH_ROOT/bin/run-frozen-measurement.py"
  local verifier_sha256="none"
  local copied_manifest_sha256="none"

  if [ -z "$closure_id$closure_manifest$closure_manifest_sha256" ]; then
    [ "$require_frozen_measurement_tools" -eq 0 ] || {
      echo 'frozen measurement-tool closure is required but absent' >&2
      return 2
    }
  else
    [ -n "$closure_id" ] && [ -n "$closure_manifest" ] && \
      [ -n "$closure_manifest_sha256" ] || {
      echo 'partial frozen measurement-tool closure environment' >&2
      return 2
    }
    fresh_is_sha256 "$closure_id" && \
      fresh_is_sha256 "$closure_manifest_sha256" || {
      echo 'invalid frozen measurement-tool closure identity' >&2
      return 2
    }
    [ -f "$verifier" ] && [ ! -L "$verifier" ] && [ -x "$verifier" ] || {
      printf 'missing frozen measurement-tool verifier: %s\n' "$verifier" >&2
      return 2
    }
    [ "$closure_manifest" = "$FRESH_ROOT/.measurement-tool-closure.tsv" ] || {
      echo 'frozen measurement-tool manifest is outside FRESH_ROOT' >&2
      return 2
    }
    "$verifier" verify \
      --root "$FRESH_ROOT" \
      --manifest "$closure_manifest" \
      --identity "$closure_id" \
      --manifest-sha256 "$closure_manifest_sha256" >/dev/null || return
    cp -p -- "$closure_manifest" "$measurement_tool_closure_files_tsv"
    chmod 0444 "$measurement_tool_closure_files_tsv"
    copied_manifest_sha256="$(
      fresh_wasmer_bin_hash "$measurement_tool_closure_files_tsv"
    )" || return
    [ "$copied_manifest_sha256" = "$closure_manifest_sha256" ] || {
      echo 'captured measurement-tool manifest changed while copying' >&2
      return 125
    }
    verifier_sha256="$(fresh_wasmer_bin_hash "$verifier")" || return
    measurement_tool_closure_mode="content-addressed-read-only"
    measurement_tool_closure_identity="$closure_id"
    measurement_tool_closure_manifest_sha256="$closure_manifest_sha256"
  fi

  printf 'schema_version\tmode\trequired\tclosure_identity\tmanifest_sha256\tcaptured_manifest_sha256\tverifier_sha256\n' \
    >"$measurement_tool_closure_tsv"
  printf 'oliphaunt.wasix-postmaster.measurement-tool-evidence.v1\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$measurement_tool_closure_mode" \
    "$require_frozen_measurement_tools" \
    "$measurement_tool_closure_identity" \
    "$measurement_tool_closure_manifest_sha256" \
    "$copied_manifest_sha256" \
    "$verifier_sha256" >>"$measurement_tool_closure_tsv"
  measurement_tool_closure_evidence_identity="$(
    fresh_wasmer_bin_hash "$measurement_tool_closure_tsv"
  )" || return
  chmod 0444 "$measurement_tool_closure_tsv"
}

assert_frozen_measurement_tool_closure() {
  local actual_evidence_identity actual_manifest_sha256

  actual_evidence_identity="$(
    fresh_wasmer_bin_hash "$measurement_tool_closure_tsv"
  )" || return
  [ "$actual_evidence_identity" = \
    "$measurement_tool_closure_evidence_identity" ] || {
    echo 'measurement-tool closure evidence changed during benchmark' >&2
    return 125
  }
  [ "$measurement_tool_closure_mode" = content-addressed-read-only ] || \
    return 0
  actual_manifest_sha256="$(
    fresh_wasmer_bin_hash "$measurement_tool_closure_files_tsv"
  )" || return
  [ "$actual_manifest_sha256" = \
    "$measurement_tool_closure_manifest_sha256" ] || {
    echo 'captured measurement-tool manifest changed during benchmark' >&2
    return 125
  }
  "$FRESH_ROOT/bin/run-frozen-measurement.py" verify \
    --root "$FRESH_ROOT" \
    --manifest "$FRESH_MEASUREMENT_TOOL_CLOSURE_MANIFEST" \
    --identity "$measurement_tool_closure_identity" \
    --manifest-sha256 "$measurement_tool_closure_manifest_sha256" >/dev/null
}

suite_root="$RUN_DIR/concurrent-query-suite/$run_label"
report_dir="$REPORT_DIR/concurrent-query-suite/$run_label"
fresh_require_managed_generated_path "$suite_root" "concurrent benchmark run root"
fresh_require_managed_generated_path "$report_dir" "concurrent benchmark report root"
summary="$report_dir/summary.md"
summary_tsv="$report_dir/summary.tsv"
client_tsv="$report_dir/client-summary.tsv"
resource_tsv="$report_dir/resource-summary.tsv"
checkpoint_tsv="$report_dir/checkpoint-summary.tsv"
libpq_latency_tsv="$report_dir/libpq-latency-summary.tsv"
host_fd_checkpoints_tsv="$report_dir/host-fd-checkpoints.tsv"
host_fd_churn_tsv="$report_dir/host-fd-churn-summary.tsv"
server_limits_tsv="$report_dir/server-limits.tsv"
server_lifecycle_tsv="$report_dir/server-lifecycle.tsv"
memory_evidence_tsv="$report_dir/memory-evidence.tsv"
memory_budget_tsv="$report_dir/memory-budget.tsv"
lifecycle_plateau_tsv="$report_dir/wasix-runtime-plateau.tsv"
lifecycle_memory_checkpoints_tsv="$report_dir/wasix-lifecycle-memory-checkpoints.tsv"
lifecycle_memory_plateau_tsv="$report_dir/wasix-lifecycle-memory-plateau.tsv"
lifecycle_baseline_policy_tsv="$report_dir/wasix-lifecycle-baseline-policy.tsv"
lifecycle_baseline_binding_tsv="$report_dir/wasix-lifecycle-baseline-binding.tsv"
execution_identity_tsv="$report_dir/execution-identity.tsv"
sealed_executor_selection_tsv="$report_dir/sealed-executor-selection.tsv"
execution_identity_sha256=""
measurement_tool_closure_tsv="$report_dir/measurement-tool-closure.tsv"
measurement_tool_closure_files_tsv="$report_dir/measurement-tool-closure.files.tsv"
measurement_tool_closure_mode="unfrozen"
measurement_tool_closure_identity="none"
measurement_tool_closure_manifest_sha256="none"
measurement_tool_closure_evidence_identity=""
execution_bound_carrier_identity=""
execution_bound_manifest_identity=""
execution_bound_receipt_identity=""
execution_bound_payload_identity=""
execution_bound_headless_identity=""
execution_bound_wasmer_identity=""
execution_bound_postgres_module_identity=""
execution_bound_profile_identity=""
lifecycle_baseline_policy_identity=""
lifecycle_baseline_binding_identity=""
lifecycle_baseline_policy_id=""
lifecycle_baseline_policy_status=""
lifecycle_baseline_claim_scope=""
lifecycle_baseline_assumption=""
lifecycle_bound_wasmer_identity=""
lifecycle_bound_postgres_module_identity=""
lifecycle_bound_runtime_footprint_identity=""
lifecycle_bound_durability_identity=""
lifecycle_bound_profile_resolution_identity=""
lifecycle_bound_carrier_manifest_identity=""
lifecycle_bound_carrier_receipt_identity=""
lifecycle_bound_carrier_inventory_identity=""
instrumentation_policy_tsv="$report_dir/instrumentation-policy.tsv"
adaptive_cache_evidence_policy_tsv="$report_dir/adaptive-cache-evidence-policy.tsv"
adaptive_cache_evidence_policy_identity=""
adaptive_cache_validator_sha256=""
adaptive_cache_bound_manifest_sha256="none"
sealed_loader_policy_tsv="$report_dir/sealed-loader-policy.tsv"
sealed_loader_policy_identity=""
cold_ownership_mode_tsv="$report_dir/cold-ownership-mode.tsv"
postgres_profile_inputs_tsv="$report_dir/postgres-profile-inputs.tsv"
postgres_profile_resolution_tsv="$report_dir/postgres-profile-resolution.tsv"
checkpoint_wal_budget_bytes=4294967296

if [ "$wasix_runtime_mode" = "sealed-headless" ]; then
  canonical_suite_root="$(cd "$RUN_DIR" && pwd -P)/concurrent-query-suite/$run_label"
  canonical_report_dir="$(cd "$REPORT_DIR" && pwd -P)/concurrent-query-suite/$run_label"
  require_sealed_output_disjoint run "$canonical_suite_root"
  require_sealed_output_disjoint report "$canonical_report_dir"
fi

fresh_claim_generated_directories "$suite_root" "$report_dir" || {
  printf 'benchmark label is already claimed; choose a new --label: %s\n' \
    "$run_label" >&2
  exit 2
}
mkdir "$suite_root/sql"
if [ "$wasix_runtime_mode" = sealed-headless ]; then
  {
    printf 'schema_version\texecutor_role\texecutor_receipt_path\texecutor_receipt_sha256\texecutor_sha256\n'
    printf 'oliphaunt.wasix-postmaster.sealed-executor-selection.v1\t%s\t%s\t%s\t%s\n' \
      "$sealed_executor_role" "$sealed_executor_receipt_relative" \
      "$sealed_executor_receipt_hash" "$sealed_executor_hash"
  } >"$sealed_executor_selection_tsv"
  chmod 0444 "$sealed_executor_selection_tsv"
fi
capture_measurement_tool_closure || {
  echo 'failed to capture measurement-tool closure' >&2
  exit 2
}
if [ "$cold_ownership" -eq 0 ]; then
  cold_ownership_mode=disabled
elif [ "$cold_ownership_workloads" -eq 1 ]; then
  cold_ownership_mode=whole-lifecycle
else
  cold_ownership_mode=startup-only
fi
printf 'schema_version\tmode\tworkloads\tcgroup_scope\n' >"$cold_ownership_mode_tsv"
printf 'oliphaunt.wasix-postmaster.cold-ownership-mode.v1\t%s\t%s\t%s\n' \
  "$cold_ownership_mode" \
  "$([ "${#workloads[@]}" -gt 0 ] && printf '%s' "${workloads[*]}" || printf none)" \
  "$([ "$cold_ownership" -eq 1 ] && printf single-server-whole-lifecycle || printf none)" \
  >>"$cold_ownership_mode_tsv"
chmod 0444 "$cold_ownership_mode_tsv"
printf 'schema_version\truntime_mode\trequire_zero_write_aot\tverification_scope\tactivation_policy\truntime_environment\taudit_environment\tenvironment_inheritance\tallowed_snapshot_modes\tmax_source_bytes_written\tmax_snapshot_bytes_written\tmax_sync_calls\tvalidator\tvalidator_sha256\timmutable_receipt_path\timmutable_receipt_sha256\timmutable_receipt_dev\timmutable_receipt_ino\tcarrier_closure_identity\tcore_profile\tguest_build_recipe_sha256\n' \
  >"$sealed_loader_policy_tsv"
printf 'oliphaunt.wasix-postmaster.sealed-loader-policy.v2\t%s\t%s\t%s\t%s\t%s\t%s\tsanitized-then-explicit\t%s\t0\t0\t0\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$wasix_runtime_mode" "$require_zero_write_aot" \
  "$immutable_carrier_verification_scope" \
  "$([ "$require_zero_write_aot" -eq 1 ] && printf direct-immutable-only || printf compatibility)" \
  "$([ "$require_zero_write_aot" -eq 1 ] && printf 'OLIPHAUNT_WASIX_REQUIRE_ZERO_WRITE_AOT=1' || printf unset)" \
  "$([ "$require_zero_write_aot" -eq 1 ] && printf owned-per-target-jsonl || printf disabled)" \
  "$([ "$require_zero_write_aot" -eq 1 ] && printf direct-immutable-inode || printf unrestricted)" \
  "$FRESH_ROOT/bin/validate-sealed-loader-audit.py" \
  "$(fresh_wasmer_bin_hash "$FRESH_ROOT/bin/validate-sealed-loader-audit.py")" \
  "${immutable_carrier_receipt:-none}" "$immutable_carrier_receipt_sha256" \
  "$immutable_carrier_receipt_dev" "$immutable_carrier_receipt_ino" \
  "$immutable_carrier_closure_identity" "$immutable_carrier_core_profile" \
  "$immutable_carrier_guest_build_recipe_sha256" >>"$sealed_loader_policy_tsv"
sealed_loader_policy_identity="$(fresh_wasmer_bin_hash "$sealed_loader_policy_tsv")"
chmod 0444 "$sealed_loader_policy_tsv"
adaptive_cache_validator="$FRESH_ROOT/bin/validate-adaptive-file-cache-telemetry.py"
adaptive_cache_validator_sha256="$(fresh_wasmer_bin_hash "$adaptive_cache_validator")"
adaptive_cache_bound_manifest_sha256="${sealed_manifest_hash:-none}"
case "$adaptive_cache_evidence_policy" in
  portable-correctness-v1)
    adaptive_cache_claim_scope=portable-correctness
    adaptive_cache_required_host=any
    adaptive_cache_required_runtime_mode=any
    adaptive_cache_required_outcome=adaptive-active-or-observe-only-fallback
    adaptive_cache_required_class=none
    adaptive_cache_min_class_offers=0
    adaptive_cache_min_class_advice_calls=0
    adaptive_cache_min_class_advised_bytes=0
    adaptive_cache_max_sample_errors=unbounded
    adaptive_cache_max_clock_errors=unbounded
    adaptive_cache_max_advice_errors=unbounded
    adaptive_cache_max_psi_breaker_trips=unbounded
    adaptive_cache_max_refault_breaker_trips=unbounded
    adaptive_cache_max_deferred_wal_pin_errors=unbounded
    adaptive_cache_max_contended_wal_pin_failures=unbounded
    adaptive_cache_terminal_receipt=active-finalized-or-admission-fallback
    adaptive_cache_sample_scope_contract=not-required
    adaptive_cache_required_cgroup_binding=none
    adaptive_cache_required_limit_binding=none
    adaptive_cache_required_monotonic_window=none
    ;;
  constrained-linux-wal-action-v1)
    adaptive_cache_claim_scope=constrained-linux-performance
    adaptive_cache_required_host=Linux
    adaptive_cache_required_runtime_mode=sealed-headless
    adaptive_cache_required_outcome=adaptive-active
    adaptive_cache_required_class=6
    adaptive_cache_min_class_offers=1
    adaptive_cache_min_class_advice_calls=1
    adaptive_cache_min_class_advised_bytes=1
    adaptive_cache_max_sample_errors=0
    adaptive_cache_max_clock_errors=0
    adaptive_cache_max_advice_errors=0
    adaptive_cache_max_psi_breaker_trips=0
    adaptive_cache_max_refault_breaker_trips=0
    adaptive_cache_max_deferred_wal_pin_errors=0
    adaptive_cache_max_contended_wal_pin_failures=0
    adaptive_cache_terminal_receipt=active-finalized
    adaptive_cache_sample_scope_contract=required
    adaptive_cache_required_cgroup_binding=per-target-device-inode
    adaptive_cache_required_limit_binding=requested-equals-leaf-and-effective-min
    adaptive_cache_required_monotonic_window=launch-before-through-post-shutdown
    ;;
esac
printf 'schema_version\tacceptance_policy\tclaim_scope\trequired_host\tselected_host\trequired_runtime_mode\tselected_runtime_mode\tselected_memory_max\tselected_memory_high\tselected_swap_max\trequired_outcome\trequired_class\tmin_class_offers\tmin_class_advice_calls\tmin_class_advised_bytes\tmax_sample_errors\tmax_clock_errors\tmax_advice_errors\tmax_psi_breaker_trips\tmax_refault_breaker_trips\tmax_deferred_wal_pin_errors\tmax_contended_wal_pin_failures\tterminal_receipt\tvalidator_sha256\tsealed_manifest_sha256\tsample_scope_contract\trequired_cgroup_binding\trequired_limit_binding\trequired_monotonic_window\n' \
  >"$adaptive_cache_evidence_policy_tsv"
printf 'oliphaunt.wasix-postmaster.adaptive-cache-evidence-policy.v3\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$adaptive_cache_evidence_policy" "$adaptive_cache_claim_scope" \
  "$adaptive_cache_required_host" "$(uname -s)" \
  "$adaptive_cache_required_runtime_mode" "$wasix_runtime_mode" \
  "${cgroup_memory_max:-none}" "${cgroup_memory_high:-none}" \
  "${cgroup_swap_max:-none}" "$adaptive_cache_required_outcome" \
  "$adaptive_cache_required_class" "$adaptive_cache_min_class_offers" \
  "$adaptive_cache_min_class_advice_calls" \
  "$adaptive_cache_min_class_advised_bytes" \
  "$adaptive_cache_max_sample_errors" "$adaptive_cache_max_clock_errors" \
  "$adaptive_cache_max_advice_errors" \
  "$adaptive_cache_max_psi_breaker_trips" \
  "$adaptive_cache_max_refault_breaker_trips" \
  "$adaptive_cache_max_deferred_wal_pin_errors" \
  "$adaptive_cache_max_contended_wal_pin_failures" \
  "$adaptive_cache_terminal_receipt" "$adaptive_cache_validator_sha256" \
  "$adaptive_cache_bound_manifest_sha256" \
  "$adaptive_cache_sample_scope_contract" \
  "$adaptive_cache_required_cgroup_binding" \
  "$adaptive_cache_required_limit_binding" \
  "$adaptive_cache_required_monotonic_window" \
  >>"$adaptive_cache_evidence_policy_tsv"
adaptive_cache_evidence_policy_identity="$(
  fresh_wasmer_bin_hash "$adaptive_cache_evidence_policy_tsv"
)"
chmod 0444 "$adaptive_cache_evidence_policy_tsv"
instrumentation_lane=benchmark
wait_dump_policy=prohibited
wait_dump_fence_protocol=none
if [ "$wasix_lifecycle_plateau" -eq 1 ]; then
  lifecycle_policy_root="$(cd "$FRESH_ROOT/profiles/lifecycle-baselines" && pwd -P)"
  instrumentation_lane=untimed-lifecycle-diagnostic
  wait_dump_policy=fenced-only
  wait_dump_fence_protocol=wasix-runtime-fence-v1+wasix-runtime-fence-commit-v1
  if [ ! -f "$lifecycle_baseline_policy_source" ] ||
    [ -L "$lifecycle_baseline_policy_source" ]; then
    printf 'lifecycle baseline policy must be a regular non-symlink file: %s\n' \
      "$lifecycle_baseline_policy_source" >&2
    exit 2
  fi
  lifecycle_baseline_policy_source="$(realpath "$lifecycle_baseline_policy_source")" || exit
  case "$lifecycle_baseline_policy_source" in
    "$lifecycle_policy_root"/*) ;;
    *)
      printf 'lifecycle baseline policy must be checked in below %s: %s\n' \
        "$lifecycle_policy_root" "$lifecycle_baseline_policy_source" >&2
      exit 2
      ;;
  esac
  cp -- "$lifecycle_baseline_policy_source" "$lifecycle_baseline_policy_tsv"
  [ "$(sed -n '1p' "$lifecycle_baseline_policy_tsv")" = \
    $'schema_version\tpolicy_id\tpolicy_status\tclaim_scope\tbaseline_assumption\tfield\trule\tminimum\tmaximum' ] || {
    echo 'lifecycle baseline policy has an unexpected ordered schema' >&2
    exit 2
  }
  IFS=$'\t' read -r _ lifecycle_baseline_policy_id \
    lifecycle_baseline_policy_status lifecycle_baseline_claim_scope \
    lifecycle_baseline_assumption _ < <(sed -n '2p' "$lifecycle_baseline_policy_tsv")
  awk -F '\t' -v id="$lifecycle_baseline_policy_id" \
    -v status="$lifecycle_baseline_policy_status" \
    -v scope="$lifecycle_baseline_claim_scope" \
    -v assumption="$lifecycle_baseline_assumption" '
      NR == 1 { next }
      NF != 9 || $2 != id || $3 != status || $4 != scope || $5 != assumption { exit 1 }
      END { exit(NR > 1 ? 0 : 1) }
    ' "$lifecycle_baseline_policy_tsv" || {
    echo 'lifecycle baseline policy metadata is empty or inconsistent' >&2
    exit 2
  }
  lifecycle_baseline_policy_identity="$(
    fresh_wasmer_bin_hash "$lifecycle_baseline_policy_tsv"
  )"
fi
printf 'schema_version\tlane\twasix_perf_stats\twait_dump_policy\twait_dump_interval_ms\twait_dump_max_per_wait\twait_dump_verbose\tfence_protocol\tsanitized_environment\n' \
  >"$instrumentation_policy_tsv"
printf 'oliphaunt.wasix-postmaster.instrumentation.v1\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$instrumentation_lane" "$wasix_perf_stats" "$wait_dump_policy" \
  "$wasix_wait_dump_interval_ms" "$wasix_wait_dump_max_per_wait" \
  "$wasix_wait_dump_verbose" "$wait_dump_fence_protocol" \
  "${wait_dump_environment_names[*]}" >>"$instrumentation_policy_tsv"
instrumentation_policy_identity="$(fresh_sha256_stream <"$instrumentation_policy_tsv")"
chmod 0444 "$instrumentation_policy_tsv"

assert_frozen_adaptive_cache_evidence_policy() {
  local actual

  actual="$(fresh_wasmer_bin_hash "$instrumentation_policy_tsv")" || return
  [ "$actual" = "$instrumentation_policy_identity" ] || {
    echo 'instrumentation policy receipt changed during benchmark' >&2
    return 125
  }
  actual="$(fresh_wasmer_bin_hash "$adaptive_cache_evidence_policy_tsv")" || return
  [ "$actual" = "$adaptive_cache_evidence_policy_identity" ] || {
    echo 'adaptive cache evidence policy receipt changed during benchmark' >&2
    return 125
  }
  [ "$(fresh_wasmer_bin_hash "$adaptive_cache_validator")" = \
    "$adaptive_cache_validator_sha256" ] || {
    echo 'adaptive cache evidence validator changed during benchmark' >&2
    return 125
  }
  if [ "$wasix_runtime_mode" = sealed-headless ]; then
    [ "$(fresh_wasmer_bin_hash "$sealed_manifest")" = \
      "$adaptive_cache_bound_manifest_sha256" ] || {
      echo 'sealed manifest changed after adaptive cache policy binding' >&2
      return 125
    }
  fi
}

assert_frozen_lifecycle_baseline() {
  local actual

  [ "$wasix_lifecycle_plateau" -eq 1 ] || return 0
  actual="$(fresh_wasmer_bin_hash "$lifecycle_baseline_policy_tsv")" || return
  [ "$actual" = "$lifecycle_baseline_policy_identity" ] || {
    printf 'lifecycle baseline policy changed during benchmark: expected=%s actual=%s path=%s\n' \
      "$lifecycle_baseline_policy_identity" "$actual" \
      "$lifecycle_baseline_policy_tsv" >&2
    return 125
  }
  if [ -n "$lifecycle_baseline_binding_identity" ]; then
    actual="$(fresh_wasmer_bin_hash "$lifecycle_baseline_binding_tsv")" || return
    [ "$actual" = "$lifecycle_baseline_binding_identity" ] || {
      printf 'lifecycle baseline binding changed during benchmark: expected=%s actual=%s path=%s\n' \
        "$lifecycle_baseline_binding_identity" "$actual" \
        "$lifecycle_baseline_binding_tsv" >&2
      return 125
    }
    [ "$(fresh_wasmer_bin_hash "$wasmer_bin")" = \
      "$lifecycle_bound_wasmer_identity" ] || {
      echo 'Wasmer binary changed after lifecycle baseline binding' >&2
      return 125
    }
    [ "$(fresh_wasmer_bin_hash "$wasix_postgres_module")" = \
      "$lifecycle_bound_postgres_module_identity" ] || {
      echo 'PostgreSQL guest module changed after lifecycle baseline binding' >&2
      return 125
    }
    [ "${FRESH_POSTGRES_RUNTIME_FOOTPRINT_SHA256:-none}" = \
      "$lifecycle_bound_runtime_footprint_identity" ] &&
      [ "${FRESH_POSTGRES_DURABILITY_SHA256:-none}" = \
        "$lifecycle_bound_durability_identity" ] &&
      [ "${FRESH_POSTGRES_PROFILE_RESOLUTION_IDENTITY:-none}" = \
        "$lifecycle_bound_profile_resolution_identity" ] || {
      echo 'PostgreSQL profile identity changed after lifecycle baseline binding' >&2
      return 125
    }
    if [ "$wasix_runtime_mode" = sealed-headless ]; then
      fresh_verify_sealed_headless_carrier "$sealed_carrier_root" || return 125
      [ "$(fresh_wasmer_bin_hash "$sealed_manifest")" = \
        "$lifecycle_bound_carrier_manifest_identity" ] &&
        [ "$(fresh_wasmer_bin_hash "$sealed_receipt")" = \
          "$lifecycle_bound_carrier_receipt_identity" ] &&
        [ "$(fresh_wasmer_bin_hash "$sealed_payload_inventory")" = \
          "$lifecycle_bound_carrier_inventory_identity" ] || {
        echo 'sealed carrier changed after lifecycle baseline binding' >&2
        return 125
      }
    fi
  fi
}

write_lifecycle_baseline_binding() {
  local pending="$lifecycle_baseline_binding_tsv.pending.$$"
  local postgres_module_sha256 runtime_footprint_id runtime_footprint_sha256
  local durability_id durability_sha256 profile_identity
  local carrier_manifest carrier_receipt carrier_inventory

  [ "$wasix_lifecycle_plateau" -eq 1 ] || return 0
  assert_frozen_lifecycle_baseline || return
  postgres_module_sha256="$(fresh_wasmer_bin_hash "$wasix_postgres_module")" || return
  runtime_footprint_id="${runtime_footprint:-none}"
  runtime_footprint_sha256="${FRESH_POSTGRES_RUNTIME_FOOTPRINT_SHA256:-none}"
  durability_id="${durability_profile:-none}"
  durability_sha256="${FRESH_POSTGRES_DURABILITY_SHA256:-none}"
  profile_identity="${FRESH_POSTGRES_PROFILE_RESOLUTION_IDENTITY:-none}"
  carrier_manifest=none
  carrier_receipt=none
  carrier_inventory=none
  if [ "$wasix_runtime_mode" = sealed-headless ]; then
    carrier_manifest="$sealed_manifest_hash"
    carrier_receipt="$sealed_receipt_hash"
    carrier_inventory="$sealed_payload_inventory_hash"
  fi
  case "$runtime_footprint_id$runtime_footprint_sha256$durability_id$durability_sha256$profile_identity$wasix_runtime_mode$wasmer_bin_hash$postgres_module_sha256$carrier_manifest$carrier_receipt$carrier_inventory" in
    *$'\t'*|*$'\n'*|*$'\r'*)
      echo 'lifecycle baseline identity values may not contain control separators' >&2
      return 2
      ;;
  esac
  rm -f -- "$pending"
  {
    printf 'schema_version\tpolicy_id\tpolicy_sha256\tpolicy_status\tclaim_scope\tbaseline_assumption\tpostgres_major\truntime_footprint\truntime_footprint_sha256\tdurability_profile\tdurability_profile_sha256\tpostgres_profile_resolution_identity\truntime_mode\twasmer_bin_sha256\tpostgres_module_sha256\tcarrier_manifest_sha256\tcarrier_receipt_sha256\tcarrier_payload_inventory_sha256\n'
    printf 'oliphaunt.wasix-postmaster.lifecycle-baseline-binding.v1\t%s\t%s\t%s\t%s\t%s\t18\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$lifecycle_baseline_policy_id" "$lifecycle_baseline_policy_identity" \
      "$lifecycle_baseline_policy_status" "$lifecycle_baseline_claim_scope" \
      "$lifecycle_baseline_assumption" \
      "$runtime_footprint_id" "$runtime_footprint_sha256" \
      "$durability_id" "$durability_sha256" "$profile_identity" \
      "$wasix_runtime_mode" "$wasmer_bin_hash" "$postgres_module_sha256" \
      "$carrier_manifest" "$carrier_receipt" "$carrier_inventory"
  } >"$pending" || {
    rm -f -- "$pending"
    return 1
  }
  mv -f -- "$pending" "$lifecycle_baseline_binding_tsv" || {
    rm -f -- "$pending"
    return 1
  }
  lifecycle_baseline_binding_identity="$(
    fresh_wasmer_bin_hash "$lifecycle_baseline_binding_tsv"
  )"
  lifecycle_bound_wasmer_identity="$wasmer_bin_hash"
  lifecycle_bound_postgres_module_identity="$postgres_module_sha256"
  lifecycle_bound_runtime_footprint_identity="$runtime_footprint_sha256"
  lifecycle_bound_durability_identity="$durability_sha256"
  lifecycle_bound_profile_resolution_identity="$profile_identity"
  lifecycle_bound_carrier_manifest_identity="$carrier_manifest"
  lifecycle_bound_carrier_receipt_identity="$carrier_receipt"
  lifecycle_bound_carrier_inventory_identity="$carrier_inventory"
  assert_frozen_lifecycle_baseline
}

write_execution_identity() {
  local pending="$execution_identity_tsv.pending.$$"
  local carrier_identity=none manifest_identity=none receipt_identity=none
  local payload_identity=none headless_identity=none
  local postgres_module_identity profile_identity
  local runtime_footprint_id runtime_footprint_sha durability_id durability_sha

  [ "$need_wasix" -eq 1 ] || return 0
  if [ "$require_zero_write_aot" -eq 1 ]; then
    postgres_module_identity="$immutable_carrier_postgres_module_sha256"
  else
    postgres_module_identity="$(fresh_wasmer_bin_hash "$wasix_postgres_module")" || return
  fi
  profile_identity="${FRESH_POSTGRES_PROFILE_RESOLUTION_IDENTITY:-none}"
  runtime_footprint_id="${runtime_footprint:-none}"
  runtime_footprint_sha="${FRESH_POSTGRES_RUNTIME_FOOTPRINT_SHA256:-none}"
  durability_id="${durability_profile:-none}"
  durability_sha="${FRESH_POSTGRES_DURABILITY_SHA256:-none}"
  if [ "$wasix_runtime_mode" = sealed-headless ]; then
    if [ "$require_zero_write_aot" -eq 1 ]; then
      "$FRESH_ROOT/bin/verify-immutable-sealed-carrier.sh" \
        --sealed-carrier "$sealed_carrier_root" \
        --receipt "$immutable_carrier_receipt" --fast || return
    else
      fresh_capture_qualification_carrier_identity "$sealed_carrier_root" || return
    fi
    carrier_identity="$FRESH_QUALIFICATION_CARRIER_CLOSURE_IDENTITY"
    manifest_identity="$FRESH_QUALIFICATION_CARRIER_MANIFEST_SHA256"
    receipt_identity="$FRESH_QUALIFICATION_CARRIER_RECEIPT_SHA256"
    payload_identity="$FRESH_QUALIFICATION_CARRIER_PAYLOAD_SHA256"
    headless_identity="$FRESH_QUALIFICATION_CARRIER_HEADLESS_SHA256"
    [ "$headless_identity" = "$wasmer_bin_hash" ] || {
      echo 'sealed carrier identity does not match selected Wasmer binary' >&2
      return 125
    }
  fi
  rm -f -- "$pending"
  {
    printf 'schema_version\tpostgres_major\truntime_mode\tcarrier_closure_identity\tcarrier_manifest_sha256\tcarrier_receipt_sha256\tcarrier_payload_inventory_sha256\tcarrier_headless_sha256\twasmer_bin_sha256\tpostgres_module_sha256\truntime_footprint\truntime_footprint_sha256\tdurability_profile\tdurability_profile_sha256\tpostgres_profile_resolution_identity\n'
    printf 'oliphaunt.wasix-postmaster.execution-identity.v1\t18\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$wasix_runtime_mode" "$carrier_identity" "$manifest_identity" \
      "$receipt_identity" "$payload_identity" "$headless_identity" \
      "$wasmer_bin_hash" "$postgres_module_identity" \
      "$runtime_footprint_id" "$runtime_footprint_sha" \
      "$durability_id" "$durability_sha" "$profile_identity"
  } >"$pending" || {
    rm -f -- "$pending"
    return 1
  }
  mv -f -- "$pending" "$execution_identity_tsv" || {
    rm -f -- "$pending"
    return 1
  }
  execution_identity_sha256="$(fresh_wasmer_bin_hash "$execution_identity_tsv")"
  execution_bound_carrier_identity="$carrier_identity"
  execution_bound_manifest_identity="$manifest_identity"
  execution_bound_receipt_identity="$receipt_identity"
  execution_bound_payload_identity="$payload_identity"
  execution_bound_headless_identity="$headless_identity"
  execution_bound_wasmer_identity="$wasmer_bin_hash"
  execution_bound_postgres_module_identity="$postgres_module_identity"
  execution_bound_profile_identity="$profile_identity"
}

assert_frozen_execution_identity() {
  local observed receipt_stat receipt_dev receipt_ino

  [ "$need_wasix" -eq 1 ] || return 0
  [ -n "$execution_identity_sha256" ] || {
    echo 'WASIX execution identity was not captured before launch' >&2
    return 125
  }
  observed="$(fresh_wasmer_bin_hash "$execution_identity_tsv")" || return
  [ "$observed" = "$execution_identity_sha256" ] || {
    echo 'WASIX execution identity receipt changed after capture' >&2
    return 125
  }
  if [ "$require_zero_write_aot" -eq 1 ]; then
    [ "$wasmer_bin_hash" = "$execution_bound_wasmer_identity" ] &&
      [ "$immutable_carrier_postgres_module_sha256" = \
        "$execution_bound_postgres_module_identity" ] &&
      [ "${FRESH_POSTGRES_PROFILE_RESOLUTION_IDENTITY:-none}" = \
        "$execution_bound_profile_identity" ] || {
      echo 'runtime/module/profile identity changed after execution receipt capture' >&2
      return 125
    }
  else
    [ "$(fresh_wasmer_bin_hash "$wasmer_bin")" = \
      "$execution_bound_wasmer_identity" ] &&
      [ "$(fresh_wasmer_bin_hash "$wasix_postgres_module")" = \
        "$execution_bound_postgres_module_identity" ] &&
      [ "${FRESH_POSTGRES_PROFILE_RESOLUTION_IDENTITY:-none}" = \
        "$execution_bound_profile_identity" ] || {
      echo 'runtime/module/profile identity changed after execution receipt capture' >&2
      return 125
    }
  fi
  if [ "$wasix_runtime_mode" = sealed-headless ]; then
    fresh_sealed_executor_selection "$sealed_carrier_root" || return 125
    [ "$FRESH_SEALED_EXECUTOR_ROLE" = "$sealed_executor_role" ] &&
      [ "$FRESH_SEALED_EXECUTOR_RECEIPT_RELATIVE" = \
        "$sealed_executor_receipt_relative" ] &&
      [ "$FRESH_SEALED_EXECUTOR_RECEIPT_SHA256" = \
        "$sealed_executor_receipt_hash" ] &&
      [ "$FRESH_SEALED_EXECUTOR_SHA256" = "$sealed_executor_hash" ] || {
      echo 'sealed executor role selection changed after execution receipt capture' >&2
      return 125
    }
    if [ "$require_zero_write_aot" -eq 1 ]; then
      "$FRESH_ROOT/bin/verify-immutable-sealed-carrier.sh" \
        --sealed-carrier "$sealed_carrier_root" \
        --receipt "$immutable_carrier_receipt" --fast || return 125
    else
      fresh_capture_qualification_carrier_identity "$sealed_carrier_root" || return 125
    fi
    [ "$FRESH_QUALIFICATION_CARRIER_CLOSURE_IDENTITY" = \
      "$execution_bound_carrier_identity" ] &&
      [ "$FRESH_QUALIFICATION_CARRIER_MANIFEST_SHA256" = \
        "$execution_bound_manifest_identity" ] &&
      [ "$FRESH_QUALIFICATION_CARRIER_RECEIPT_SHA256" = \
        "$execution_bound_receipt_identity" ] &&
      [ "$FRESH_QUALIFICATION_CARRIER_PAYLOAD_SHA256" = \
        "$execution_bound_payload_identity" ] &&
      [ "$FRESH_QUALIFICATION_CARRIER_HEADLESS_SHA256" = \
        "$execution_bound_headless_identity" ] || {
      echo 'sealed carrier changed after execution receipt capture' >&2
      return 125
    }
    if [ "$require_zero_write_aot" -eq 1 ]; then
      receipt_stat="$(stat -c '%d %i' -- "$immutable_carrier_receipt")" || return
      read -r receipt_dev receipt_ino <<<"$receipt_stat"
      [ "$receipt_dev" = "$immutable_carrier_receipt_dev" ] &&
        [ "$receipt_ino" = "$immutable_carrier_receipt_ino" ] || {
        echo 'immutable carrier deployment receipt inode changed after preflight' >&2
        return 125
      }
      [ "$FRESH_QUALIFICATION_CARRIER_CLOSURE_IDENTITY" = \
        "$immutable_carrier_closure_identity" ] || {
        echo 'immutable carrier closure changed after deployment preflight' >&2
        return 125
      }
    fi
  fi
}
printf 'schema_version\tenabled\tmax_peak_pss_kib\tmax_peak_pss_anon_kib\tmax_peak_page_table_kib\tmax_cgroup_high_events_delta\tmax_psi_some_stall_fraction\tmax_psi_full_stall_fraction\n' \
  >"$memory_budget_tsv"
printf 'oliphaunt.wasix-postmaster.memory-budget.v1\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$memory_budget_requested" "$max_peak_pss_kib" "$max_peak_pss_anon_kib" \
  "$max_peak_page_table_kib" "$max_cgroup_high_events_delta" \
  "$max_psi_some_stall_fraction" "$max_psi_full_stall_fraction" \
  >>"$memory_budget_tsv"
memory_budget_identity="$(fresh_sha256_stream <"$memory_budget_tsv")"
assert_frozen_memory_budget() {
  local actual
  actual="$(fresh_sha256_stream <"$memory_budget_tsv")" || return
  [ "$actual" = "$memory_budget_identity" ] || {
    printf 'memory budget receipt changed during benchmark: expected=%s actual=%s path=%s\n' \
      "$memory_budget_identity" "$actual" "$memory_budget_tsv" >&2
    return 125
  }
}
if [ "$profile_resolution_active" -eq 1 ]; then
  fresh_write_postgres_profile_evidence \
    "$postgres_profile_inputs_tsv" "$postgres_profile_resolution_tsv"
fi
if [ "$libpq_latency_samples" -gt 0 ]; then
  build_libpq_latency_probe "$suite_root/libpq-latency-probe"
fi

fresh_write_report_header "$summary" "WASIX Concurrent Query Suite"
{
  printf -- '- Targets: `%s`\n' "${targets[*]}"
  printf -- '- Measurement-tool closure mode: `%s`\n' \
    "$measurement_tool_closure_mode"
  printf -- '- Measurement-tool closure required: `%s`\n' \
    "$require_frozen_measurement_tools"
  printf -- '- Measurement-tool closure identity: `%s`\n' \
    "$measurement_tool_closure_identity"
  printf -- '- Measurement-tool manifest SHA-256: `%s`\n' \
    "$measurement_tool_closure_manifest_sha256"
  printf -- '- Measurement-tool evidence: `%s` (`%s`)\n' \
    "$measurement_tool_closure_tsv" \
    "$measurement_tool_closure_evidence_identity"
  if [ "${#workloads[@]}" -gt 0 ]; then
    printf -- '- Workloads: `%s`\n' "${workloads[*]}"
  else
    printf -- '- Workloads: `(none; libpq latency only)`\n'
  fi
  printf -- '- Connections: `%s`\n' "$connections"
  printf -- '- Bulk fanout population: `clients connected before timed start; backends retained through untimed drain`\n'
  printf -- '- Iterations per connection: `%s`\n' "$iterations"
  printf -- '- Requested seed rows: `%s`\n' "$row_count"
  printf -- '- Actual setup rows: `%s`\n' "$setup_rows"
  printf -- '- Timeout: `%s seconds`\n' "$timeout_seconds"
  printf -- '- Timed-command supervision: `dedicated process group; SIGTERM then SIGKILL; direct child reaped; no live group accepted`\n'
  printf -- '- Process SIGTERM/SIGKILL grace: `%s ms` / `%s ms`\n' \
    "$process_term_grace_ms" "$process_kill_grace_ms"
  printf -- '- Resource sample interval: `%s seconds`\n' "$resource_sample_interval"
  printf -- '- Resource sampler detail: `%s`\n' "$resource_detail"
  if [ "$need_wasix" -eq 1 ]; then
    printf -- '- WASIX shared-memory provider: `%s`\n' \
      "$shared_memory_provider"
    printf -- '- Shared-memory provider activation: `%s`\n' \
      "$([ "$shared_memory_provider_explicit" -eq 1 ] && printf explicit-cli || printf default-portable)"
    printf -- '- Shared-memory provider evidence: `%s/wasix/shared-memory-{provider,objects,release,cleanup}.json`\n' \
      "$report_dir"
    printf -- '- Shared-memory provider claim: `diagnostic backing-substrate A/B; no cross-platform support claim`\n'
  fi
  printf -- '- Server cgroup MemoryMax: `%s`\n' "${cgroup_memory_max:-unset}"
  printf -- '- Server cgroup MemoryHigh: `%s`\n' "${cgroup_memory_high:-unset}"
  printf -- '- Server cgroup MemorySwapMax: `%s`\n' "${cgroup_swap_max:-unset}"
  printf -- '- Cold ownership startup lane: `%s`\n' "$cold_ownership"
  if [ "$cold_ownership" -eq 1 ]; then
    printf -- '- Cold ownership lifecycle mode: `%s`\n' "$cold_ownership_mode"
    printf -- '- Cold ownership mode evidence: `%s`\n' "$cold_ownership_mode_tsv"
    printf -- '- Cold boundary: `content SHA-256 + per-file fdatasync + POSIX_FADV_DONTNEED + zero-page mincore proof`\n'
    printf -- '- Cold accounting: `first carrier/PGDATA faults occur after launch in the fresh measured cgroup; no global drop_caches`\n'
  fi
  printf -- '- Memory performance budgets enabled: `%s`\n' "$memory_budget_requested"
  printf -- '- Maximum fan-out peak PSS: `%s KiB`\n' "${max_peak_pss_kib:-unset}"
  printf -- '- Maximum fan-out peak anonymous PSS: `%s KiB`\n' \
    "${max_peak_pss_anon_kib:-unset}"
  printf -- '- Maximum fan-out peak page tables: `%s KiB`\n' \
    "${max_peak_page_table_kib:-unset}"
  printf -- '- Maximum fan-out cgroup high-event delta: `%s`\n' \
    "${max_cgroup_high_events_delta:-unset}"
  printf -- '- Maximum fan-out PSI some-stall fraction: `%s`\n' \
    "${max_psi_some_stall_fraction:-unset}"
  printf -- '- Maximum fan-out PSI full-stall fraction: `%s`\n' \
    "${max_psi_full_stall_fraction:-unset}"
  printf -- '- Memory budget receipt: `%s`\n' "$memory_budget_tsv"
  printf -- '- Memory budget identity: `%s`\n' "$memory_budget_identity"
  printf -- '- Instrumentation policy receipt: `%s`\n' "$instrumentation_policy_tsv"
  printf -- '- Instrumentation policy identity: `%s`\n' "$instrumentation_policy_identity"
  printf -- '- Adaptive cache evidence policy: `%s`\n' \
    "$adaptive_cache_evidence_policy"
  printf -- '- Adaptive cache evidence policy receipt: `%s` (`%s`)\n' \
    "$adaptive_cache_evidence_policy_tsv" \
    "$adaptive_cache_evidence_policy_identity"
  printf -- '- Post-readiness/workload quiescence: `%s seconds`\n' "$quiescence_seconds"
  printf -- '- Checkpoint policy: `%s`\n' "$checkpoint_policy"
  printf -- '- Runtime footprint: `%s`\n' "${runtime_footprint:-none}"
  printf -- '- Runtime-footprint SHA-256: `%s`\n' \
    "${FRESH_POSTGRES_RUNTIME_FOOTPRINT_SHA256:-}"
  printf -- '- Durability profile: `%s`\n' "${durability_profile:-none}"
  printf -- '- Durability-profile SHA-256: `%s`\n' \
    "${FRESH_POSTGRES_DURABILITY_SHA256:-}"
  printf -- '- PostgreSQL profile resolution identity: `%s`\n' \
    "${FRESH_POSTGRES_PROFILE_RESOLUTION_IDENTITY:-}"
  printf -- '- Native libpq true-latency measured samples per mode: `%s`\n' "$libpq_latency_samples"
  printf -- '- Native libpq true-latency warmup samples per mode: `%s`\n' "$libpq_latency_warmup"
  printf -- '- Native libpq true-latency only: `%s`\n' "$libpq_latency_only"
  printf -- '- Native libpq true-latency clock: `CLOCK_MONOTONIC nanoseconds`\n'
  printf -- '- Native libpq true-latency modes: `persistent times PQexec(SELECT 1); reconnect times PQconnectdb -> SELECT 1 -> PQfinish`\n'
  printf -- '- Native libpq true-latency percentiles: `nearest rank over exact valid measured rows; warmups excluded`\n'
  printf -- '- Native libpq true-latency isolation: `not psql bulk batch wall time and not bulk residual`\n'
  printf -- '- Native libpq true-latency server soft RLIMIT_NOFILE: `%s` (hard limit preserved)\n' \
    "$libpq_latency_soft_nofile"
  printf -- '- Native libpq reconnect quiescent host-FD growth allowance: `%s`\n' \
    "$libpq_latency_host_fd_allowance"
  if [ "$libpq_latency_samples" -gt 0 ]; then
    printf -- '- Native libpq latency probe: `%s`\n' "$libpq_latency_probe_bin"
    printf -- '- Native libpq latency probe SHA-256: `%s`\n' "$libpq_latency_probe_sha256"
    printf -- '- Native libpq latency probe source SHA-256: `%s`\n' "$libpq_latency_probe_source_sha256"
    printf -- '- Native libpq latency probe compiler: `%s`\n' "$libpq_latency_compiler"
    printf -- '- Native libpq latency shared library: `%s`\n' "$libpq_latency_libpq_path"
    printf -- '- Native libpq latency shared-library SHA-256: `%s`\n' "$libpq_latency_libpq_sha256"
  fi
  printf -- '- Discard successful PGDATA: `%s`\n' "$discard_pgdata"
  printf -- '- Linux memory diagnostics: `PSS` with overlapping anon/file/shmem, private, and mapped-shared breakdowns (never additive)\n'
  printf -- '- Resource timestamps: `CLOCK_MONOTONIC milliseconds (not Unix epoch)`\n'
  printf -- '- Cgroup scope accounting: `memory.current includes charged page cache and kernel memory; process PSS does not`\n'
  printf -- '- Cgroup memory.stat accounting: `exact raw keys; overlapping gauges and aggregate/component counters are never summed`\n'
  printf -- '- Cgroup phase metrics: `sampled current gauges and gauge peaks; cumulative file-cache counters retain phase start/end plus first-to-last delta/rate`\n'
  printf -- '- Cgroup optional-key semantics: `missing kernel memory.stat keys are blank and named explicitly; blank never means zero`\n'
  printf -- '- Cgroup whole-run metrics: `scope-lifetime peaks plus observed cumulative events/pressure totals; memory.events.local is used only for a leaf scope and the selected event file is evidence-bound`\n'
  printf -- '- Cgroup memory.pressure totals: `absolute cumulative stall microseconds observed in the fresh transient scope (maximum observed), not interval deltas or percentages`\n'
  printf -- '- Host open-FD occupancy: `Linux /proc entries summed over the sampled native process tree or singleton Wasmer process; host capacity occupancy, not a guest FD number or unique underlying open file descriptions; blank totals plus status distinguish unavailable observations from zero`\n'
  printf -- '- PostgreSQL wait sample interval: `%s seconds`\n' "$pg_wait_sample_interval"
  printf -- '- PostgreSQL wait sampler: `persistent-connection`\n'
  printf -- '- WASIX perf stats: `%s`\n' "$wasix_perf_stats"
  printf -- '- WASIX wait dump interval: `%s ms`\n' "$wasix_wait_dump_interval_ms"
  printf -- '- WASIX wait dump max per wait: `%s`\n' "$wasix_wait_dump_max_per_wait"
  printf -- '- WASIX wait dump verbose detail: `%s`\n' "$wasix_wait_dump_verbose"
  printf -- '- WASIX lifecycle plateau lane: `%s`\n' "$wasix_lifecycle_plateau"
  printf -- '- WASIX lifecycle reconnects: `%s`\n' "$wasix_lifecycle_reconnects"
  printf -- '- WASIX lifecycle sampling window: `%s seconds`\n' \
    "$wasix_lifecycle_window_seconds"
  printf -- '- WASIX lifecycle memory checkpoint interval: `%s reconnects`\n' \
    "$wasix_lifecycle_memory_checkpoint_every"
  printf -- '- WASIX lifecycle memory checkpoint quiescence: `%s seconds`\n' \
    "$wasix_lifecycle_memory_quiescence_seconds"
  printf -- '- WASIX lifecycle PSS / Pss_Anon / heap growth ceilings: `%s / %s / %s KiB`\n' \
    "${max_lifecycle_pss_growth_kib:-unset}" \
    "${max_lifecycle_pss_anon_growth_kib:-unset}" \
    "${max_lifecycle_heap_growth_kib:-unset}"
  printf -- '- WASIX lifecycle late-tail PSS / Pss_Anon / heap Theil-Sen slope ceilings: `%s / %s / %s KiB per 1000 reconnects`\n' \
    "${max_late_lifecycle_pss_slope_kib_per_1000:-unset}" \
    "${max_late_lifecycle_pss_anon_slope_kib_per_1000:-unset}" \
    "${max_late_lifecycle_heap_slope_kib_per_1000:-unset}"
  printf -- '- WASIX lifecycle memory sampling: `untimed reconnect boundaries only; no smaps read overlaps a client; baseline/final runtime-fenced`\n'
  printf -- '- WASIX lifecycle stabilization: `pg_log_standby_snapshot -> walwriter pg_stat_io write/byte advance -> target LSN flushed`\n'
  printf -- '- Memory map snapshots: `%s`\n' "$memory_map_snapshots"
  printf -- '- WASIX sample seconds: `%s`\n' "$sample_seconds"
  printf -- '- WASIX sample delay: `%s`\n' "$sample_delay"
  printf -- '- Start port: `%s`\n' "$start_port"
  printf -- '- WASIX core profile: `%s`\n' "$WASIX_CORE_PROFILE"
  printf -- '- WASIX runtime mode: `%s`\n' "$wasix_runtime_mode"
  if [ "$wasix_runtime_mode" = "sealed-headless" ]; then
    printf -- '- Sealed carrier: `%s`\n' "$sealed_carrier_root"
    printf -- '- Sealed manifest SHA-256: `%s`\n' "$sealed_manifest_hash"
    printf -- '- Sealed receipt SHA-256: `%s`\n' "$sealed_receipt_hash"
    printf -- '- Sealed payload inventory SHA-256: `%s`\n' "$sealed_payload_inventory_hash"
  else
    printf -- '- WASIX install dir: `%s`\n' "$WASIX_INSTALL_DIR"
  fi
  printf -- '- Pinned runtime: `%s`\n' "${FRESH_PINNED_RUNTIME_NAME:-}"
  printf -- '- Effective PostgreSQL GUCs: `%s`\n' "${effective_postgres_gucs[*]:-}"
  if [ "$profile_resolution_active" -eq 1 ]; then
    printf -- '- PostgreSQL profile inputs: `%s`\n' "$postgres_profile_inputs_tsv"
    printf -- '- PostgreSQL profile resolution: `%s`\n' "$postgres_profile_resolution_tsv"
  fi
  printf -- '- Extra Wasmer args: `%s`\n' "${wasmer_extra_args[*]:-}"
  printf -- '- Summary TSV: `%s`\n' "$summary_tsv"
  printf -- '- Client TSV: `%s`\n' "$client_tsv"
  printf -- '- Resource TSV: `%s`\n' "$resource_tsv"
  printf -- '- Checkpoint TSV: `%s`\n' "$checkpoint_tsv"
  printf -- '- Native libpq latency TSV: `%s`\n\n' "$libpq_latency_tsv"
  printf -- '- Host FD checkpoints TSV: `%s`\n' "$host_fd_checkpoints_tsv"
  printf -- '- Server limits TSV: `%s`\n' "$server_limits_tsv"
  printf -- '- Server lifecycle TSV: `%s`\n' "$server_lifecycle_tsv"
  printf -- '- Memory evidence TSV: `%s`\n\n' "$memory_evidence_tsv"
  printf -- '- Memory budget TSV: `%s`\n\n' "$memory_budget_tsv"
  if [ "$cold_ownership" -eq 1 ]; then
    printf -- '- Cold sample: `%s`\n\n' "$report_dir/wasix/cold-ownership-sample.tsv"
  fi
  if [ "$wasix_lifecycle_plateau" -eq 1 ]; then
    printf -- '- WASIX lifecycle plateau TSV: `%s`\n\n' "$lifecycle_plateau_tsv"
    printf -- '- WASIX lifecycle baseline policy: `%s` (`%s`)\n' \
      "$lifecycle_baseline_policy_tsv" "$lifecycle_baseline_policy_identity"
    printf -- '- WASIX lifecycle baseline policy ID/status/scope: `%s` / `%s` / `%s`\n' \
      "$lifecycle_baseline_policy_id" "$lifecycle_baseline_policy_status" \
      "$lifecycle_baseline_claim_scope"
    if [ "$wasix_lifecycle_memory_checkpoint_every" -gt 0 ]; then
      printf -- '- WASIX lifecycle memory checkpoints: `%s`\n' \
        "$lifecycle_memory_checkpoints_tsv"
      printf -- '- WASIX lifecycle memory plateau: `%s`\n\n' \
        "$lifecycle_memory_plateau_tsv"
    fi
  fi
} >>"$summary"

printf 'target\tworkload\tstatus\tconnections\titerations\toperation_count\tverified_count\texpected_verify_count\tfanout_wall_ms\tthroughput_ops_per_sec\tok_clients\tfailed_clients\ttimed_out\tepoll_intr_count\tserver_log\treport_dir\n' >"$summary_tsv"
printf 'target\tworkload\tclient\tstatus\tbulk_batch_wall_ms\tbulk_batch_psql_time_sum_ms\tbulk_batch_psql_time_count\tlog\n' >"$client_tsv"
printf 'target\tphase\tpeak_rss_kb\tpeak_rss_mb\tpeak_vsz_kb\tpeak_cpu_percent\tpeak_process_count\tsample_count\tsamples_log\tpeak_pss_kb\tpeak_pss_mb\tpeak_pss_anon_kb\tpeak_pss_anon_mb\tpeak_pss_file_kb\tpeak_pss_file_mb\tpeak_pss_shmem_kb\tpeak_pss_shmem_mb\tpeak_private_kb\tpeak_private_mb\tpeak_shared_mapped_kb\tpeak_shared_mapped_mb\tpeak_anonymous_mapped_kb\tpeak_anonymous_mapped_mb\tpeak_swap_kb\tsmaps_sample_count\tpeak_host_thread_count\tpeak_page_table_kb\tpeak_page_table_mb\tpeak_private_clean_kb\tpeak_private_clean_mb\tpeak_private_dirty_kb\tpeak_private_dirty_mb\tcgroup_path\tphase_sampled_peak_cgroup_memory_current_bytes\tphase_sampled_peak_cgroup_memory_current_mb\twhole_run_observed_cgroup_memory_peak_bytes\twhole_run_observed_cgroup_memory_peak_mb\tphase_sampled_peak_cgroup_swap_current_bytes\tphase_sampled_peak_cgroup_swap_current_mb\twhole_run_observed_cgroup_swap_peak_bytes\twhole_run_observed_cgroup_swap_peak_mb\tphase_sampled_peak_cgroup_pids_current\twhole_run_observed_cgroup_event_high_total\twhole_run_observed_cgroup_event_max_total\twhole_run_observed_cgroup_event_oom_total\twhole_run_observed_cgroup_event_oom_kill_total\tcgroup_memory_max\tcgroup_memory_high\tcgroup_swap_max\tphase_sampled_peak_cgroup_memory_stat_anon_bytes\tphase_sampled_peak_cgroup_memory_stat_anon_mb\tphase_sampled_peak_cgroup_memory_stat_file_bytes\tphase_sampled_peak_cgroup_memory_stat_file_mb\tphase_sampled_peak_cgroup_memory_stat_shmem_bytes\tphase_sampled_peak_cgroup_memory_stat_shmem_mb\tphase_sampled_peak_cgroup_memory_stat_kernel_bytes\tphase_sampled_peak_cgroup_memory_stat_kernel_mb\tphase_sampled_peak_cgroup_memory_stat_pagetables_bytes\tphase_sampled_peak_cgroup_memory_stat_pagetables_mb\tphase_sampled_peak_cgroup_memory_stat_slab_bytes\tphase_sampled_peak_cgroup_memory_stat_slab_mb\tphase_sampled_peak_cgroup_memory_stat_file_dirty_bytes\tphase_sampled_peak_cgroup_memory_stat_file_dirty_mb\tphase_sampled_peak_cgroup_memory_stat_file_writeback_bytes\tphase_sampled_peak_cgroup_memory_stat_file_writeback_mb\twhole_run_observed_cgroup_memory_pressure_some_total_usec\twhole_run_observed_cgroup_memory_pressure_full_total_usec\tphase_sampled_peak_host_open_fd_count\tphase_host_open_fd_valid_sample_count\tphase_host_open_fd_unsupported_sample_count\tphase_host_open_fd_unreadable_sample_count\tphase_host_open_fd_raced_sample_count\tphase_smaps_valid_sample_count\tphase_smaps_unsupported_sample_count\tphase_smaps_disabled_sample_count\tphase_smaps_unreadable_sample_count\tphase_smaps_raced_sample_count\tphase_cgroup_valid_sample_count\tphase_cgroup_disabled_sample_count\tphase_cgroup_unavailable_sample_count\tphase_sampled_peak_cgroup_memory_stat_active_file_bytes\tphase_sampled_peak_cgroup_memory_stat_active_file_mb\tphase_sampled_peak_cgroup_memory_stat_inactive_file_bytes\tphase_sampled_peak_cgroup_memory_stat_inactive_file_mb\tphase_sampled_peak_cgroup_memory_stat_file_mapped_bytes\tphase_sampled_peak_cgroup_memory_stat_file_mapped_mb\tphase_cgroup_memory_stat_file_cache_status\tphase_cgroup_memory_stat_file_cache_missing_keys\twhole_run_observed_cgroup_memory_events_source\tphase_observed_cgroup_memory_stat_counter_elapsed_ms\tphase_observed_cgroup_memory_stat_workingset_refault_file_pages_start\tphase_observed_cgroup_memory_stat_workingset_refault_file_pages_end\tphase_observed_cgroup_memory_stat_workingset_refault_file_pages_delta\tphase_observed_cgroup_memory_stat_workingset_refault_file_pages_per_second\tphase_observed_cgroup_memory_stat_workingset_activate_file_pages_start\tphase_observed_cgroup_memory_stat_workingset_activate_file_pages_end\tphase_observed_cgroup_memory_stat_workingset_activate_file_pages_delta\tphase_observed_cgroup_memory_stat_workingset_activate_file_pages_per_second\tphase_observed_cgroup_memory_stat_workingset_restore_file_pages_start\tphase_observed_cgroup_memory_stat_workingset_restore_file_pages_end\tphase_observed_cgroup_memory_stat_workingset_restore_file_pages_delta\tphase_observed_cgroup_memory_stat_workingset_restore_file_pages_per_second\tphase_observed_cgroup_memory_stat_pgscan_pages_start\tphase_observed_cgroup_memory_stat_pgscan_pages_end\tphase_observed_cgroup_memory_stat_pgscan_pages_delta\tphase_observed_cgroup_memory_stat_pgscan_pages_per_second\tphase_observed_cgroup_memory_stat_pgsteal_pages_start\tphase_observed_cgroup_memory_stat_pgsteal_pages_end\tphase_observed_cgroup_memory_stat_pgsteal_pages_delta\tphase_observed_cgroup_memory_stat_pgsteal_pages_per_second\n' >"$resource_tsv"
printf 'target\tworkload\tpolicy\tstatus\tnum_timed_before\tnum_timed_after\tnum_timed_delta\tnum_requested_before\tnum_requested_after\tnum_requested_delta\tnum_done_before\tnum_done_after\tnum_done_delta\twal_bytes_before\twal_bytes_after\twal_bytes_delta\twal_budget_bytes\tstate_before\tstate_after\tio_before\tio_after\tio_delta\tio_delta_status\n' >"$checkpoint_tsv"
printf 'schema_version\ttarget\tmode\tstatus\tclock\twarmup_count\tsample_count\tp50_ns\tp95_ns\tp99_ns\tp50_ms\tp95_ms\tp99_ms\traw_tsv\tlibpq_path\tlibpq_sha256\tprobe_sha256\n' >"$libpq_latency_tsv"
printf 'target\tmode\tstage\tmonotonic_ms\ttotal_open_fds\tobserved_processes\texpected_processes\tstatus\n' >"$host_fd_checkpoints_tsv"
printf 'target\tmode\tbefore_open_fds\tafter_open_fds\tquiescent_open_fds\tquiescent_growth\tallowance\tstatus\n' >"$host_fd_churn_tsv"
printf 'target\trequested_soft_nofile\tpre_soft_nofile\tpre_hard_nofile\tactual_soft_nofile\tactual_hard_nofile\tstatus\tlaunch_record\n' >"$server_limits_tsv"
printf 'target\tserver_pid\tserver_pgid\tserver_birth_identity\tcgroup_path\tcgroup_identity\torderly_int\tforced\twait_status\tclean_shutdown_marker\tprocess_group_residue\tcgroup_residue\tport_residue\tstatus\treport\n' >"$server_lifecycle_tsv"
printf 'target\tstatus\tdetail\tsamples\n' >"$memory_evidence_tsv"

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

active_server_pids=()
active_server_pgids=()
active_server_identities=()
active_server_ports=()
active_server_cgroup_dirs=()
active_server_cgroup_identities=()
active_background_pids=()
active_client_pids=()
active_client_pgids=()
active_shared_memory_records=()
pending_shared_memory_records=()

register_server_pid() {
  active_server_pids+=("$1")
  active_server_pgids+=("$2")
  active_server_identities+=("$3")
  active_server_ports+=("$4")
  active_server_cgroup_dirs+=("$5")
  active_server_cgroup_identities+=("$6")
}

unregister_server_pid() {
  local remove_pid="$1"
  local pid index
  local remaining=()
  local remaining_pgids=() remaining_identities=() remaining_ports=()
  local remaining_cgroup_dirs=() remaining_cgroup_identities=()
  for index in "${!active_server_pids[@]}"; do
    pid="${active_server_pids[$index]}"
    if [ "$pid" != "$remove_pid" ]; then
      remaining+=("$pid")
      remaining_pgids+=("${active_server_pgids[$index]}")
      remaining_identities+=("${active_server_identities[$index]}")
      remaining_ports+=("${active_server_ports[$index]}")
      remaining_cgroup_dirs+=("${active_server_cgroup_dirs[$index]}")
      remaining_cgroup_identities+=("${active_server_cgroup_identities[$index]}")
    fi
  done
  active_server_pids=("${remaining[@]}")
  active_server_pgids=("${remaining_pgids[@]}")
  active_server_identities=("${remaining_identities[@]}")
  active_server_ports=("${remaining_ports[@]}")
  active_server_cgroup_dirs=("${remaining_cgroup_dirs[@]}")
  active_server_cgroup_identities=("${remaining_cgroup_identities[@]}")
}

register_external_shared_memory_provider() {
  local field record existing provider root evidence evidence_sha256
  local cleanup_evidence exit_objects exit_release extra
  [ "$#" -eq 7 ] || {
    echo 'external shared-memory registration requires seven fields' >&2
    return 125
  }
  for field in "$@"; do
    case "$field" in
      ''|*$'\t'*|*$'\n'*|*$'\r'*)
        echo 'external shared-memory registration contains an unsafe field' >&2
        return 125
        ;;
    esac
  done
  record="$1"$'\t'"$2"$'\t'"$3"$'\t'"$4"$'\t'"$5"$'\t'"$6"$'\t'"$7"
  for existing in "${active_shared_memory_records[@]}"; do
    IFS=$'\t' read -r provider root evidence evidence_sha256 cleanup_evidence \
      exit_objects exit_release extra <<<"$existing"
    [ -z "$extra" ] || return 125
    if [ "$root" = "$2" ]; then
      [ "$existing" = "$record" ] || {
        printf 'conflicting external shared-memory registration for %s\n' "$2" >&2
        return 125
      }
      return 0
    fi
  done
  active_shared_memory_records+=("$record")
}

register_pending_external_shared_memory_provider() {
  local field record existing provider evidence cleanup_evidence exit_objects
  local exit_release extra
  [ "$#" -eq 5 ] || {
    echo 'pending shared-memory registration requires five fields' >&2
    return 125
  }
  for field in "$@"; do
    case "$field" in
      ''|*$'\t'*|*$'\n'*|*$'\r'*)
        echo 'pending shared-memory registration contains an unsafe field' >&2
        return 125
        ;;
    esac
  done
  record="$1"$'\t'"$2"$'\t'"$3"$'\t'"$4"$'\t'"$5"
  for existing in "${pending_shared_memory_records[@]}"; do
    IFS=$'\t' read -r provider evidence cleanup_evidence exit_objects \
      exit_release extra <<<"$existing"
    [ -z "$extra" ] || return 125
    if [ "$evidence" = "$2" ]; then
      [ "$existing" = "$record" ] || {
        printf 'conflicting pending shared-memory registration for %s\n' "$2" >&2
        return 125
      }
      return 0
    fi
  done
  pending_shared_memory_records+=("$record")
}

unregister_pending_external_shared_memory_provider() {
  local remove_evidence="$1"
  local record provider evidence cleanup_evidence exit_objects exit_release extra
  local remaining=()
  for record in "${pending_shared_memory_records[@]}"; do
    IFS=$'\t' read -r provider evidence cleanup_evidence exit_objects \
      exit_release extra <<<"$record"
    [ -z "$extra" ] || return 125
    if [ "$evidence" != "$remove_evidence" ]; then
      remaining+=("$record")
    fi
  done
  pending_shared_memory_records=("${remaining[@]}")
}

recover_pending_external_shared_memory_providers() {
  local record expected_provider evidence cleanup_evidence exit_objects exit_release
  local identity provider root evidence_sha256 extra
  local recovery_status=0
  local reconciled=()

  for record in "${pending_shared_memory_records[@]}"; do
    IFS=$'\t' read -r expected_provider evidence cleanup_evidence exit_objects \
      exit_release extra <<<"$record"
    if [ -n "$extra" ]; then
      recovery_status=125
      continue
    fi
    if [ ! -e "$evidence" ] && [ ! -L "$evidence" ]; then
      # The helper installs catchable-signal rollback before allocating. With
      # no receipt there is no adopted root; SIGKILL/power-loss is the explicit
      # unrecoverable window documented by the provider contract.
      reconciled+=("$evidence")
      continue
    fi
    if [ -L "$evidence" ] || [ ! -f "$evidence" ]; then
      printf 'pending shared-memory provider evidence is unsafe: %s\n' \
        "$evidence" >&2
      recovery_status=125
      continue
    fi
    identity="$(
      python3 "$FRESH_ROOT/lib/shared_memory_provider.py" identify \
        --evidence "$evidence"
    )" || {
      recovery_status=125
      continue
    }
    IFS=$'\t' read -r provider root evidence_sha256 extra <<<"$identity"
    if [ "$provider" != "$expected_provider" ] || [ -z "$root" ] ||
      [ -n "$extra" ] || [[ ! "$evidence_sha256" =~ ^[0-9a-f]{64}$ ]]; then
      printf 'pending shared-memory provider identity is invalid: %s\n' \
        "$evidence" >&2
      recovery_status=125
      continue
    fi
    if [ ! -e "$root" ] && [ ! -L "$root" ]; then
      printf 'pending shared-memory provider root disappeared before adoption: %s\n' \
        "$root" >&2
      recovery_status=125
      continue
    fi
    register_external_shared_memory_provider \
      "$provider" "$root" "$evidence" "$evidence_sha256" \
      "$cleanup_evidence" "$exit_objects" "$exit_release" || {
        recovery_status=125
        continue
      }
    reconciled+=("$evidence")
  done
  for evidence in "${reconciled[@]}"; do
    unregister_pending_external_shared_memory_provider "$evidence" ||
      recovery_status=125
  done
  [ "$recovery_status" -eq 0 ]
}

unregister_external_shared_memory_provider() {
  local remove_root="$1"
  local record provider root evidence evidence_sha256 cleanup_evidence
  local exit_objects exit_release extra
  local remaining=()
  for record in "${active_shared_memory_records[@]}"; do
    IFS=$'\t' read -r provider root evidence evidence_sha256 cleanup_evidence \
      exit_objects exit_release extra <<<"$record"
    [ -z "$extra" ] || return 125
    if [ "$root" != "$remove_root" ]; then
      remaining+=("$record")
    fi
  done
  active_shared_memory_records=("${remaining[@]}")
}

release_external_shared_memory_providers() {
  local reason="$1"
  local record provider root evidence evidence_sha256 cleanup_evidence
  local exit_objects exit_release extra
  local release_status=0
  local released_roots=()

  recover_pending_external_shared_memory_providers || release_status=125

  for record in "${active_shared_memory_records[@]}"; do
    IFS=$'\t' read -r provider root evidence evidence_sha256 cleanup_evidence \
      exit_objects exit_release extra <<<"$record"
    if [ -n "$extra" ]; then
      release_status=125
      continue
    fi

    if [ ! -e "$root" ] && [ ! -L "$root" ]; then
      printf 'external shared-memory provider root disappeared before exact cleanup: %s\n' \
        "$root" >&2
      release_status=125
      continue
    fi
    if [ ! -e "$exit_objects" ] && [ ! -L "$exit_objects" ]; then
      python3 "$FRESH_ROOT/lib/shared_memory_provider.py" capture-objects \
        --provider "$provider" --root "$root" --evidence "$evidence" \
        --evidence-sha256 "$evidence_sha256" --output "$exit_objects" \
        --require-main no --cgroup-identity post-process-drain || {
          release_status=125
          continue
        }
    fi
    # Never remove a directory that still contains an object. A surviving
    # object may mean an owned process escaped teardown; retain it and its
    # inventory rather than masking the lifecycle failure.
    if ! python3 "$FRESH_ROOT/lib/shared_memory_provider.py" assert-empty \
      --provider "$provider" --root "$root" --evidence "$evidence" \
      --evidence-sha256 "$evidence_sha256" --output "$exit_release" \
      --release-kind post-process-drain-v1; then
      release_status=125
      continue
    fi
    if ! python3 "$FRESH_ROOT/lib/shared_memory_provider.py" cleanup \
      --provider "$provider" --root "$root" --evidence "$evidence" \
      --evidence-sha256 "$evidence_sha256" \
      --cleanup-evidence "$cleanup_evidence" --reason "$reason"; then
      release_status=125
      continue
    fi
    released_roots+=("$root")
  done
  for root in "${released_roots[@]}"; do
    unregister_external_shared_memory_provider "$root" || release_status=125
  done
  [ "$release_status" -eq 0 ]
}

register_background_pid() {
  active_background_pids+=("$1")
}

unregister_background_pid() {
  local remove_pid="$1"
  local pid
  local remaining=()
  for pid in "${active_background_pids[@]}"; do
    [ "$pid" = "$remove_pid" ] || remaining+=("$pid")
  done
  active_background_pids=("${remaining[@]}")
}

register_client_process_group() {
  active_client_pids+=("$1")
  active_client_pgids+=("$2")
}

unregister_client_process_group() {
  local remove_pid="$1"
  local index
  local remaining_pids=()
  local remaining_pgids=()

  for index in "${!active_client_pids[@]}"; do
    if [ "${active_client_pids[$index]}" != "$remove_pid" ]; then
      remaining_pids+=("${active_client_pids[$index]}")
      remaining_pgids+=("${active_client_pgids[$index]}")
    fi
  done
  active_client_pids=("${remaining_pids[@]}")
  active_client_pgids=("${remaining_pgids[@]}")
}

terminate_active_client_process_groups() {
  local index pid pgid cleanup_status=0

  for index in "${!active_client_pids[@]}"; do
    pid="${active_client_pids[$index]}"
    pgid="${active_client_pgids[$index]}"
    if fresh_process_group_exists "$pgid" || fresh_supervision_pid_running "$pid"; then
      if ! fresh_terminate_process_group "$pgid" "$pid"; then
        cleanup_status=1
      fi
    else
      # The direct child may already be a waitable zombie even though no live
      # member remains. Reap it before releasing the registry entry.
      fresh_reap_process_group_leader "$pid"
    fi
  done
  return "$cleanup_status"
}

assert_no_client_process_residue() {
  local context="$1"
  local index pid pgid residue=0 cleanup_status=0
  local remaining_pids=()
  local remaining_pgids=()

  for index in "${!active_client_pids[@]}"; do
    pid="${active_client_pids[$index]}"
    pgid="${active_client_pgids[$index]}"
    if fresh_process_group_exists "$pgid" || fresh_supervision_pid_running "$pid"; then
      residue=1
      printf 'client process residue before %s: pid=%s pgid=%s\n' \
        "$context" "$pid" "$pgid" >&2
    fi
  done
  if [ "${#active_client_pids[@]}" -gt 0 ]; then
    terminate_active_client_process_groups || cleanup_status=1
  fi
  for index in "${!active_client_pids[@]}"; do
    pid="${active_client_pids[$index]}"
    pgid="${active_client_pgids[$index]}"
    if fresh_process_group_exists "$pgid" || fresh_supervision_pid_running "$pid"; then
      remaining_pids+=("$pid")
      remaining_pgids+=("$pgid")
    fi
  done
  active_client_pids=("${remaining_pids[@]}")
  active_client_pgids=("${remaining_pgids[@]}")
  [ "$residue" -eq 0 ] && [ "$cleanup_status" -eq 0 ] &&
    [ "${#active_client_pids[@]}" -eq 0 ]
}

wait_for_pid_exit() {
  local pid="$1"
  local tenths="$2"
  local i
  for ((i = 0; i < tenths; i++)); do
    pid_is_running "$pid" || return 0
    sleep 0.1
  done
  return 1
}

pid_is_running() {
  local pid="$1"
  local state

  kill -0 "$pid" 2>/dev/null || return 1
  state="$(ps -o stat= -p "$pid" 2>/dev/null | awk 'NR == 1 { print $1 }')"
  case "$state" in
    ""|Z*) return 1 ;;
    *) return 0 ;;
  esac
}

captured_server_cgroup_dir=""
captured_server_cgroup_identity=""
captured_server_cgroup_membership_path=""
capture_server_cgroup_identity() {
  local pid="$1"
  local unit="$2"
  local deadline relative="" directory identity=""

  captured_server_cgroup_dir=""
  captured_server_cgroup_identity=""
  captured_server_cgroup_membership_path=""
  [ -n "$unit" ] || return 0
  deadline=$(( $(now_ms) + 5000 ))
  while [ "$(now_ms)" -lt "$deadline" ]; do
    if [ -r "/proc/$pid/cgroup" ]; then
      relative="$(awk -F: '$1 == "0" { print $3; exit }' "/proc/$pid/cgroup")"
      case "$relative" in
        */"$unit.scope") break ;;
      esac
    fi
    sleep 0.05
  done
  case "$relative" in
    /*/"$unit.scope") ;;
    *) printf 'server did not enter expected cgroup scope: pid=%s unit=%s path=%s\n' \
         "$pid" "$unit" "$relative" >&2; return 125 ;;
  esac
  directory="/sys/fs/cgroup$relative"
  [ -d "$directory" ] && [ -r "$directory/cgroup.procs" ] || {
    printf 'server cgroup scope is unavailable: %s\n' "$directory" >&2
    return 125
  }
  identity="$(fresh_path_identity "$directory")" || return 125
  captured_server_cgroup_dir="$directory"
  captured_server_cgroup_identity="$identity"
  captured_server_cgroup_membership_path="$relative"
}

captured_server_cgroup_memory_max_bytes=none
captured_server_cgroup_memory_high_bytes=none
captured_server_cgroup_swap_max_bytes=none
capture_server_cgroup_limits() {
  local directory="$1"
  local expected_identity="$2"
  local before_identity after_identity memory_max memory_high swap_max

  captured_server_cgroup_memory_max_bytes=none
  captured_server_cgroup_memory_high_bytes=none
  captured_server_cgroup_swap_max_bytes=none
  [ -n "$directory" ] && [ -n "$expected_identity" ] || return 0
  before_identity="$(fresh_path_identity "$directory")" || return 125
  [ "$before_identity" = "$expected_identity" ] || {
    printf 'server cgroup identity changed before limit capture: expected=%s actual=%s\n' \
      "$expected_identity" "$before_identity" >&2
    return 125
  }
  for controller in memory.max memory.high memory.swap.max; do
    [ -r "$directory/$controller" ] || {
      printf 'required server cgroup controller file is unavailable: %s/%s\n' \
        "$directory" "$controller" >&2
      return 125
    }
  done
  memory_max="$(<"$directory/memory.max")" || return 125
  memory_high="$(<"$directory/memory.high")" || return 125
  swap_max="$(<"$directory/memory.swap.max")" || return 125
  case "$memory_max:$memory_high:$swap_max" in
    *[!0-9:]*)
      printf 'server cgroup limits are not exact finite byte counts: %s:%s:%s\n' \
        "$memory_max" "$memory_high" "$swap_max" >&2
      return 125
      ;;
  esac
  after_identity="$(fresh_path_identity "$directory")" || return 125
  [ "$after_identity" = "$expected_identity" ] || {
    printf 'server cgroup identity changed during limit capture: expected=%s actual=%s\n' \
      "$expected_identity" "$after_identity" >&2
    return 125
  }
  captured_server_cgroup_memory_max_bytes="$memory_max"
  captured_server_cgroup_memory_high_bytes="$memory_high"
  captured_server_cgroup_swap_max_bytes="$swap_max"
}

record_server_limits() {
  local target="$1"
  local record="$2"
  local pid="$3"
  local pre_soft pre_hard actual_soft actual_hard launch_status status="passed"
  local proc_soft="" proc_hard=""

  [ -s "$record" ] || {
    printf '%s\t%s\t\t\t\t\tmissing\t%s\n' \
      "$target" "$libpq_latency_soft_nofile" "$record" >>"$server_limits_tsv"
    return 1
  }
  pre_soft="$(awk -F= '$1 == "pre_soft_nofile" { print $2 }' "$record")"
  pre_hard="$(awk -F= '$1 == "pre_hard_nofile" { print $2 }' "$record")"
  actual_soft="$(awk -F= '$1 == "actual_soft_nofile" { print $2 }' "$record")"
  actual_hard="$(awk -F= '$1 == "actual_hard_nofile" { print $2 }' "$record")"
  launch_status="$(awk -F= '$1 == "status" { print $2 }' "$record")"
  if [ "$libpq_latency_samples" -gt 0 ]; then
    if [ "$launch_status" != "applied" ] ||
      [ "$actual_soft" != "$libpq_latency_soft_nofile" ] ||
      [ "$actual_hard" != "$pre_hard" ]; then
      status="failed"
    fi
    if [ -r "/proc/$pid/limits" ]; then
      read -r proc_soft proc_hard < <(
        awk '$1 == "Max" && $2 == "open" && $3 == "files" { print $4, $5; exit }' \
          "/proc/$pid/limits"
      )
      if [ "$proc_soft" != "$libpq_latency_soft_nofile" ] ||
        [ "$proc_hard" != "$pre_hard" ]; then
        status="failed"
      fi
      actual_soft="$proc_soft"
      actual_hard="$proc_hard"
    elif [ "$(uname -s 2>/dev/null || printf unknown)" = Linux ]; then
      status="failed"
    fi
  elif [ "$launch_status" != "not-requested" ]; then
    status="failed"
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$target" "$libpq_latency_soft_nofile" "$pre_soft" "$pre_hard" \
    "$actual_soft" "$actual_hard" "$status" "$record" >>"$server_limits_tsv"
  [ "$status" = "passed" ]
}

stop_server() {
  local pid="$1"
  local pgid="$2"
  local birth_identity="$3"
  local port="$4"
  local cgroup_dir="$5"
  local cgroup_identity="$6"
  local server_log="$7"
  local shutdown_report="$8"
  local target="$9"
  local cgroup_path="${10}"
  local wait_status=0
  local forced=none
  local clean_shutdown=0
  local orderly_int=0 process_group_residue=0 cgroup_residue=0 port_residue=0
  local lifecycle_status="passed"

  if pid_is_running "$pid"; then
    # Wasmer's CLI signal bridge and PostgreSQL both treat SIGINT as a fast,
    # orderly database shutdown. This exercises guest shutdown instead of
    # merely terminating the host runtime.
    if fresh_signal_owned_pid INT "$pid" "$birth_identity"; then
      orderly_int=1
    else
      lifecycle_status="failed"
    fi
    if ! wait_for_pid_exit "$pid" 300; then
      forced=term
      fresh_terminate_owned_process_group "$pgid" "$pid" "$birth_identity" \
        "$process_term_grace_ms" "$process_kill_grace_ms" || lifecycle_status="failed"
    fi
  fi

  if fresh_pid_matches_birth_identity "$pid" "$birth_identity"; then
    set +e
    wait "$pid" 2>/dev/null
    wait_status=$?
    set -e
  fi
  if fresh_process_group_exists "$pgid"; then
    [ "$forced" != none ] || forced=term
    fresh_terminate_owned_process_group "$pgid" "$pid" "$birth_identity" \
      "$process_term_grace_ms" "$process_kill_grace_ms" || lifecycle_status="failed"
  fi
  if fresh_process_group_exists "$pgid"; then
    process_group_residue=1
    lifecycle_status="failed"
  fi
  if ! fresh_wait_cgroup_empty "$cgroup_dir" "$cgroup_identity" \
    "$process_kill_grace_ms"; then
    cgroup_residue=1
    lifecycle_status="failed"
  fi
  if ! fresh_wait_tcp_port_closed 127.0.0.1 "$port" "$process_kill_grace_ms"; then
    port_residue=1
    lifecycle_status="failed"
  fi
  unregister_server_pid "$pid"

  if [ -f "$server_log" ] && grep -q 'database system is shut down' "$server_log"; then
    clean_shutdown=1
  fi
  {
    printf 'pid=%s\npgid=%s\nbirth_identity=%s\n' "$pid" "$pgid" "$birth_identity"
    printf 'wait_status=%s\n' "$wait_status"
    printf 'forced=%s\n' "$forced"
    printf 'clean_shutdown_marker=%s\n' "$clean_shutdown"
    printf 'process_group_residue=%s\n' "$process_group_residue"
    printf 'cgroup_residue=%s\n' "$cgroup_residue"
    printf 'port_residue=%s\n' "$port_residue"
    printf 'status=%s\n' "$lifecycle_status"
  } >"$shutdown_report"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$target" "$pid" "$pgid" "$birth_identity" "$cgroup_path" \
    "$cgroup_identity" "$orderly_int" "$forced" "$wait_status" "$clean_shutdown" \
    "$process_group_residue" "$cgroup_residue" "$port_residue" \
    "$lifecycle_status" "$shutdown_report" >>"$server_lifecycle_tsv"

  [ "$forced" = none ] && [ "$wait_status" -eq 0 ] &&
    [ "$clean_shutdown" -eq 1 ] && [ "$lifecycle_status" = "passed" ]
}

cleanup_active_servers() {
  local status=$?
  local pid index pgid identity port cgroup_dir cgroup_identity
  trap - EXIT HUP INT TERM
  if ! terminate_active_client_process_groups; then
    [ "$status" -ne 0 ] || status=125
  fi
  active_client_pids=()
  active_client_pgids=()
  for index in "${!active_server_pids[@]}"; do
    pid="${active_server_pids[$index]}"
    pgid="${active_server_pgids[$index]}"
    identity="${active_server_identities[$index]}"
    port="${active_server_ports[$index]}"
    cgroup_dir="${active_server_cgroup_dirs[$index]}"
    cgroup_identity="${active_server_cgroup_identities[$index]}"
    if pid_is_running "$pid"; then
      fresh_signal_owned_pid INT "$pid" "$identity" || [ "$status" -ne 0 ] || status=125
      wait_for_pid_exit "$pid" 50 || true
    fi
    if fresh_process_group_exists "$pgid"; then
      fresh_terminate_owned_process_group "$pgid" "$pid" "$identity" ||
        { [ "$status" -ne 0 ] || status=125; }
    elif fresh_pid_matches_birth_identity "$pid" "$identity"; then
      wait "$pid" 2>/dev/null || true
    fi
    fresh_process_group_exists "$pgid" && { [ "$status" -ne 0 ] || status=125; }
    fresh_wait_cgroup_empty "$cgroup_dir" "$cgroup_identity" "$process_kill_grace_ms" ||
      { [ "$status" -ne 0 ] || status=125; }
    fresh_wait_tcp_port_closed 127.0.0.1 "$port" "$process_kill_grace_ms" ||
      { [ "$status" -ne 0 ] || status=125; }
  done
  for pid in "${active_background_pids[@]}"; do
    if pid_is_running "$pid"; then
      kill -TERM "$pid" 2>/dev/null || true
      wait_for_pid_exit "$pid" 50 || kill -KILL "$pid" 2>/dev/null || true
    fi
    wait "$pid" 2>/dev/null || true
  done
  if ! release_external_shared_memory_providers exit-drain; then
    [ "$status" -ne 0 ] || status=125
  fi
  if [ "$status" -ne 0 ]; then
    invalidate_derived_summary "$status" "" || true
    invalidate_libpq_latency_summary "$status" "" || true
  fi
  exit "$status"
}

invalidate_derived_summary() {
  local invalid_status="$1"
  local invalid_target="${2:-}"
  local tmp

  [ -s "${summary_tsv:-}" ] || return 0
  tmp="$summary_tsv.invalid.$$"
  awk -F '\t' -v OFS='\t' -v invalid_status="$invalid_status" \
    -v invalid_target="$invalid_target" '
    NR == 1 { print; next }
    invalid_target == "" || $1 == invalid_target {
      if ($3 == "0") {
        $3 = invalid_status
      }
      $10 = ""
    }
    { print }
  ' "$summary_tsv" >"$tmp"
  mv "$tmp" "$summary_tsv"
}

invalidate_libpq_latency_summary() {
  local invalid_status="$1"
  local invalid_target="${2:-}"
  local tmp

  [ -s "${libpq_latency_tsv:-}" ] || return 0
  tmp="$libpq_latency_tsv.invalid.$$"
  awk -F '\t' -v OFS='\t' -v invalid_status="$invalid_status" \
    -v invalid_target="$invalid_target" '
    NR == 1 { print; next }
    (invalid_target == "" || $2 == invalid_target) && $4 == "ok" {
      $4 = "invalidated_exit_" invalid_status
      for (column = 8; column <= 13; column++) $column = ""
    }
    { print }
  ' "$libpq_latency_tsv" >"$tmp"
  mv "$tmp" "$libpq_latency_tsv"
}

append_libpq_latency_failure() {
  local target="$1"
  local mode="$2"
  local status="$3"
  local raw="$4"

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    1 "$target" "$mode" "$status" CLOCK_MONOTONIC \
    "$libpq_latency_warmup" "$libpq_latency_samples" \
    "" "" "" "" "" "" "$raw" "$libpq_latency_libpq_path" \
    "$libpq_latency_libpq_sha256" "$libpq_latency_probe_sha256" >>"$libpq_latency_tsv"
}

append_libpq_latency_target_failure() {
  local target="$1"
  local status="$2"
  local target_report_dir="$3"
  local mode

  [ "$libpq_latency_samples" -gt 0 ] || return 0
  for mode in persistent reconnect; do
    append_libpq_latency_failure "$target" "$mode" "$status" \
      "$target_report_dir/libpq-latency/$mode.raw.tsv"
  done
}

host_fd_snapshot_total=""
host_fd_snapshot_observed=0
host_fd_snapshot_expected=0
host_fd_snapshot_status="raced"

collect_exact_host_fd_snapshot() {
  local root_pid="$1"
  local kernel snapshot_before snapshot_after pids metrics

  kernel="$(uname -s 2>/dev/null || printf unknown)"
  host_fd_snapshot_total=""
  host_fd_snapshot_observed=0
  host_fd_snapshot_expected=0
  host_fd_snapshot_status="raced"
  snapshot_before="$(collect_process_tree_snapshot "$root_pid" 2>/dev/null || true)"
  pids="$(printf '%s\n' "$snapshot_before" | awk -F '\t' 'NF >= 2 { print $1 }' | tr '\n' ' ')"
  host_fd_snapshot_expected="$(printf '%s\n' "$snapshot_before" |
    awk -F '\t' 'NF >= 2 { count++ } END { print count + 0 }')"
  [ "$host_fd_snapshot_expected" -gt 0 ] || return 1
  metrics="$(fresh_collect_host_fd_occupancy "$kernel" /proc "$pids")" || return
  host_fd_snapshot_total="$(printf '%s\n' "$metrics" | awk -F '\t' '{ print $1 }')"
  host_fd_snapshot_observed="$(printf '%s\n' "$metrics" | awk -F '\t' '{ print $2 }')"
  host_fd_snapshot_expected="$(printf '%s\n' "$metrics" | awk -F '\t' '{ print $3 }')"
  host_fd_snapshot_status="$(printf '%s\n' "$metrics" | awk -F '\t' '{ print $4 }')"
  snapshot_after="$(collect_process_tree_snapshot "$root_pid" 2>/dev/null || true)"
  if [ -z "$snapshot_after" ] || [ "$snapshot_before" != "$snapshot_after" ]; then
    host_fd_snapshot_total=""
    host_fd_snapshot_status="raced"
  fi
}

append_host_fd_checkpoint() {
  local target="$1"
  local mode="$2"
  local stage="$3"

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$target" "$mode" "$stage" "$(now_ms)" "$host_fd_snapshot_total" \
    "$host_fd_snapshot_observed" "$host_fd_snapshot_expected" \
    "$host_fd_snapshot_status" >>"$host_fd_checkpoints_tsv"
}

capture_host_fd_checkpoint() {
  local target="$1"
  local mode="$2"
  local stage="$3"
  local root_pid="$4"

  collect_exact_host_fd_snapshot "$root_pid" || true
  append_host_fd_checkpoint "$target" "$mode" "$stage"
  [ "$host_fd_snapshot_status" = ok ]
}

capture_quiescent_host_fd_checkpoint() {
  local target="$1"
  local mode="$2"
  local root_pid="$3"
  local deadline stable=0 previous=""

  deadline=$(( $(now_ms) + 5000 ))
  while :; do
    sleep 0.05
    collect_exact_host_fd_snapshot "$root_pid" || true
    if [ "$host_fd_snapshot_status" = ok ]; then
      if [ "$host_fd_snapshot_total" = "$previous" ]; then
        stable=$((stable + 1))
      else
        stable=1
        previous="$host_fd_snapshot_total"
      fi
      [ "$stable" -ge 3 ] && break
    else
      stable=0
      previous=""
    fi
    [ "$(now_ms)" -lt "$deadline" ] || break
  done
  append_host_fd_checkpoint "$target" "$mode" quiescent
  [ "$host_fd_snapshot_status" = ok ] && [ "$stable" -ge 3 ]
}

run_libpq_latency_mode() {
  local target="$1"
  local mode="$2"
  local conn="$3"
  local target_report_dir="$4"
  local resource_phase_file="$5"
  local server_pid="$6"
  local latency_dir="$target_report_dir/libpq-latency"
  local raw="$latency_dir/$mode.raw.tsv"
  local mode_summary="$latency_dir/$mode.summary.tsv"
  local probe_log="$latency_dir/$mode.probe.log"
  local summary_log="$latency_dir/$mode.summary.log"
  local probe_status summary_status fd_before_status fd_after_status
  local fd_quiescent_status fd_validation_status fd_summary host_kernel

  mkdir -p "$latency_dir"
  set_resource_phase "$resource_phase_file" "libpq-latency:$mode"
  if capture_host_fd_checkpoint "$target" "$mode" before "$server_pid"; then
    fd_before_status=0
  else
    fd_before_status=$?
  fi
  set +e
  run_logged_timeout "$timeout_seconds" "$probe_log" \
    env -u LD_LIBRARY_PATH -u LD_PRELOAD -u LD_AUDIT \
      -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH -u DYLD_INSERT_LIBRARIES \
      PGCONNECT_TIMEOUT=10 "$libpq_latency_probe_bin" \
      --conninfo "$conn" \
      --mode "$mode" \
      --warmup "$libpq_latency_warmup" \
      --samples "$libpq_latency_samples" \
      --output "$raw"
  probe_status=$?
  set -e
  if capture_host_fd_checkpoint "$target" "$mode" after "$server_pid"; then
    fd_after_status=0
  else
    fd_after_status=$?
  fi
  if capture_quiescent_host_fd_checkpoint "$target" "$mode" "$server_pid"; then
    fd_quiescent_status=0
  else
    fd_quiescent_status=$?
  fi
  fd_summary="$latency_dir/$mode.host-fd-churn.tsv"
  host_kernel="$(uname -s 2>/dev/null || printf unknown)"
  if [ "$host_kernel" = Linux ]; then
    set +e
    "$FRESH_ROOT/bin/validate-host-fd-churn.sh" "$host_fd_checkpoints_tsv" \
      "$target" "$mode" "$libpq_latency_host_fd_allowance" "$fd_summary"
    fd_validation_status=$?
    set -e
    if [ -s "$fd_summary" ]; then
      sed -n '2p' "$fd_summary" >>"$host_fd_churn_tsv"
    else
      printf '%s\t%s\t\t\t\t\t%s\tfailed\n' "$target" "$mode" \
        "$libpq_latency_host_fd_allowance" >>"$host_fd_churn_tsv"
    fi
  else
    fd_validation_status=0
    fd_before_status=0
    fd_after_status=0
    fd_quiescent_status=0
    printf '%s\t%s\t\t\t\t\t%s\tunsupported\n' "$target" "$mode" \
      "$libpq_latency_host_fd_allowance" >>"$host_fd_churn_tsv"
  fi
  if [ "$probe_status" -ne 0 ]; then
    append_libpq_latency_failure "$target" "$mode" "probe_exit_$probe_status" "$raw"
    return "$probe_status"
  fi
  if [ "$fd_before_status" -ne 0 ] || [ "$fd_after_status" -ne 0 ] ||
    [ "$fd_quiescent_status" -ne 0 ] || [ "$fd_validation_status" -ne 0 ]; then
    append_libpq_latency_failure "$target" "$mode" "host_fd_churn_failed" "$raw"
    return 1
  fi

  set +e
  run_logged_timeout "$timeout_seconds" "$summary_log" \
    "$FRESH_ROOT/bin/summarize-libpq-latency.sh" \
      --raw "$raw" \
      --output "$mode_summary" \
      --target "$target" \
      --mode "$mode" \
      --warmup "$libpq_latency_warmup" \
      --samples "$libpq_latency_samples" \
      --libpq-path "$libpq_latency_libpq_path" \
      --libpq-sha256 "$libpq_latency_libpq_sha256" \
      --probe-sha256 "$libpq_latency_probe_sha256"
  summary_status=$?
  set -e
  if [ "$summary_status" -ne 0 ]; then
    append_libpq_latency_failure "$target" "$mode" "summary_exit_$summary_status" "$raw"
    return "$summary_status"
  fi
  if [ "$(awk 'END { print NR }' "$mode_summary")" -ne 2 ]; then
    append_libpq_latency_failure "$target" "$mode" "summary_row_count_invalid" "$raw"
    return 1
  fi
  sed -n '2p' "$mode_summary" >>"$libpq_latency_tsv"
}

run_libpq_latency_suite() {
  local target="$1"
  local conn="$2"
  local target_report_dir="$3"
  local resource_phase_file="$4"
  local server_pid="$5"
  local mode mode_status
  local status=0

  for mode in persistent reconnect; do
    if run_libpq_latency_mode "$target" "$mode" "$conn" "$target_report_dir" \
      "$resource_phase_file" "$server_pid"
    then
      mode_status=0
    else
      mode_status=$?
    fi
    if [ "$mode_status" -ne 0 ]; then
      status=1
    fi
  done
  set_resource_phase "$resource_phase_file" "idle"
  return "$status"
}

lifecycle_phase_sequence=0
append_lifecycle_phase_marker() {
  local log="$1"
  local nonce="$2"
  local phase="$3"
  local observer_pid="$4"
  local marker_mono_ns="${5:-$(now_ns)}"

  lifecycle_phase_sequence=$((lifecycle_phase_sequence + 1))
  printf 'wasix-runtime-phase-v1\tnonce=%s\tseq=%s\tmono_ns=%s\tphase=%s\tobserver_pid=%s\n' \
    "$nonce" "$lifecycle_phase_sequence" "$marker_mono_ns" "$phase" "$observer_pid" >>"$log"
}

validate_walwriter_stabilization_state_file() {
  local state_file="$1"

  [ -f "$state_file" ] && [ ! -L "$state_file" ] && awk -F '\t' '
    NF == 6 &&
      $1 ~ /^(0|[1-9][0-9]*)$/ &&
      $2 ~ /^(0|[1-9][0-9]*)$/ &&
      $3 ~ /^[1-9][0-9]*$/ &&
      $4 ~ /^[1-9][0-9]*$/ &&
      $5 ~ /^[0-9A-F]+\/[0-9A-F]+$/ &&
      ($6 == "t" || $6 == "f") { valid = 1 }
    END { exit(NR == 1 && valid ? 0 : 1) }
  ' "$state_file"
}

capture_walwriter_stabilization_state() {
  local conn="$1"
  local target_lsn="$2"
  local state_file="$3"
  local diagnostics="$4"
  local deadline_ms="$5"
  local current_ms remaining_ms

  [[ "$target_lsn" =~ ^[0-9A-F]+/[0-9A-F]+$ ]] || return 2
  current_ms="$(now_ms)"
  if [ "$current_ms" -ge "$deadline_ms" ]; then
    return 124
  fi
  remaining_ms=$((deadline_ms - current_ms))
  if ! fresh_run_process_group_timeout_ms "$remaining_ms" -- \
    "$NATIVE_INSTALL_DIR/bin/psql" "$conn" -XAtq -F $'\t' \
      -v ON_ERROR_STOP=1 -c "
      WITH current_flush AS MATERIALIZED (
        SELECT pg_current_wal_flush_lsn() AS lsn
      )
      SELECT
        io.writes::bigint,
        io.write_bytes::bigint,
        (extract(epoch FROM io.stats_reset) * 1000000)::bigint,
        settings.setting::bigint,
        current_flush.lsn,
        current_flush.lsn >= '$target_lsn'::pg_lsn
      FROM pg_stat_io AS io
      CROSS JOIN current_flush
      CROSS JOIN pg_settings AS settings
      WHERE io.backend_type = 'walwriter'
        AND io.object = 'wal'
        AND io.context = 'normal'
        AND settings.name = 'wal_writer_delay'
        AND settings.unit = 'ms'
    " >"$state_file" 2>>"$diagnostics"
  then
    return 1
  fi
  if ! validate_walwriter_stabilization_state_file "$state_file"; then
    printf 'expected one applicable walwriter/wal/normal pg_stat_io row and wal_writer_delay in ms\n' \
      >>"$diagnostics"
    return 1
  fi
}

emit_walwriter_stabilization_target() {
  local conn="$1"
  local target_file="$2"
  local diagnostics="$3"
  local deadline_ms="$4"
  local current_ms remaining_ms target_lsn

  current_ms="$(now_ms)"
  if [ "$current_ms" -ge "$deadline_ms" ]; then
    return 124
  fi
  remaining_ms=$((deadline_ms - current_ms))
  if ! fresh_run_process_group_timeout_ms "$remaining_ms" -- \
    "$NATIVE_INSTALL_DIR/bin/psql" "$conn" -XAtq -v ON_ERROR_STOP=1 \
      -c 'SELECT pg_log_standby_snapshot()' >"$target_file" 2>>"$diagnostics"
  then
    return 1
  fi
  if ! awk '
    /^[0-9A-F]+\/[0-9A-F]+$/ && $0 != "0/0" { valid = 1 }
    END { exit(NR == 1 && valid ? 0 : 1) }
  ' "$target_file"; then
    printf 'pg_log_standby_snapshot did not return one applicable nonzero LSN\n' \
      >>"$diagnostics"
    return 1
  fi
  target_lsn="$(sed -n '1p' "$target_file")"
  printf '%s\n' "$target_lsn"
}

append_walwriter_stabilization_record() {
  local log="$1"
  local nonce="$2"
  local before_writes="$3"
  local after_writes="$4"
  local before_write_bytes="$5"
  local after_write_bytes="$6"
  local before_stats_reset="$7"
  local after_stats_reset="$8"
  local target_lsn="$9"
  local observed_flush_lsn="${10}"
  local wal_writer_delay_ms="${11}"
  local start_mono_ns="${12}"
  local end_mono_ns="${13}"
  local status="${14}"
  local observer_pid="${15}"

  printf 'wasix-runtime-stabilization-v1\tnonce=%s\tmethod=pg_log_standby_snapshot\tbefore_writes=%s\tafter_writes=%s\tbefore_write_bytes=%s\tafter_write_bytes=%s\tbefore_stats_reset=%s\tafter_stats_reset=%s\ttarget_lsn=%s\tobserved_flush_lsn=%s\twal_writer_delay_ms=%s\tstart_mono_ns=%s\tend_mono_ns=%s\tstatus=%s\tobserver_pid=%s\n' \
    "$nonce" "$before_writes" "$after_writes" "$before_write_bytes" \
    "$after_write_bytes" "$before_stats_reset" "$after_stats_reset" \
    "$target_lsn" "$observed_flush_lsn" "$wal_writer_delay_ms" \
    "$start_mono_ns" "$end_mono_ns" "$status" "$observer_pid" >>"$log"
}

run_walwriter_stabilization() {
  local conn="$1"
  local wait_dump_log="$2"
  local nonce="$3"
  local observer_pid="$4"
  local target_report_dir="$5"
  local diagnostics="$target_report_dir/lifecycle-walwriter-stabilization.log"
  local before_state="$target_report_dir/lifecycle-walwriter-before.raw.tsv"
  local after_state="$target_report_dir/lifecycle-walwriter-after.raw.tsv"
  local target_file="$target_report_dir/lifecycle-walwriter-target-lsn.txt"
  local report="$target_report_dir/lifecycle-walwriter-stabilization.tsv"
  local deadline_ms start_mono_ns end_mono_ns target_lsn
  local before_writes before_write_bytes before_stats_reset wal_writer_delay_ms
  local before_flush_lsn before_flush_reached
  local after_writes after_write_bytes after_stats_reset after_delay_ms
  local observed_flush_lsn flush_reached current_ms

  : >"$diagnostics"
  deadline_ms=$(( $(now_ms) + timeout_seconds * 1000 ))
  start_mono_ns="$(now_ns)"
  capture_walwriter_stabilization_state "$conn" "0/0" "$before_state" \
    "$diagnostics" "$deadline_ms" || return
  IFS=$'\t' read -r before_writes before_write_bytes before_stats_reset \
    wal_writer_delay_ms before_flush_lsn before_flush_reached <"$before_state"
  target_lsn="$(emit_walwriter_stabilization_target \
    "$conn" "$target_file" "$diagnostics" "$deadline_ms")" || return

  while :; do
    capture_walwriter_stabilization_state "$conn" "$target_lsn" "$after_state" \
      "$diagnostics" "$deadline_ms" || return
    IFS=$'\t' read -r after_writes after_write_bytes after_stats_reset \
      after_delay_ms observed_flush_lsn flush_reached <"$after_state"
    if [ "$after_stats_reset" != "$before_stats_reset" ]; then
      printf 'pg_stat_io stats_reset changed during WAL-writer stabilization\n' \
        >>"$diagnostics"
      return 1
    fi
    if [ "$after_delay_ms" != "$wal_writer_delay_ms" ]; then
      printf 'wal_writer_delay changed during WAL-writer stabilization\n' \
        >>"$diagnostics"
      return 1
    fi
    if [ "$after_writes" -gt "$before_writes" ] &&
      [ "$after_write_bytes" -gt "$before_write_bytes" ] &&
      [ "$flush_reached" = t ]; then
      break
    fi
    current_ms="$(now_ms)"
    if [ "$current_ms" -ge "$deadline_ms" ]; then
      printf 'WAL writer did not write and flush the standby-snapshot barrier within %s seconds\n' \
        "$timeout_seconds" >>"$diagnostics"
      return 124
    fi
    sleep 0.02
  done
  end_mono_ns="$(now_ns)"
  append_walwriter_stabilization_record "$wait_dump_log" "$nonce" \
    "$before_writes" "$after_writes" "$before_write_bytes" "$after_write_bytes" \
    "$before_stats_reset" "$after_stats_reset" "$target_lsn" \
    "$observed_flush_lsn" "$wal_writer_delay_ms" "$start_mono_ns" \
    "$end_mono_ns" passed "$observer_pid"
  {
    printf 'method\tbefore_writes\tafter_writes\tbefore_write_bytes\tafter_write_bytes\tstats_reset\ttarget_lsn\tobserved_flush_lsn\twal_writer_delay_ms\tstart_mono_ns\tend_mono_ns\tstatus\n'
    printf 'pg_log_standby_snapshot\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\tpassed\n' \
      "$before_writes" "$after_writes" "$before_write_bytes" "$after_write_bytes" \
      "$before_stats_reset" "$target_lsn" "$observed_flush_lsn" \
      "$wal_writer_delay_ms" "$start_mono_ns" "$end_mono_ns"
  } >"$report"
}

write_lifecycle_fence_request() {
  local request_file="$1"
  local nonce="$2"
  local request_sequence="$3"
  local phase="$4"
  local observer_pid="$5"
  local pending="$request_file.pending.$$.$request_sequence"

  rm -f -- "$pending"
  if ! printf 'wasix-runtime-fence-request-v1\tnonce=%s\trequest_seq=%s\tphase=%s\tobserver_pid=%s\n' \
    "$nonce" "$request_sequence" "$phase" "$observer_pid" >"$pending"; then
    rm -f -- "$pending"
    return 1
  fi
  if ! mv -f -- "$pending" "$request_file"; then
    rm -f -- "$pending"
    return 1
  fi
}

wait_for_lifecycle_fence_ack() {
  local ack_file="$1"
  local nonce="$2"
  local request_sequence="$3"
  local phase="$4"
  local observer_pid="$5"
  local server_pid="$6"
  local deadline

  deadline=$(( $(now_ms) + timeout_seconds * 1000 ))
  while [ "$(now_ms)" -lt "$deadline" ]; do
    if [ -f "$ack_file" ] && [ ! -L "$ack_file" ] && awk -F '\t' \
      -v nonce="$nonce" \
      -v request_sequence="$request_sequence" \
      -v phase="$phase" \
      -v observer_pid="$observer_pid" '
        $1 == "wasix-runtime-fence-commit-v1" && NF == 9 &&
          $2 == "nonce=" nonce &&
          $3 ~ /^seq=[1-9][0-9]*$/ &&
          $4 ~ /^mono_ns=[1-9][0-9]*$/ &&
          $5 == "phase=" phase &&
          $6 == "observer_pid=" observer_pid &&
          $7 ~ /^observer_tid=[1-9][0-9]*$/ &&
          $8 == "request_seq=" request_sequence &&
          $9 ~ /^fence_end_offset=[1-9][0-9]*$/ { valid = 1 }
        END { exit(NR == 1 && valid ? 0 : 1) }
      ' "$ack_file"
    then
      return 0
    fi
    if ! pid_is_running "$server_pid"; then
      printf 'server exited before runtime writer acknowledged %s fence request %s\n' \
        "$phase" "$request_sequence" >&2
      return 1
    fi
    sleep 0.02
  done
  printf 'runtime writer did not acknowledge %s fence request %s within %s seconds\n' \
    "$phase" "$request_sequence" "$timeout_seconds" >&2
  return 124
}

request_lifecycle_fence() {
  local request_file="$1"
  local ack_file="$2"
  local nonce="$3"
  local request_sequence="$4"
  local phase="$5"
  local observer_pid="$6"
  local server_pid="$7"

  # A committed ACK belongs to one request publication only. Remove the prior
  # inode before the atomic request rename so a stale ACK cannot satisfy the
  # next request even when all of its semantic fields happen to match.
  rm -f -- "$ack_file" || return
  write_lifecycle_fence_request "$request_file" "$nonce" "$request_sequence" \
    "$phase" "$observer_pid" || return
  wait_for_lifecycle_fence_ack "$ack_file" "$nonce" "$request_sequence" "$phase" \
    "$observer_pid" "$server_pid"
}

initialize_lifecycle_memory_checkpoints() {
  local output="$1"

  printf 'schema_version\tnonce\tsequence\tstage\tcompleted_reconnects\trequested_reconnects\tcheckpoint_every\tquiescence_seconds\tquiescence_start_ns\tquiescence_end_ns\tmonotonic_before_ns\tmonotonic_after_ns\tcapture_elapsed_ns\tserver_pid\tserver_birth_identity\tpss_kib\tpss_anon_kib\tanonymous_kib\theap_pss_kib\theap_private_kib\theap_mappings\tstatus\n' \
    >"$output"
}

capture_lifecycle_memory_checkpoint() {
  local output="$1"
  local nonce="$2"
  local sequence="$3"
  local stage="$4"
  local completed="$5"
  local server_pid="$6"
  local expected_birth_identity="$7"
  local quiescence_seconds="$8"
  local quiescence_start_ns="$9"
  local quiescence_end_ns="${10}"
  local before_ns after_ns elapsed_ns before_identity after_identity
  local rollup_metrics heap_metrics metric
  local pss_kib=0 pss_anon_kib=0 anonymous_kib=0
  local heap_pss_kib=0 heap_private_kib=0 heap_mappings=0 status=passed

  before_ns="$(now_ns)" || return
  before_identity="$(fresh_process_birth_identity "$server_pid" 2>/dev/null || true)"
  if [ "$before_identity" != "$expected_birth_identity" ]; then
    status=failed
  fi
  if [ "$status" = passed ]; then
    rollup_metrics="$(
      awk '
        /^Pss:[[:space:]]/ { pss = $2; saw_pss = 1 }
        /^Pss_Anon:[[:space:]]/ { pss_anon = $2; saw_pss_anon = 1 }
        /^Anonymous:[[:space:]]/ { anonymous = $2; saw_anonymous = 1 }
        END {
          if (!saw_pss || !saw_pss_anon || !saw_anonymous) exit 1
          printf "%.0f\t%.0f\t%.0f\n", pss, pss_anon, anonymous
        }
      ' "/proc/$server_pid/smaps_rollup" 2>/dev/null
    )" || status=failed
  fi
  if [ "$status" = passed ]; then
    IFS=$'\t' read -r pss_kib pss_anon_kib anonymous_kib <<<"$rollup_metrics"
    for metric in "$pss_kib" "$pss_anon_kib" "$anonymous_kib"; do
      case "$metric" in ''|*[!0-9]*) status=failed ;; esac
    done
  fi
  if [ "$status" = passed ]; then
    heap_metrics="$(
      awk '
        /^[[:xdigit:]]+-[[:xdigit:]]+[[:space:]]/ {
          in_heap = ($NF == "[heap]")
          if (in_heap) mappings += 1
          next
        }
        in_heap && /^Pss:[[:space:]]/ { pss += $2 }
        in_heap && /^Private_Clean:[[:space:]]/ { private += $2 }
        in_heap && /^Private_Dirty:[[:space:]]/ { private += $2 }
        in_heap && /^Private_Hugetlb:[[:space:]]/ { private += $2 }
        END { printf "%.0f\t%.0f\t%.0f\n", pss, private, mappings }
      ' "/proc/$server_pid/smaps" 2>/dev/null
    )" || status=failed
  fi
  if [ "$status" = passed ]; then
    IFS=$'\t' read -r heap_pss_kib heap_private_kib heap_mappings <<<"$heap_metrics"
    for metric in "$heap_pss_kib" "$heap_private_kib" "$heap_mappings"; do
      case "$metric" in ''|*[!0-9]*) status=failed ;; esac
    done
  fi
  after_identity="$(fresh_process_birth_identity "$server_pid" 2>/dev/null || true)"
  [ "$after_identity" = "$expected_birth_identity" ] || status=failed
  after_ns="$(now_ns)" || return
  elapsed_ns=$((after_ns - before_ns))
  [ "$elapsed_ns" -gt 0 ] || status=failed

  printf 'oliphaunt.wasix-postmaster.lifecycle-memory-checkpoint.v1\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$nonce" "$sequence" "$stage" "$completed" \
    "$wasix_lifecycle_reconnects" \
    "$wasix_lifecycle_memory_checkpoint_every" "$quiescence_seconds" \
    "$quiescence_start_ns" "$quiescence_end_ns" \
    "$before_ns" "$after_ns" "$elapsed_ns" "$server_pid" \
    "$expected_birth_identity" "$pss_kib" "$pss_anon_kib" \
    "$anonymous_kib" "$heap_pss_kib" "$heap_private_kib" \
    "$heap_mappings" "$status" >>"$output"
  if [ "$status" != passed ]; then
    printf 'failed to capture quiescent lifecycle memory checkpoint %s at reconnect %s\n' \
      "$sequence" "$completed" >&2
    return 1
  fi
}

run_lifecycle_reconnect_churn() {
  local conn="$1"
  local output="$2"
  local evidence_log="$3"
  local nonce="$4"
  local observer_pid="$5"
  local resource_phase_file="$6"
  local memory_checkpoints="$7"
  local server_pid="$8"
  local server_birth_identity="$9"
  local deadline now remaining_ms attempt_timeout_ms reconnect status=0 completed=0
  local quiescence_start_ns quiescence_end_ns
  local start_mono_ns end_mono_ns command_sha256 client_sha256 connection_sha256

  command_sha256="$({
    printf '%s\0' \
      oliphaunt.wasix-postmaster.lifecycle-reconnect.v1 \
      PGCONNECT_TIMEOUT=5 psql -X -qAt -v ON_ERROR_STOP=1 -c 'select 1'
  } | fresh_sha256_stream)" || return
  client_sha256="$(fresh_wasmer_bin_hash "$NATIVE_INSTALL_DIR/bin/psql")" || return
  connection_sha256="$(printf '%s\0' "$conn" | fresh_sha256_stream)" || return
  for digest in "$command_sha256" "$client_sha256" "$connection_sha256"; do
    fresh_is_sha256 "$digest" || return 1
  done

  : >"$output"
  start_mono_ns="$(now_ns)"
  deadline=$(( $(now_ms) + timeout_seconds * 1000 ))
  for ((reconnect = 1; reconnect <= wasix_lifecycle_reconnects; reconnect++)); do
    now="$(now_ms)"
    if [ "$now" -ge "$deadline" ]; then
      printf 'reconnect churn timed out after %s of %s attempts\n' \
        "$((reconnect - 1))" "$wasix_lifecycle_reconnects" >>"$output"
      status=124
      break
    fi
    remaining_ms=$((deadline - now))
    attempt_timeout_ms=10000
    if [ "$remaining_ms" -lt "$attempt_timeout_ms" ]; then
      attempt_timeout_ms="$remaining_ms"
    fi
    set +e
    fresh_run_process_group_timeout_ms "$attempt_timeout_ms" -- \
      env PGCONNECT_TIMEOUT=5 "$NATIVE_INSTALL_DIR/bin/psql" \
        "$conn" -X -qAt -v ON_ERROR_STOP=1 -c 'select 1' >>"$output" 2>&1
    status=$?
    set -e
    if [ "$status" -ne 0 ]; then
      printf 'reconnect %s of %s failed with exit %s\n' \
        "$reconnect" "$wasix_lifecycle_reconnects" "$status" >>"$output"
      break
    fi
    completed="$reconnect"
    if [ "$wasix_lifecycle_memory_checkpoint_every" -gt 0 ] &&
      [ $((reconnect % wasix_lifecycle_memory_checkpoint_every)) -eq 0 ] &&
      [ "$reconnect" -lt "$wasix_lifecycle_reconnects" ]; then
      set_resource_phase "$resource_phase_file" \
        "diagnostic:lifecycle-memory-quiescence-$reconnect"
      quiescence_start_ns="$(now_ns)"
      sleep "$wasix_lifecycle_memory_quiescence_seconds"
      quiescence_end_ns="$(now_ns)"
      if ! capture_lifecycle_memory_checkpoint "$memory_checkpoints" "$nonce" \
        "$((reconnect / wasix_lifecycle_memory_checkpoint_every))" \
        wave-quiescent "$reconnect" "$server_pid" "$server_birth_identity" \
        "$wasix_lifecycle_memory_quiescence_seconds" \
        "$quiescence_start_ns" "$quiescence_end_ns"; then
        status=1
        break
      fi
      set_resource_phase "$resource_phase_file" \
        "diagnostic:lifecycle-reconnect-churn"
    fi
  done
  end_mono_ns="$(now_ns)"
  if [ "$status" -eq 0 ] && [ "$completed" -eq "$wasix_lifecycle_reconnects" ]; then
    printf 'completed_reconnects=%s\n' "$completed" >>"$output"
    printf 'wasix-runtime-reconnect-churn-v1\tnonce=%s\trequested=%s\tcompleted=%s\tcommand_sha256=%s\tclient_sha256=%s\tconnection_sha256=%s\tstart_mono_ns=%s\tend_mono_ns=%s\tstatus=passed\tobserver_pid=%s\n' \
      "$nonce" "$wasix_lifecycle_reconnects" "$completed" "$command_sha256" \
      "$client_sha256" "$connection_sha256" "$start_mono_ns" "$end_mono_ns" \
      "$observer_pid" >>"$evidence_log"
    return 0
  fi
  if [ "$status" -eq 0 ]; then
    return 1
  fi
  return "$status"
}

run_wasix_lifecycle_plateau() {
  local conn="$1"
  local pgdata="$2"
  local wait_dump_log="$3"
  local resource_phase_file="$4"
  local target_report_dir="$5"
  local fence_request_file="$6"
  local fence_ack_file="$7"
  local server_pid="$8"
  local postmaster_pid nonce churn_status=1 validator_status evidence_status=0
  local memory_checkpoint_status=0 memory_validator_status=0
  local server_birth_identity final_memory_sequence
  local readiness_quiescence_start_ns readiness_quiescence_end_ns
  local final_quiescence_start_ns final_quiescence_end_ns
  local stabilization_status
  local fence_status freeze_status complete_phase_sequence complete_phase_mono_ns
  local -a freeze_args
  local reconnect_log="$target_report_dir/lifecycle-reconnect-churn.log"
  local frozen_log="$target_report_dir/wasix-runtime-evidence.log"
  local freeze_receipt="$target_report_dir/wasix-runtime-evidence.freeze.tsv"

  postmaster_pid="$(sed -n '1p' "$pgdata/postmaster.pid" 2>/dev/null || true)"
  case "$postmaster_pid" in
    ''|*[!0-9]*|0)
      printf 'could not read a positive guest postmaster PID from %s\n' \
        "$pgdata/postmaster.pid" >&2
      return 1
      ;;
  esac
  nonce="$(new_lifecycle_nonce)" || return
  server_birth_identity="$(fresh_process_birth_identity "$server_pid" 2>/dev/null || true)"
  if [ "$wasix_lifecycle_memory_checkpoint_every" -gt 0 ]; then
    [[ "$server_birth_identity" =~ ^linux-starttime:[1-9][0-9]*$ ]] || {
      echo 'could not capture the Linux Wasmer server birth identity for lifecycle memory checkpoints' >&2
      return 1
    }
    initialize_lifecycle_memory_checkpoints "$lifecycle_memory_checkpoints_tsv"
  fi
  lifecycle_phase_sequence=0

  set_resource_phase "$resource_phase_file" "diagnostic:lifecycle-cold-readiness"
  append_lifecycle_phase_marker "$wait_dump_log" "$nonce" cold-readiness "$postmaster_pid"
  sleep "$wasix_lifecycle_window_seconds"
  set_resource_phase "$resource_phase_file" "diagnostic:lifecycle-maintenance-stabilization"
  append_lifecycle_phase_marker "$wait_dump_log" "$nonce" maintenance-stabilization \
    "$postmaster_pid"
  set +e
  run_walwriter_stabilization "$conn" "$wait_dump_log" "$nonce" \
    "$postmaster_pid" "$target_report_dir"
  stabilization_status=$?
  set -e
  if [ "$stabilization_status" -ne 0 ]; then
    printf 'WAL-writer lifecycle stabilization failed; see %s\n' \
      "$target_report_dir/lifecycle-walwriter-stabilization.log" >&2
    set_resource_phase "$resource_phase_file" idle
    return "$stabilization_status"
  fi
  set_resource_phase "$resource_phase_file" "diagnostic:lifecycle-readiness"
  append_lifecycle_phase_marker "$wait_dump_log" "$nonce" readiness "$postmaster_pid"
  readiness_quiescence_start_ns="$(now_ns)"
  sleep "$wasix_lifecycle_window_seconds"
  set +e
  request_lifecycle_fence "$fence_request_file" "$fence_ack_file" "$nonce" 1 \
    readiness "$postmaster_pid" "$server_pid"
  fence_status=$?
  set -e
  readiness_quiescence_end_ns="$(now_ns)"
  if [ "$fence_status" -ne 0 ]; then
    churn_status=1
    evidence_status=1
  else
    if [ "$wasix_lifecycle_memory_checkpoint_every" -gt 0 ]; then
      set +e
      capture_lifecycle_memory_checkpoint "$lifecycle_memory_checkpoints_tsv" \
        "$nonce" 0 baseline-fenced 0 "$server_pid" "$server_birth_identity" \
        "$wasix_lifecycle_window_seconds" "$readiness_quiescence_start_ns" \
        "$readiness_quiescence_end_ns"
      memory_checkpoint_status=$?
      set -e
    fi
    if [ "$memory_checkpoint_status" -ne 0 ]; then
      churn_status=1
      evidence_status=1
    else
      set_resource_phase "$resource_phase_file" "diagnostic:lifecycle-reconnect-churn"
      append_lifecycle_phase_marker "$wait_dump_log" "$nonce" reconnect-churn "$postmaster_pid"
      set +e
      run_lifecycle_reconnect_churn "$conn" "$reconnect_log" "$wait_dump_log" \
        "$nonce" "$postmaster_pid" "$resource_phase_file" \
        "$lifecycle_memory_checkpoints_tsv" "$server_pid" \
        "$server_birth_identity"
      churn_status=$?
      set -e
      if [ "$churn_status" -ne 0 ]; then
        evidence_status=1
      else
        set_resource_phase "$resource_phase_file" "diagnostic:lifecycle-post-quiescence"
        append_lifecycle_phase_marker "$wait_dump_log" "$nonce" post-quiescence "$postmaster_pid"
        final_quiescence_start_ns="$(now_ns)"
        sleep "$wasix_lifecycle_window_seconds"
        set +e
        request_lifecycle_fence "$fence_request_file" "$fence_ack_file" "$nonce" 2 \
          post-quiescence "$postmaster_pid" "$server_pid"
        fence_status=$?
        set -e
        final_quiescence_end_ns="$(now_ns)"
        if [ "$fence_status" -ne 0 ]; then
          evidence_status=1
        elif [ "$wasix_lifecycle_memory_checkpoint_every" -gt 0 ]; then
          final_memory_sequence=$((
            (wasix_lifecycle_reconnects - 1) /
              wasix_lifecycle_memory_checkpoint_every + 1
          ))
          set +e
          capture_lifecycle_memory_checkpoint "$lifecycle_memory_checkpoints_tsv" \
            "$nonce" "$final_memory_sequence" final-fenced \
            "$wasix_lifecycle_reconnects" "$server_pid" \
            "$server_birth_identity" "$wasix_lifecycle_window_seconds" \
            "$final_quiescence_start_ns" "$final_quiescence_end_ns"
          memory_checkpoint_status=$?
          set -e
          if [ "$memory_checkpoint_status" -ne 0 ]; then
            evidence_status=1
          fi
        fi
      fi
    fi
  fi

  # Freeze an immutable prefix through the runtime-owned final fence. The
  # canonical complete marker is created inside that frozen artifact; the raw
  # writer log remains available separately and may continue to grow.
  complete_phase_sequence=$((lifecycle_phase_sequence + 1))
  complete_phase_mono_ns="$(now_ns)"
  freeze_args=(
    --raw-log "$wait_dump_log"
    --commit-ack "$fence_ack_file"
    --output "$frozen_log"
    --receipt "$freeze_receipt"
    --nonce "$nonce"
    --observer-pid "$postmaster_pid"
    --complete-phase-sequence "$complete_phase_sequence"
    --complete-phase-mono-ns "$complete_phase_mono_ns"
  )
  set +e
  python3 "$FRESH_ROOT/bin/freeze-wasix-lifecycle-evidence.py" "${freeze_args[@]}"
  freeze_status=$?
  set -e
  if [ "$freeze_status" -ne 0 ]; then
    evidence_status=1
  fi
  append_lifecycle_phase_marker "$wait_dump_log" "$nonce" complete "$postmaster_pid" \
    "$complete_phase_mono_ns"

  set +e
  python3 "$FRESH_ROOT/bin/validate-wasix-lifecycle-plateau.py" \
    --log "$frozen_log" \
    --freeze-receipt "$freeze_receipt" \
    --baseline-policy "$lifecycle_baseline_policy_tsv" \
    --baseline-binding "$lifecycle_baseline_binding_tsv" \
    --output "$lifecycle_plateau_tsv" \
    --target wasix \
    --nonce "$nonce" \
    --observer-pid "$postmaster_pid" \
    --min-samples 3 \
    --min-span-ms 1000 \
    --expected-interval-ms "$wasix_wait_dump_interval_ms"
  validator_status=$?
  set -e
  if [ "$wasix_lifecycle_memory_checkpoint_every" -gt 0 ]; then
    set +e
    python3 "$FRESH_ROOT/bin/validate-wasix-lifecycle-memory-plateau.py" \
      --input "$lifecycle_memory_checkpoints_tsv" \
      --runtime-plateau "$lifecycle_plateau_tsv" \
      --output "$lifecycle_memory_plateau_tsv" \
      --target wasix \
      --nonce "$nonce" \
      --server-pid "$server_pid" \
      --requested-reconnects "$wasix_lifecycle_reconnects" \
      --checkpoint-every "$wasix_lifecycle_memory_checkpoint_every" \
      --min-quiescence-seconds \
        "$wasix_lifecycle_memory_quiescence_seconds" \
      --max-pss-growth-kib "$max_lifecycle_pss_growth_kib" \
      --max-pss-anon-growth-kib "$max_lifecycle_pss_anon_growth_kib" \
      --max-heap-growth-kib "$max_lifecycle_heap_growth_kib" \
      --max-late-pss-slope-kib-per-1000-reconnects \
        "$max_late_lifecycle_pss_slope_kib_per_1000" \
      --max-late-pss-anon-slope-kib-per-1000-reconnects \
        "$max_late_lifecycle_pss_anon_slope_kib_per_1000" \
      --max-late-heap-slope-kib-per-1000-reconnects \
        "$max_late_lifecycle_heap_slope_kib_per_1000"
    memory_validator_status=$?
    set -e
  fi
  set_resource_phase "$resource_phase_file" idle
  [ "$churn_status" -eq 0 ] && [ "$evidence_status" -eq 0 ] &&
    [ "$validator_status" -eq 0 ] && [ "$memory_validator_status" -eq 0 ]
}

started_server_pid=""
started_server_pgid=""
started_server_birth_identity=""
server_command_prefix=()
server_cgroup_unit=""

configure_server_command_prefix() {
  local target="$1"
  local port="$2"
  local unit

  server_command_prefix=()
  server_cgroup_unit=""
  [ -n "$cgroup_memory_max$cgroup_memory_high$cgroup_swap_max" ] || return 0
  unit="oliphaunt-wasix-postmaster-$target-$$-$port"
  server_cgroup_unit="$unit"
  server_command_prefix=(
    systemd-run
    --user
    --scope
    --quiet
    --collect
    "--unit=$unit"
    --property=MemoryAccounting=yes
  )
  if [ "$cold_ownership" -eq 1 ]; then
    server_command_prefix+=(--property=IOAccounting=yes)
  fi
  if [ -n "$cgroup_memory_max" ]; then
    server_command_prefix+=("--property=MemoryMax=$cgroup_memory_max")
  fi
  if [ -n "$cgroup_memory_high" ]; then
    server_command_prefix+=("--property=MemoryHigh=$cgroup_memory_high")
  fi
  if [ -n "$cgroup_swap_max" ]; then
    server_command_prefix+=("--property=MemorySwapMax=$cgroup_swap_max")
  fi
}

launch_measured_server() {
  local limits_record="$1"
  shift
  local pre_soft pre_hard actual_soft actual_hard status="not-requested"

  pre_soft="$(ulimit -S -n)"
  pre_hard="$(ulimit -H -n)"
  if [ "$libpq_latency_samples" -gt 0 ]; then
    status="applied"
    case "$pre_hard" in
      unlimited) ;;
      ""|*[!0-9]*) status="invalid-hard-limit" ;;
      *) [ "$pre_hard" -ge "$libpq_latency_soft_nofile" ] || status="hard-limit-too-low" ;;
    esac
    if [ "$status" = "applied" ] &&
      ! ulimit -S -n "$libpq_latency_soft_nofile"; then
      status="set-failed"
    fi
  fi
  actual_soft="$(ulimit -S -n)"
  actual_hard="$(ulimit -H -n)"
  {
    printf 'pre_soft_nofile=%s\n' "$pre_soft"
    printf 'pre_hard_nofile=%s\n' "$pre_hard"
    printf 'actual_soft_nofile=%s\n' "$actual_soft"
    printf 'actual_hard_nofile=%s\n' "$actual_hard"
    printf 'status=%s\n' "$status"
  } >"$limits_record"
  if [ "$libpq_latency_samples" -gt 0 ] &&
    { [ "$status" != "applied" ] ||
      [ "$actual_soft" != "$libpq_latency_soft_nofile" ] ||
      [ "$actual_hard" != "$pre_hard" ]; }; then
    return 125
  fi
  exec "$@"
}

cold_first_query_monotonic_ns=""
cold_readiness_attempts=0
wait_for_ready() {
  local conn="$1"
  local server_pid="$2"
  local wait_log="$3"
  local attempt_log="$wait_log.attempt"
  local deadline now remaining_ms attempt_timeout_ms readiness_status

  : >"$wait_log"
  cold_first_query_monotonic_ns=""
  cold_readiness_attempts=0
  deadline=$(( $(now_ms) + timeout_seconds * 1000 ))
  while :; do
    now="$(now_ms)"
    if [ "$now" -ge "$deadline" ]; then
      printf 'readiness timed out after %s seconds\n' "$timeout_seconds" >>"$wait_log"
      rm -f "$attempt_log"
      return 124
    fi
    remaining_ms=$((deadline - now))
    attempt_timeout_ms=1000
    if [ "$remaining_ms" -lt "$attempt_timeout_ms" ]; then
      attempt_timeout_ms="$remaining_ms"
    fi
    set +e
    cold_readiness_attempts=$((cold_readiness_attempts + 1))
    fresh_run_process_group_timeout_ms "$attempt_timeout_ms" -- \
      env PGCONNECT_TIMEOUT=1 "$NATIVE_INSTALL_DIR/bin/psql" \
        "$conn" -X -q -c 'select 1' >"$attempt_log" 2>&1
    readiness_status=$?
    set -e
    if [ -s "$attempt_log" ]; then
      cat "$attempt_log" >>"$wait_log"
    fi
    rm -f "$attempt_log"
    if [ "$readiness_status" -eq 0 ]; then
      cold_first_query_monotonic_ns="$(now_ns)"
      return 0
    fi
    if [ "$readiness_status" -eq 125 ]; then
      echo "readiness process supervision failed" >>"$wait_log"
      return 125
    fi
    if ! pid_is_running "$server_pid"; then
      echo "server exited before readiness" >>"$wait_log"
      return 1
    fi
    sleep 0.1
  done
}

start_native_server() {
  local pgdata="$1"
  local port="$2"
  local initdb_log="$3"
  local server_log="$4"
  local limits_record="$5"
  local postgres_args initdb_status

  if run_logged_timeout "$timeout_seconds" "$initdb_log" \
    "$NATIVE_INSTALL_DIR/bin/initdb" -D "$pgdata" -A trust --no-locale \
      --encoding=UTF8 --no-instructions --wal-segsize=16; then
    initdb_status=0
  else
    initdb_status=$?
    return "$initdb_status"
  fi
  postgres_args=(
    -D "$pgdata"
    -h 127.0.0.1
    -p "$port"
    -c unix_socket_directories=
    -c "max_connections=$((connections + 32))"
  )
  if [ "${#effective_postgres_gucs[@]}" -gt 0 ]; then
    for guc in "${effective_postgres_gucs[@]}"; do
      postgres_args+=(-c "$guc")
    done
  fi
  fresh_spawn_process_group -- launch_measured_server "$limits_record" \
    "${server_command_prefix[@]}" \
    "$NATIVE_INSTALL_DIR/bin/postgres" "${postgres_args[@]}" \
    >"$server_log" 2>&1 || return
  started_server_pid="$FRESH_PROCESS_GROUP_PID"
  started_server_pgid="$FRESH_PROCESS_GROUP_PGID"
  started_server_birth_identity="$FRESH_PROCESS_GROUP_IDENTITY"
}

wasmer_bin=""
wasmer_bin_hash=""
wasmer_cache_dir=""
wasmer_compiler=""
wasmer_llvm_opt_level=""
wasmer_stack_size=""
wasmer_compiler_threads=""
wasmer_version=""
wasix_initdb_module=""
wasix_postgres_module=""
wasix_runtime_lib_dir=""
wasmer_args=()
wasmer_env=()
wasmer_env_command=()
cold_spawn_monotonic_ns=""

configure_wasmer_env_command() {
  wasmer_env_command=(env "$@")
  for wait_dump_name in "${wait_dump_environment_names[@]}"; do
    wasmer_env_command+=(-u "$wait_dump_name")
  done
  for sealed_loader_name in "${sealed_loader_environment_names[@]}"; do
    wasmer_env_command+=(-u "$sealed_loader_name")
  done
}

prepare_wasix_runtime() {
  wasmer_stack_size="${WASMER_STACK_SIZE:-33554432}"
  if [ "$wasix_runtime_mode" = "sealed-headless" ]; then
    wasmer_bin="$sealed_carrier_root/bin/wasmer-headless"
    if [ "$require_zero_write_aot" -eq 1 ]; then
      wasmer_bin_hash="$FRESH_QUALIFICATION_CARRIER_HEADLESS_SHA256"
    else
      wasmer_bin_hash="$(fresh_wasmer_bin_hash "$wasmer_bin")"
    fi
    [ "$wasmer_bin_hash" = "$sealed_executor_hash" ] || {
      echo 'selected sealed executor identity differs from carrier role receipt' >&2
      return 2
    }
    wasmer_cache_dir=""
    wasmer_compiler=""
    wasmer_llvm_opt_level=""
    wasmer_compiler_threads=""
    wasix_initdb_module="$sealed_initdb_module"
    wasix_postgres_module="$sealed_postgres_module"
    wasix_runtime_lib_dir="$sealed_lib_dir"
    configure_wasmer_env_command -u WASMER_DIR -u WASMER_CACHE_DIR
    if [ "$require_zero_write_aot" -ne 1 ]; then
      case "$sealed_executor_role" in
        postmaster-product)
          fresh_require_patched_postmaster_executor \
            "$wasmer_bin" \
            "$sealed_carrier_root/$sealed_executor_receipt_relative" \
            "$sealed_receipt"
          ;;
        full-headless)
          WASMER_BUILD_RECEIPT="$sealed_receipt" \
            fresh_require_patched_wasmer_headless "$wasmer_bin"
          ;;
        *)
          echo 'unsupported sealed executor role after carrier validation' >&2
          return 2
          ;;
      esac
    fi
    wasmer_version="$(env -u WASMER_DIR -u WASMER_CACHE_DIR "$wasmer_bin" --version 2>/dev/null || true)"
    cp -p "$sealed_manifest" "$report_dir/wasix-sealed-manifest.json"
    cp -p "$sealed_receipt" "$report_dir/wasix-sealed-wasmer-build.receipt"
    cp -p "$sealed_payload_inventory" "$report_dir/wasix-sealed-payload.files"
  else
    configure_wasmer_env_command
    wasmer_bin="$(fresh_wasmer_bin)"
    wasmer_bin_hash="$(fresh_wasmer_bin_hash "$wasmer_bin")"
    wasmer_cache_dir="$(fresh_wasmer_cache_dir "$wasmer_bin")"
    wasmer_compiler="$(fresh_wasmer_compiler)"
    wasmer_llvm_opt_level="${WASMER_LLVM_OPT_LEVEL:-aggressive}"
    wasmer_compiler_threads="${WASMER_COMPILER_THREADS:-$(fresh_jobs)}"
    wasix_initdb_module="$WASIX_INSTALL_DIR/bin/initdb"
    wasix_postgres_module="$WASIX_INSTALL_DIR/bin/postgres"
    wasix_runtime_lib_dir="$WASIX_INSTALL_DIR/lib"
    fresh_require_wasmer_compiler_cli "$wasmer_bin" "$wasmer_compiler" run
    if [ "$skip_precompile" != "1" ]; then
      "$FRESH_ROOT/bin/precompile-wasix-core.sh" >/dev/null
    fi
  fi
}

build_wasmer_args() {
  local dev_shm="$1"
  if [ "$wasix_runtime_mode" = "sealed-headless" ]; then
    wasmer_env=()
  else
    wasmer_env=(
      "WASMER_DIR=$FRESH_WORK_ROOT/tools/wasmer-home"
      "WASMER_CACHE_DIR=$wasmer_cache_dir"
    )
  fi
  wasmer_args=(run --quiet)
  if [ "$wasix_runtime_mode" = "sealed-headless" ]; then
    wasmer_args+=(--disable-cache --sealed-module-manifest "$sealed_manifest")
  else
    while IFS= read -r arg; do
      wasmer_args+=("$arg")
    done < <(fresh_wasmer_compiler_args_for "$wasmer_bin" run "$wasmer_compiler" "$wasmer_llvm_opt_level" "$wasmer_compiler_threads")
    if is_positive_number "$sample_seconds"; then
      wasmer_args+=(--profiler perfmap)
    fi
  fi
  wasmer_args+=(
    --stack-size "$wasmer_stack_size"
    --enable-exceptions
    --enable-threads
    --net
    --volume "$REPO_ROOT:$REPO_ROOT"
    --volume "$wasix_runtime_lib_dir:/lib"
    --volume "$dev_shm:/dev/shm"
  )
  case "$FRESH_WORK_ROOT/" in
    "$REPO_ROOT/"*) ;;
    *) wasmer_args+=(--volume "$FRESH_WORK_ROOT:$FRESH_WORK_ROOT") ;;
  esac
  if [ "$wasix_runtime_mode" = "sealed-headless" ]; then
    case "$sealed_carrier_root/" in
      "$REPO_ROOT/"*|"$FRESH_WORK_ROOT/"*) ;;
      *) wasmer_args+=(--volume "$sealed_carrier_root:$sealed_carrier_root") ;;
    esac
  fi
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
  local limits_record="$8"
  local fence_request_file="$9"
  local fence_ack_file="${10}"
  local cold_residency_receipt="${11}"
  local sealed_loader_audit="${12}"
  local cache_offer_initdb_telemetry="${13}"
  local cache_offer_postgres_telemetry="${14}"
  local postgres_args initdb_status
  local initdb_env=()
  local server_env=()

  build_wasmer_args "$dev_shm"
  initdb_env=("${wasmer_env[@]}")
  server_env=("${wasmer_env[@]}")
  if [ "$wasix_runtime_mode" = "sealed-headless" ]; then
    initdb_env+=(
      "OLIPHAUNT_WASIX_CACHE_OFFER_TELEMETRY_FILE=$cache_offer_initdb_telemetry"
    )
    server_env+=(
      "OLIPHAUNT_WASIX_CACHE_OFFER_TELEMETRY_FILE=$cache_offer_postgres_telemetry"
    )
  fi
  if [ "$require_zero_write_aot" -eq 1 ]; then
    initdb_env+=(
      "OLIPHAUNT_WASIX_REQUIRE_ZERO_WRITE_AOT=1"
      "OLIPHAUNT_WASIX_SEALED_LOADER_AUDIT_FILE=$sealed_loader_audit"
    )
    server_env+=(
      "OLIPHAUNT_WASIX_REQUIRE_ZERO_WRITE_AOT=1"
      "OLIPHAUNT_WASIX_SEALED_LOADER_AUDIT_FILE=$sealed_loader_audit"
    )
  fi
  if [ "$wasix_perf_stats" = "1" ]; then
    initdb_env+=("WASIX_PERF_STATS=1" "WASIX_PERF_STATS_FILE=$perf_initdb_log")
    server_env+=("WASIX_PERF_STATS=1" "WASIX_PERF_STATS_FILE=$perf_server_log")
  fi
  if [ "$wasix_wait_dump_interval_ms" -gt 0 ]; then
    initdb_env+=(
      "WASIX_WAIT_DUMP_INTERVAL_MS=$wasix_wait_dump_interval_ms"
      "WASIX_WAIT_DUMP_FILE=$perf_initdb_log"
      "WASIX_WAIT_DUMP_MAX_PER_WAIT=$wasix_wait_dump_max_per_wait"
      "WASIX_WAIT_DUMP_VERBOSE=$wasix_wait_dump_verbose"
    )
    server_env+=(
      "WASIX_WAIT_DUMP_INTERVAL_MS=$wasix_wait_dump_interval_ms"
      "WASIX_WAIT_DUMP_FILE=$perf_server_log"
      "WASIX_WAIT_DUMP_MAX_PER_WAIT=$wasix_wait_dump_max_per_wait"
      "WASIX_WAIT_DUMP_VERBOSE=$wasix_wait_dump_verbose"
    )
    if [ "$wasix_lifecycle_plateau" -eq 1 ]; then
      server_env+=(
        "WASIX_WAIT_DUMP_FENCE_REQUEST_FILE=$fence_request_file"
        "WASIX_WAIT_DUMP_FENCE_ACK_FILE=$fence_ack_file"
      )
    fi
  fi

  if run_logged_timeout "$timeout_seconds" "$initdb_log" \
    "${wasmer_env_command[@]}" "${initdb_env[@]}" \
      "$wasmer_bin" "${wasmer_args[@]}" "$wasix_initdb_module" -- \
        -D "$pgdata" -A trust --no-locale --encoding=UTF8 --no-instructions \
        --wal-segsize=16; then
    initdb_status=0
  else
    initdb_status=$?
    return "$initdb_status"
  fi

  postgres_args=(
    -D "$pgdata"
    -h 127.0.0.1
    -p "$port"
    -c unix_socket_directories=
    -c "max_connections=$((connections + 32))"
  )
  if [ "${#effective_postgres_gucs[@]}" -gt 0 ]; then
    for guc in "${effective_postgres_gucs[@]}"; do
      postgres_args+=(-c "$guc")
    done
  fi
  if [ "$cold_ownership" -eq 1 ]; then
    python3 "$FRESH_ROOT/bin/prove-linux-cold-residency.py" \
      --root "carrier=$sealed_carrier_root" \
      --root "pgdata=$pgdata" \
      --read-only-root carrier \
      --binding "execution_identity_sha256=$execution_identity_sha256" \
      --binding "carrier_manifest_sha256=$sealed_manifest_hash" \
      --binding "carrier_receipt_sha256=$sealed_receipt_hash" \
      --binding "carrier_payload_inventory_sha256=$sealed_payload_inventory_hash" \
      --output "$cold_residency_receipt" || return
    # FINAL COLD BOUNDARY: no carrier/PGDATA verifier, hash, stat, or content
    # read is permitted between the completed mincore proof above and exec.
    cold_spawn_monotonic_ns="$(now_ns)"
  fi
  fresh_spawn_process_group -- launch_measured_server "$limits_record" \
    "${server_command_prefix[@]}" "${wasmer_env_command[@]}" "${server_env[@]}" \
    "$wasmer_bin" "${wasmer_args[@]}" "$wasix_postgres_module" -- \
      "${postgres_args[@]}" >"$server_log" 2>&1 || return
  started_server_pid="$FRESH_PROCESS_GROUP_PID"
  started_server_pgid="$FRESH_PROCESS_GROUP_PGID"
  started_server_birth_identity="$FRESH_PROCESS_GROUP_IDENTITY"
}

write_connected_client_script() {
  local source_sql="$1"
  local connected_sql="$2"
  local ready_file="$3"
  local fanout_gate="$4"
  local end_file="$5"
  local drain_gate="$6"

  python3 - "$source_sql" "$connected_sql" "$ready_file" "$fanout_gate" \
    "$end_file" "$drain_gate" <<'PY'
import os
import shlex
import stat
import sys
from pathlib import Path

source, output, ready, start, completed, drain = map(Path, sys.argv[1:])
source_stat = os.lstat(source)
if not stat.S_ISREG(source_stat.st_mode) or stat.S_ISLNK(source_stat.st_mode):
    raise SystemExit(f"client SQL source must be a regular non-symlink file: {source}")
for label, path in (
    ("connected SQL", output),
    ("ready marker", ready),
    ("start gate", start),
    ("completion marker", completed),
    ("drain gate", drain),
):
    if "\n" in str(path) or "\r" in str(path) or "\0" in str(path):
        raise SystemExit(f"{label} path contains a control character")
if os.path.lexists(output):
    raise SystemExit(f"connected client SQL already exists: {output}")

ready_command = f": > {shlex.quote(str(ready))}"
start_command = (
    f"while [ ! -f {shlex.quote(str(start))} ]; do sleep 0.001; done"
)
clock_script = (
    'my $tmp = "$ARGV[0].tmp.$$"; '
    'sysopen(my $fh, $tmp, O_WRONLY | O_CREAT | O_EXCL, 0600) '
    'or die "open completion marker: $!"; '
    'printf {$fh} "%.0f\\n", clock_gettime(CLOCK_MONOTONIC) * 1000; '
    'close($fh) or die "close completion marker: $!"; '
    'rename($tmp, $ARGV[0]) or die "publish completion marker: $!"'
)
complete_command = shlex.join(
    [
        "perl",
        "-MTime::HiRes=clock_gettime,CLOCK_MONOTONIC",
        "-MFcntl=:DEFAULT",
        "-e",
        clock_script,
        str(completed),
    ]
)
drain_command = (
    f"while [ ! -f {shlex.quote(str(drain))} ]; do sleep 0.001; done"
)
payload = source.read_bytes()
if b"\r" in payload:
    raise SystemExit(f"client SQL source contains a carriage return: {source}")
with output.open("xb") as sink:
    sink.write(f"\\! {ready_command}\n".encode())
    sink.write(f"\\! {start_command}\n".encode())
    sink.write(payload)
    if payload and not payload.endswith(b"\n"):
        sink.write(b"\n")
    sink.write(f"\\! {complete_command}\n".encode())
    sink.write(f"\\! {drain_command}\n".encode())
os.chmod(output, 0o600)
PY
}

run_client_process() {
  local conn="$1"
  local client="$2"
  local client_connections="$3"
  local client_iterations="$4"
  local client_row_count="$5"
  local client_setup_rows="$6"
  local client_sql="$7"
  local client_log="$8"
  local client_status_file="$9"
  local client_end_file="${10}"
  local client_status

  set +e
  trap 'client_status=124; printf "%s\n" "$client_status" >"$client_status_file"; if [ ! -s "$client_end_file" ]; then now_ms >"$client_end_file"; fi; exit "$client_status"' TERM INT
  PGCONNECT_TIMEOUT=10 "$NATIVE_INSTALL_DIR/bin/psql" "$conn" \
    -X -q \
    -v ON_ERROR_STOP=1 \
    -v "client_id=$client" \
    -v "connections=$client_connections" \
    -v "iterations=$client_iterations" \
    -v "row_count=$client_row_count" \
    -v "setup_rows=$client_setup_rows" \
    -f "$client_sql" >"$client_log" 2>&1
  client_status=$?
  printf '%s\n' "$client_status" >"$client_status_file"
  if [ ! -s "$client_end_file" ]; then
    now_ms >"$client_end_file"
  fi
  exit "$client_status"
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
  local timed_out=0 ok_clients=0 failed_clients=0 status=0 pids=() pgids=() client_logs=() client_start=()
  local client_status_files=() client_end_files=() client_ready_files=()
  local client client_log client_status_file client_end_file client_ready_file deadline running pid pgid index
  local barrier_ready=1
  local client_status client_end client_wall psql_time psql_count wait_status
  local setup_status setup_timed_out verify_status epoll_intr_count
  local sample_log sample_stderr sample_status sample_pid perfmap perfmap_copy symbol_prefix
  local pg_wait_samples pg_wait_summary pg_wait_pid relation_footprint fanout_gate drain_gate
  local connected_client_sql early_client_exit

  mkdir -p "$workload_report_dir"
  if ! assert_no_client_process_residue "$target/$workload"; then
    printf 'refusing to start %s/%s after client process residue\n' \
      "$target" "$workload" >&2
    printf '%s\t%s\t125\t%s\t%s\t%s\t\t%s\t0\t\t0\t%s\t0\t0\t%s\t%s\n' \
      "$target" "$workload" "$connections" "$iterations" \
      "$(operation_count_for "$workload")" \
      "$(expected_verify_count_for "$workload")" "$connections" \
      "$server_log" "$workload_report_dir" >>"$summary_tsv"
    return 125
  fi
  write_workload_sql "$workload" "$setup_sql" "$client_sql" "$verify_sql"
  operation_count="$(operation_count_for "$workload")"
  expected_verify_count="$(expected_verify_count_for "$workload")"
  throughput=""

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
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t0\t\t0\t%s\t%s\t0\t%s\t%s\n' \
      "$target" "$workload" "$setup_status" "$connections" "$iterations" "$operation_count" \
      "" "$expected_verify_count" "$connections" "$setup_timed_out" "$server_log" \
      "$workload_report_dir" >>"$summary_tsv"
    set_resource_phase "$resource_phase_file" "idle"
    return "$setup_status"
  fi

  set_resource_phase "$resource_phase_file" "checkpoint:$workload"
  if ! prepare_fanout_checkpoint_state "$conn" "$workload_report_dir"; then
    printf '%s\t%s\t%s\tpreparation-failed\t\t\t\t\t\t\t\t\t\t\t\t\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$target" "$workload" "$checkpoint_policy" "$checkpoint_wal_budget_bytes" \
      "$workload_report_dir/checkpoint-before.tsv" "" \
      "$workload_report_dir/pg-stat-io-before.csv" "" \
      "$workload_report_dir/pg-stat-io-delta.tsv" "not-run" >>"$checkpoint_tsv"
    printf '%s\t%s\t1\t%s\t%s\t%s\t\t%s\t0\t\t0\t%s\t0\t0\t%s\t%s\n' \
      "$target" "$workload" "$connections" "$iterations" "$operation_count" \
      "$expected_verify_count" "$connections" "$server_log" "$workload_report_dir" \
      >>"$summary_tsv"
    set_resource_phase "$resource_phase_file" "idle"
    return 1
  fi

  set_resource_phase "$resource_phase_file" "fanout-preparing:$workload"
  snapshot_memory_map "$target" "$server_pid" "fanout-$workload-before" "$workload_report_dir"
  fanout_gate="$workload_report_dir/fanout.start"
  drain_gate="$workload_report_dir/fanout.drain"
  rm -f "$fanout_gate" "$drain_gate"
  sample_log="$workload_report_dir/sample.txt"
  sample_stderr="$workload_report_dir/sample.stderr.log"
  sample_status=0
  sample_pid=""
  pg_wait_samples="$workload_report_dir/pg-wait-samples.tsv"
  pg_wait_summary="$workload_report_dir/pg-wait-summary.tsv"
  pg_wait_pid=""
  for client in $(seq 1 "$connections"); do
    client_log="$workload_report_dir/client-$client.log"
    client_status_file="$workload_report_dir/client-$client.status"
    client_end_file="$workload_report_dir/client-$client.end_ms"
    client_ready_file="$workload_report_dir/client-$client.ready"
    connected_client_sql="$workload_report_dir/client-$client.connected.sql"
    rm -f "$client_status_file" "$client_end_file" "$client_ready_file"
    write_connected_client_script "$client_sql" "$connected_client_sql" \
      "$client_ready_file" "$fanout_gate" "$client_end_file" "$drain_gate"
    client_logs+=("$client_log")
    client_status_files+=("$client_status_file")
    client_end_files+=("$client_end_file")
    client_ready_files+=("$client_ready_file")
    client_start+=(0)
    if ! fresh_spawn_process_group -- run_client_process \
      "$conn" "$client" "$connections" "$iterations" "$row_count" \
      "$setup_rows" "$connected_client_sql" "$client_log" \
      "$client_status_file" "$client_end_file"; then
      terminate_active_client_process_groups || true
      assert_no_client_process_residue "$target/$workload spawn failure" || true
      printf 'could not isolate client %s for %s/%s\n' \
        "$client" "$target" "$workload" >&2
      return 125
    fi
    pid="$FRESH_PROCESS_GROUP_PID"
    pgid="$FRESH_PROCESS_GROUP_PGID"
    pids+=("$pid")
    pgids+=("$pgid")
    register_background_pid "$pid"
    register_client_process_group "$pid" "$pgid"
  done

  deadline=$(( $(now_ms) + timeout_seconds * 1000 ))
  while :; do
    running=0
    early_client_exit=0
    for index in "${!client_ready_files[@]}"; do
      client_ready_file="${client_ready_files[$index]}"
      client_status_file="${client_status_files[$index]}"
      if [ ! -f "$client_ready_file" ]; then
        if [ -f "$client_status_file" ]; then
          early_client_exit=1
          status=1
          barrier_ready=0
          break
        fi
        running=1
      fi
    done
    [ "$early_client_exit" -eq 0 ] || break
    [ "$running" -eq 0 ] && break
    if [ "$(now_ms)" -ge "$deadline" ]; then
      timed_out=1
      status=1
      barrier_ready=0
      break
    fi
    sleep 0.001
  done

  if [ "$barrier_ready" -eq 1 ] && float_gt_zero "$pg_wait_sample_interval"; then
    sample_pg_wait_events "$target" "$workload" "$conn" \
      "$pg_wait_samples" "$pg_wait_sample_interval" &
    pg_wait_pid="$!"
    register_background_pid "$pg_wait_pid"
  fi
  if [ "$barrier_ready" -eq 1 ] && [ "$target" = "wasix" ] && float_gt_zero "$sample_seconds"; then
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
    register_background_pid "$sample_pid"
  fi
  set_resource_phase "$resource_phase_file" "fanout:$workload"
  fanout_start="$(now_ms)"
  for index in "${!client_start[@]}"; do
    client_start[$index]="$fanout_start"
  done
  if [ "$barrier_ready" -ne 1 ]; then
    terminate_active_client_process_groups || status=1
  fi
  : >"$fanout_gate"
  deadline=$((fanout_start + timeout_seconds * 1000))
  while :; do
    running=0
    early_client_exit=0
    for index in "${!client_end_files[@]}"; do
      client_end_file="${client_end_files[$index]}"
      client_status_file="${client_status_files[$index]}"
      if [ -s "$client_end_file" ]; then
        continue
      fi
      if [ -f "$client_status_file" ]; then
        early_client_exit=1
        status=1
        break
      else
        running=1
      fi
    done
    [ "$early_client_exit" -eq 0 ] || break
    [ "$running" -eq 0 ] && break
    if [ "$(now_ms)" -ge "$deadline" ]; then
      timed_out=1
      terminate_active_client_process_groups || status=1
      break
    fi
    sleep 0.05
  done

  if [ "$early_client_exit" -eq 1 ]; then
    # Keep failed and still-running SQL inside the fanout phase.  A peer must
    # never continue untimed after one client has failed the measured batch.
    terminate_active_client_process_groups || status=1
  fi

  fanout_end="$fanout_start"
  for client_end_file in "${client_end_files[@]}"; do
    if [ -s "$client_end_file" ]; then
      client_end="$(tr -d '[:space:]' <"$client_end_file")"
      case "$client_end" in ''|*[!0-9]*) continue ;; esac
      if [ "$client_end" -gt "$fanout_end" ]; then
        fanout_end="$client_end"
      fi
    fi
  done
  set_resource_phase "$resource_phase_file" "fanout-draining:$workload"
  : >"$drain_gate"
  if [ "$timed_out" -eq 1 ]; then
    terminate_active_client_process_groups || status=1
  fi

  for index in "${!pids[@]}"; do
    pid="${pids[$index]}"
    pgid="${pgids[$index]}"
    client=$((index + 1))
    client_log="${client_logs[$index]}"
    client_status_file="${client_status_files[$index]}"
    client_end_file="${client_end_files[$index]}"
    if wait "$pid" 2>/dev/null; then
      wait_status=0
    else
      wait_status=$?
    fi
    unregister_background_pid "$pid"
    if [ -f "$client_status_file" ]; then
      client_status="$(tr -d '[:space:]' <"$client_status_file")"
    else
      client_status=124
    fi
    case "$client_status" in ''|*[!0-9]*) client_status="$wait_status" ;; esac
    if [ "$timed_out" -eq 1 ] && [ "$client_status" -eq 143 ]; then
      client_status=124
    fi
    if [ -s "$client_end_file" ]; then
      client_end="$(tr -d '[:space:]' <"$client_end_file")"
    else
      client_end="$(now_ms)"
    fi
    case "$client_end" in ''|*[!0-9]*) client_end="$(now_ms)" ;; esac
    if fresh_process_group_exists "$pgid" || fresh_supervision_pid_running "$pid"; then
      printf 'client process residue after %s/%s client %s: pid=%s pgid=%s\n' \
        "$target" "$workload" "$client" "$pid" "$pgid" >&2
      if fresh_terminate_process_group "$pgid" "$pid"; then
        unregister_client_process_group "$pid"
      fi
      client_status=125
      status=1
    else
      unregister_client_process_group "$pid"
    fi
    if [ "$client_end" -gt "$fanout_end" ]; then
      fanout_end="$client_end"
    fi
    client_wall=$((client_end - client_start[$index]))
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

  if ! assert_no_client_process_residue "$target/$workload post-fanout"; then
    status=1
  fi

  fanout_wall=$((fanout_end - fanout_start))
  rm -f "$fanout_gate" "$drain_gate"
  if [ -n "$pg_wait_pid" ]; then
    stop_pid "$pg_wait_pid"
    unregister_background_pid "$pg_wait_pid"
    summarize_pg_wait_events "$pg_wait_samples" "$pg_wait_summary"
  fi
  if ! finish_fanout_checkpoint_state \
    "$target" "$workload" "$conn" "$workload_report_dir"; then
    status=1
    if [ ! -s "$workload_report_dir/checkpoint-after.tsv" ]; then
      printf '%s\t%s\t%s\tcapture-failed\t\t\t\t\t\t\t\t\t\t\t\t\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$target" "$workload" "$checkpoint_policy" "$checkpoint_wal_budget_bytes" \
        "$workload_report_dir/checkpoint-before.tsv" \
        "$workload_report_dir/checkpoint-after.tsv" \
        "$workload_report_dir/pg-stat-io-before.csv" \
        "$workload_report_dir/pg-stat-io-after.csv" \
        "$workload_report_dir/pg-stat-io-delta.tsv" "failed" >>"$checkpoint_tsv"
    fi
  fi
  snapshot_memory_map "$target" "$server_pid" "fanout-$workload-after" "$workload_report_dir"

  if [ -n "$sample_pid" ]; then
    set +e
    wait "$sample_pid"
    sample_status=$?
    set -e
    unregister_background_pid "$sample_pid"
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

  if float_gt_zero "$quiescence_seconds"; then
    set_resource_phase "$resource_phase_file" "quiescence:$workload"
    snapshot_memory_map "$target" "$server_pid" "quiescence-$workload-before" "$workload_report_dir"
    sleep "$quiescence_seconds"
    snapshot_memory_map "$target" "$server_pid" "quiescence-$workload-after" "$workload_report_dir"
  fi

  epoll_intr_count=0
  if [ "$target" = "wasix" ] && [ -f "$server_log" ]; then
    epoll_intr_count="$(grep -c 'failed to epoll during deep sleep - intr' "$server_log" || true)"
    if [ "$epoll_intr_count" != "0" ]; then
      status=1
    fi
  fi

  if [ "$status" -eq 0 ]; then
    throughput="$(calc_rate "$operation_count" "$fanout_wall")"
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$target" "$workload" "$status" "$connections" "$iterations" "$operation_count" \
    "$verified_count" "$expected_verify_count" "$fanout_wall" "$throughput" \
    "$ok_clients" "$failed_clients" "$timed_out" "$epoll_intr_count" "$server_log" \
    "$workload_report_dir" >>"$summary_tsv"
  set_resource_phase "$resource_phase_file" "idle"
  return "$status"
}

validate_target_memory_evidence() {
  local target="$1"
  local target_report_dir="$2"
  local resource_samples_tsv="$3"
  local output="$target_report_dir/memory-evidence.tsv"
  local receipt="$target_report_dir/memory-validation-receipt.tsv"
  local require_cgroup=no
  local status sample_count workload required_phase_list=""
  local -a args

  if [ "$resource_detail" != full ]; then
    sample_count=0
    [ -s "$resource_samples_tsv" ] &&
      sample_count="$(awk 'END { print (NR > 0 ? NR - 1 : 0) }' "$resource_samples_tsv")"
    printf '%s\tnot-applicable\tresource-detail-%s\t%s\n' \
      "$target" "$resource_detail" "$sample_count" >>"$memory_evidence_tsv"
    return 0
  fi
  if [ "${#workloads[@]}" -eq 0 ]; then
    printf '%s\tfailed\tno-required-workload-phase\t0\n' "$target" \
      >>"$memory_evidence_tsv"
    return 1
  fi
  [ -n "$cgroup_memory_max$cgroup_memory_high$cgroup_swap_max" ] && require_cgroup=yes
  args=(
    --samples "$resource_samples_tsv"
    --target "$target"
    --interval-seconds "$resource_sample_interval"
    --require-cgroup "$require_cgroup"
    --memory-max "$cgroup_memory_max"
    --memory-high "$cgroup_memory_high"
    --swap-max "$cgroup_swap_max"
    --output "$output"
  )
  for workload in "${workloads[@]}"; do
    args+=(--require-phase "fanout:$workload")
    [ -z "$required_phase_list" ] || required_phase_list+=,
    required_phase_list+="fanout:$workload"
  done
  [ -z "$max_peak_pss_kib" ] ||
    args+=(--max-peak-pss-kib "$max_peak_pss_kib")
  [ -z "$max_peak_pss_anon_kib" ] ||
    args+=(--max-peak-pss-anon-kib "$max_peak_pss_anon_kib")
  [ -z "$max_peak_page_table_kib" ] ||
    args+=(--max-peak-page-table-kib "$max_peak_page_table_kib")
  [ -z "$max_cgroup_high_events_delta" ] ||
    args+=(--max-cgroup-high-events-delta "$max_cgroup_high_events_delta")
  [ -z "$max_psi_some_stall_fraction" ] ||
    args+=(--max-psi-some-stall-fraction "$max_psi_some_stall_fraction")
  [ -z "$max_psi_full_stall_fraction" ] ||
    args+=(--max-psi-full-stall-fraction "$max_psi_full_stall_fraction")
  set +e
  "$FRESH_ROOT/bin/validate-memory-evidence.sh" "${args[@]}"
  status=$?
  set -e
  if [ -s "$output" ]; then
    sed -n '2p' "$output" >>"$memory_evidence_tsv"
  else
    printf '%s\tfailed\tvalidator-produced-no-output\t0\n' "$target" \
      >>"$memory_evidence_tsv"
    status=1
  fi
  if [ -s "$resource_samples_tsv" ] && [ -s "$output" ]; then
    {
      printf 'schema_version\ttarget\tstatus\trequired_phases\tresource_samples_sha256\tmemory_budget_sha256\texecution_identity_sha256\tvalidator_sha256\tmemory_evidence_sha256\n'
      printf 'oliphaunt.wasix-postmaster.memory-validation.v1\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$target" "$([ "$status" -eq 0 ] && printf passed || printf failed)" \
        "$required_phase_list" \
        "$(fresh_wasmer_bin_hash "$resource_samples_tsv")" \
        "$memory_budget_identity" "$execution_identity_sha256" \
        "$(fresh_wasmer_bin_hash "$FRESH_ROOT/bin/validate-memory-evidence.sh")" \
        "$(fresh_wasmer_bin_hash "$output")"
    } >"$receipt"
  fi
  return "$status"
}

run_target() {
  local target="$1"
  local port="$2"
  local target_run_dir="$suite_root/$target"
  local target_report_dir="$report_dir/$target"
  local pgdata="$target_run_dir/pgdata"
  local dev_shm="$target_run_dir/dev-shm"
  local shared_memory_provider_evidence="$target_report_dir/shared-memory-provider.json"
  local shared_memory_provider_objects="$target_report_dir/shared-memory-objects.json"
  local shared_memory_provider_release="$target_report_dir/shared-memory-release.json"
  local shared_memory_provider_post_shutdown_objects="$target_report_dir/shared-memory-post-shutdown-objects.json"
  local shared_memory_provider_cleanup="$target_report_dir/shared-memory-cleanup.json"
  local shared_memory_provider_exit_objects="$target_report_dir/shared-memory-exit-objects.json"
  local shared_memory_provider_exit_release="$target_report_dir/shared-memory-exit-release.json"
  local shared_memory_provider_sha256=none
  local initdb_log="$target_report_dir/initdb.log"
  local server_log="$target_report_dir/server.log"
  local wasix_perf_initdb_log="$target_report_dir/wasix-perf-initdb.log"
  local wasix_perf_server_log="$target_report_dir/wasix-perf-server.log"
  local wait_dump_fence_request="$target_report_dir/wasix-runtime-fence.request"
  local wait_dump_fence_ack="$target_report_dir/wasix-runtime-fence.ack"
  local wait_log="$target_report_dir/wait.log"
  local shutdown_report="$target_report_dir/shutdown.txt"
  local limits_record="$target_report_dir/server-limits.launch"
  local cold_residency_receipt="$target_report_dir/cold-residency-receipt.json"
  local cold_first_query_snapshot="$target_report_dir/cold-first-query-cgroup.json"
  local cold_final_snapshot="$target_report_dir/cold-final-cgroup.json"
  local cold_sample="$target_report_dir/cold-ownership-sample.tsv"
  local sealed_loader_audit="$target_report_dir/sealed-loader-audit.jsonl"
  local sealed_loader_validation="$target_report_dir/sealed-loader-audit-validation.tsv"
  local cache_offer_initdb_telemetry="$target_report_dir/cache-offers-initdb.json"
  local cache_offer_postgres_telemetry="$target_report_dir/cache-offers-postgres.json"
  # The sealed executor derives this sibling with
  # Path::with_extension("adaptive.json"). The sole environment value above
  # remains an output destination and can never select or activate a policy.
  local cache_offer_postgres_adaptive_telemetry="${cache_offer_postgres_telemetry%.json}.adaptive.json"
  local cache_offer_initdb_validation="$target_report_dir/cache-offers-initdb-validation.tsv"
  local cache_offer_postgres_validation="$target_report_dir/cache-offers-postgres-validation.tsv"
  local cache_offer_postgres_adaptive_validation="$target_report_dir/cache-offers-postgres-adaptive-validation.tsv"
  local adaptive_cache_sample_contract="$target_report_dir/adaptive-cache-sample-contract.tsv"
  local resource_phase_file="$target_report_dir/resource-phase"
  local resource_stop_file="$target_report_dir/resource-stop"
  local resource_samples_tsv="$target_report_dir/resource-samples.tsv"
  local resource_sampler_log="$target_report_dir/resource-sampler.log"
  local db_user="wasix"
  local conn
  local server_pid=""
  local server_pgid=""
  local server_birth_identity=""
  local server_cgroup_dir=""
  local server_cgroup_identity=""
  local server_cgroup_membership_path=""
  local server_cgroup_memory_max_bytes=none
  local server_cgroup_memory_high_bytes=none
  local server_cgroup_swap_max_bytes=none
  local final_server_cgroup_memory_max_bytes=none
  local final_server_cgroup_memory_high_bytes=none
  local final_server_cgroup_swap_max_bytes=none
  local adaptive_sample_contract_status=passed
  local adaptive_sample_window_start_ns=""
  local adaptive_sample_window_end_ns=""
  local resource_monitor_pid=""
  local resource_monitor_status=0
  local cold_evidence_status=0
  local target_status=0
  local start_status workload workload_status stop_status=0
  local shutdown_report_sha256="" shared_memory_release_status=0
  local shared_memory_prepare_args=() shared_memory_prepare_identity
  local shared_memory_prepare_extra
  local provider_retention retention_status

  if [ "$target" = "native" ]; then
    db_user="$(id -un)"
  fi
  conn="postgresql://$db_user@127.0.0.1:$port/postgres"

  fresh_require_managed_generated_path "$target_run_dir" "$target benchmark run directory"
  fresh_require_managed_generated_path "$target_report_dir" "$target benchmark report directory"
  fresh_require_managed_generated_path "$pgdata" "$target benchmark PGDATA"
  fresh_require_managed_generated_path "$dev_shm" "$target benchmark shared-memory root"
  rm -rf "$target_run_dir" "$target_report_dir"
  mkdir -p "$pgdata" "$target_report_dir"
  if [ "$target" = wasix ]; then
    shared_memory_prepare_args=(
      prepare
      --provider "$shared_memory_provider"
      --evidence "$shared_memory_provider_evidence"
      --measurement-id "$run_label"
      --target wasix
      --output-format path-sha256-tsv
    )
    if [ "$shared_memory_provider" = portable-file-v1 ]; then
      shared_memory_prepare_args+=(--portable-root "$dev_shm")
    else
      # Trap-visible before the helper allocates. If output parsing, a
      # catchable signal, or verification interrupts adoption, exit cleanup
      # recovers the exact root from the immutable provider receipt.
      register_pending_external_shared_memory_provider \
        "$shared_memory_provider" "$shared_memory_provider_evidence" \
        "$shared_memory_provider_cleanup" "$shared_memory_provider_exit_objects" \
        "$shared_memory_provider_exit_release" || return 125
    fi
    shared_memory_prepare_identity="$(
      python3 "$FRESH_ROOT/lib/shared_memory_provider.py" \
        "${shared_memory_prepare_args[@]}"
    )" || return 125
    IFS=$'\t' read -r dev_shm shared_memory_provider_sha256 \
      shared_memory_prepare_extra <<<"$shared_memory_prepare_identity"
    if [ -z "$dev_shm" ] || [ -n "$shared_memory_prepare_extra" ] ||
      [[ ! "$shared_memory_provider_sha256" =~ ^[0-9a-f]{64}$ ]]; then
      echo 'shared-memory provider returned an invalid allocation identity' >&2
      return 125
    fi
    # The external root becomes trap-owned immediately after the atomic helper
    # result is parsed. No fallible hash/verification command can strand it.
    if [ "$shared_memory_provider" = linux-tmpfs-v1 ]; then
      register_external_shared_memory_provider \
        "$shared_memory_provider" "$dev_shm" \
        "$shared_memory_provider_evidence" "$shared_memory_provider_sha256" \
        "$shared_memory_provider_cleanup" "$shared_memory_provider_exit_objects" \
        "$shared_memory_provider_exit_release" || return 125
      unregister_pending_external_shared_memory_provider \
        "$shared_memory_provider_evidence" || return 125
    fi
    python3 "$FRESH_ROOT/lib/shared_memory_provider.py" verify \
      --provider "$shared_memory_provider" --root "$dev_shm" \
      --evidence "$shared_memory_provider_evidence" \
      --evidence-sha256 "$shared_memory_provider_sha256" || return 125
  else
    mkdir -p "$dev_shm"
  fi
  if fresh_tcp_port_open 127.0.0.1 "$port"; then
    printf 'refusing to start measured server on occupied port: 127.0.0.1:%s\n' \
      "$port" >&2
    printf '%s\tstartup\t125\t%s\t%s\t0\t\t\t0\t\t0\t0\t0\t0\t%s\t%s\n' \
      "$target" "$connections" "$iterations" "$server_log" "$target_report_dir" \
      >>"$summary_tsv"
    return 125
  fi
  rm -f "$resource_phase_file" "$resource_stop_file"
  set_resource_phase "$resource_phase_file" "startup"
  configure_server_command_prefix "$target" "$port"

  adaptive_sample_window_start_ns="$(now_ns)" || return 125
  set +e
  started_server_pid=""
  started_server_pgid=""
  started_server_birth_identity=""
  if [ "$target" = "native" ]; then
    start_native_server "$pgdata" "$port" "$initdb_log" "$server_log" "$limits_record"
    start_status=$?
  else
    start_wasix_server "$pgdata" "$dev_shm" "$port" "$initdb_log" "$server_log" \
      "$wasix_perf_initdb_log" "$wasix_perf_server_log" "$limits_record" \
      "$wait_dump_fence_request" "$wait_dump_fence_ack" \
      "$cold_residency_receipt" "$sealed_loader_audit" \
      "$cache_offer_initdb_telemetry" "$cache_offer_postgres_telemetry"
    start_status=$?
  fi
  server_pid="$started_server_pid"
  server_pgid="$started_server_pgid"
  server_birth_identity="$started_server_birth_identity"
  set -e

  if [ "$start_status" -ne 0 ] || [ -z "$server_pid" ]; then
    printf '%s\tstartup\t%s\t%s\t%s\t0\t\t\t0\t\t0\t0\t0\t0\t%s\t%s\n' \
      "$target" "$start_status" "$connections" "$iterations" "$server_log" "$target_report_dir" \
      >>"$summary_tsv"
    if [ "$start_status" -eq 0 ]; then
      append_libpq_latency_target_failure "$target" "server_start_missing_pid" \
        "$target_report_dir"
    else
      append_libpq_latency_target_failure "$target" "server_start_exit_$start_status" \
        "$target_report_dir"
    fi
    return 1
  fi
  if [ -z "$server_birth_identity" ] || [ "$server_pgid" != "$server_pid" ]; then
    printf 'could not capture exact server process-group identity: pid=%s pgid=%s\n' \
      "$server_pid" "$server_pgid" >&2
    fresh_terminate_owned_process_group "$server_pgid" "$server_pid" \
      "$server_birth_identity" 2>/dev/null || true
    return 125
  fi
  if ! capture_server_cgroup_identity "$server_pid" "$server_cgroup_unit"; then
    fresh_terminate_owned_process_group "$server_pgid" "$server_pid" \
      "$server_birth_identity" || true
    return 125
  fi
  server_cgroup_dir="$captured_server_cgroup_dir"
  server_cgroup_identity="$captured_server_cgroup_identity"
  server_cgroup_membership_path="$captured_server_cgroup_membership_path"
  if ! capture_server_cgroup_limits \
    "$server_cgroup_dir" "$server_cgroup_identity"; then
    fresh_terminate_owned_process_group "$server_pgid" "$server_pid" \
      "$server_birth_identity" || true
    return 125
  fi
  server_cgroup_memory_max_bytes="$captured_server_cgroup_memory_max_bytes"
  server_cgroup_memory_high_bytes="$captured_server_cgroup_memory_high_bytes"
  server_cgroup_swap_max_bytes="$captured_server_cgroup_swap_max_bytes"
  if [ "$adaptive_cache_evidence_policy" = constrained-linux-wal-action-v1 ] &&
    { [ -z "$server_cgroup_identity" ] ||
      [ "$server_cgroup_memory_max_bytes" != "$cgroup_memory_max_bytes" ] ||
      [ "$server_cgroup_memory_high_bytes" != "$cgroup_memory_high_bytes" ] ||
      [ "$server_cgroup_swap_max_bytes" != "$cgroup_swap_max_bytes" ]; }; then
    printf 'measured server cgroup contract differs from requested exact limits: identity=%s requested=%s/%s/%s observed=%s/%s/%s\n' \
      "${server_cgroup_identity:-none}" "$cgroup_memory_max_bytes" \
      "$cgroup_memory_high_bytes" "$cgroup_swap_max_bytes" \
      "$server_cgroup_memory_max_bytes" "$server_cgroup_memory_high_bytes" \
      "$server_cgroup_swap_max_bytes" >&2
    fresh_terminate_owned_process_group "$server_pgid" "$server_pid" \
      "$server_birth_identity" || true
    return 125
  fi
  register_server_pid "$server_pid" "$server_pgid" "$server_birth_identity" \
    "$port" "$server_cgroup_dir" "$server_cgroup_identity"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -s "$limits_record" ] && break
    sleep 0.01
  done
  if ! record_server_limits "$target" "$limits_record" "$server_pid"; then
    stop_server "$server_pid" "$server_pgid" "$server_birth_identity" "$port" \
      "$server_cgroup_dir" "$server_cgroup_identity" "$server_log" \
      "$shutdown_report" "$target" "$server_cgroup_membership_path" || true
    return 125
  fi

  if [ "$resource_detail" != "off" ]; then
    monitor_resource_usage "$target" "$server_pid" "$resource_phase_file" "$resource_stop_file" \
      "$resource_samples_tsv" "$resource_sample_interval" "$resource_detail" \
      "$server_cgroup_dir" \
      2>"$resource_sampler_log" &
    resource_monitor_pid="$!"
    register_background_pid "$resource_monitor_pid"
  fi

  set_resource_phase "$resource_phase_file" "readiness"
  if ! wait_for_ready "$conn" "$server_pid" "$wait_log"; then
    printf '%s\treadiness\t1\t%s\t%s\t0\t\t\t0\t\t0\t0\t0\t0\t%s\t%s\n' \
      "$target" "$connections" "$iterations" "$server_log" "$target_report_dir" >>"$summary_tsv"
    append_libpq_latency_target_failure "$target" "readiness_failed" "$target_report_dir"
    set_resource_phase "$resource_phase_file" "stopping"
    stop_server "$server_pid" "$server_pgid" "$server_birth_identity" "$port" \
      "$server_cgroup_dir" "$server_cgroup_identity" "$server_log" \
      "$shutdown_report" "$target" "$server_cgroup_membership_path" || true
    if [ -n "$resource_monitor_pid" ]; then
      touch "$resource_stop_file"
      set +e
      wait "$resource_monitor_pid"
      resource_monitor_status=$?
      set -e
      unregister_background_pid "$resource_monitor_pid"
      summarize_resource_usage_checked "$target" "$resource_samples_tsv" \
        "$resource_tsv" || true
      validate_target_memory_evidence "$target" "$target_report_dir" \
        "$resource_samples_tsv" || true
      if [ "$resource_monitor_status" -ne 0 ]; then
        printf 'resource sampler failed for %s; see %s\n' "$target" "$resource_sampler_log" >&2
      fi
    fi
    return 1
  fi

  if [ "$cold_ownership" -eq 1 ]; then
    if [ -z "$cold_spawn_monotonic_ns" ] ||
      [ -z "$cold_first_query_monotonic_ns" ] ||
      [ "$cold_readiness_attempts" -lt 1 ] ||
      ! python3 "$FRESH_ROOT/bin/capture-linux-cgroup-v2.py" \
        --cgroup-dir "$server_cgroup_dir" \
        --cgroup-identity "$server_cgroup_identity" \
        --output "$cold_first_query_snapshot"
    then
      echo "failed to capture exact cold first-query cgroup evidence" >&2
      target_status=1
      cold_evidence_status=1
    fi
  fi

  if [ "$target" = wasix ]; then
    if ! python3 "$FRESH_ROOT/lib/shared_memory_provider.py" capture-objects \
      --provider "$shared_memory_provider" --root "$dev_shm" \
      --evidence "$shared_memory_provider_evidence" \
      --evidence-sha256 "$shared_memory_provider_sha256" \
      --output "$shared_memory_provider_objects" --require-main yes \
      --cgroup-identity "${server_cgroup_identity:-none}"; then
      printf 'live PostgreSQL shared-memory backing validation failed for %s; see %s\n' \
        "$target" "$target_report_dir" >&2
      target_status=1
    fi
  fi

  snapshot_memory_map "$target" "$server_pid" "readiness" "$target_report_dir"
  if capture_checkpoint_settings \
    "$conn" "$target_report_dir/effective-postgres-settings.tsv"; then
    if [ "$profile_resolution_active" -eq 1 ] &&
      ! fresh_validate_postgres_profile_settings \
        "$target_report_dir/effective-postgres-settings.tsv" \
        "$target_report_dir/effective-postgres-profile-validation.tsv"; then
      printf 'effective PostgreSQL profile validation failed for %s\n' \
        "$target" >&2
      target_status=1
    fi
  else
    printf 'could not capture target-level effective PostgreSQL settings for %s\n' \
      "$target" >&2
    target_status=1
  fi
  if [ "$wasix_lifecycle_plateau" -eq 1 ]; then
    if ! run_wasix_lifecycle_plateau "$conn" "$pgdata" "$wasix_perf_server_log" \
      "$resource_phase_file" "$target_report_dir" "$wait_dump_fence_request" \
      "$wait_dump_fence_ack" "$server_pid"; then
      printf 'WASIX lifecycle plateau validation failed; see %s\n' \
        "$lifecycle_plateau_tsv" >&2
      target_status=1
    fi
  fi
  if float_gt_zero "$quiescence_seconds"; then
    set_resource_phase "$resource_phase_file" "quiescence:readiness"
    sleep "$quiescence_seconds"
    snapshot_memory_map "$target" "$server_pid" "readiness-quiescent" "$target_report_dir"
  fi
  set_resource_phase "$resource_phase_file" "idle"
  if [ "$libpq_latency_samples" -gt 0 ]; then
    if ! run_libpq_latency_suite "$target" "$conn" "$target_report_dir" \
      "$resource_phase_file" "$server_pid"
    then
      target_status=1
    fi
  fi
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

  if [ "$cold_ownership" -eq 1 ]; then
    set_resource_phase "$resource_phase_file" "cold:post-first-query"
    if ! python3 "$FRESH_ROOT/bin/capture-linux-cgroup-v2.py" \
      --cgroup-dir "$server_cgroup_dir" \
      --cgroup-identity "$server_cgroup_identity" \
      --output "$cold_final_snapshot"
    then
      echo "failed to capture exact cold final cgroup evidence" >&2
      target_status=1
      cold_evidence_status=1
    fi
  fi
  if [ "$adaptive_cache_evidence_policy" = constrained-linux-wal-action-v1 ]; then
    if ! capture_server_cgroup_limits \
      "$server_cgroup_dir" "$server_cgroup_identity"; then
      echo 'could not recapture final exact server cgroup limits' >&2
      adaptive_sample_contract_status=failed
      target_status=1
    else
      final_server_cgroup_memory_max_bytes="$captured_server_cgroup_memory_max_bytes"
      final_server_cgroup_memory_high_bytes="$captured_server_cgroup_memory_high_bytes"
      final_server_cgroup_swap_max_bytes="$captured_server_cgroup_swap_max_bytes"
      if [ "$final_server_cgroup_memory_max_bytes" != "$server_cgroup_memory_max_bytes" ] ||
        [ "$final_server_cgroup_memory_high_bytes" != "$server_cgroup_memory_high_bytes" ] ||
        [ "$final_server_cgroup_swap_max_bytes" != "$server_cgroup_swap_max_bytes" ]; then
        echo 'server cgroup limits changed during the measured target lifetime' >&2
        adaptive_sample_contract_status=failed
        target_status=1
      fi
    fi
  fi
  set_resource_phase "$resource_phase_file" "stopping"
  if stop_server "$server_pid" "$server_pgid" "$server_birth_identity" "$port" \
    "$server_cgroup_dir" "$server_cgroup_identity" "$server_log" \
    "$shutdown_report" "$target" "$server_cgroup_membership_path"; then
    stop_status=0
  else
    stop_status=$?
    target_status=1
  fi
  if [ "$target" = wasix ]; then
    if [ "$stop_status" -eq 0 ]; then
      shutdown_report_sha256="$(
        fresh_wasmer_bin_hash "$shutdown_report"
      )" || shared_memory_release_status=1
      if [ "$shared_memory_release_status" -eq 0 ] &&
        ! python3 "$FRESH_ROOT/lib/shared_memory_provider.py" assert-empty \
          --provider "$shared_memory_provider" --root "$dev_shm" \
          --evidence "$shared_memory_provider_evidence" \
          --evidence-sha256 "$shared_memory_provider_sha256" \
          --output "$shared_memory_provider_release" \
          --release-kind clean-postgresql-shutdown-v1 \
          --lifecycle-evidence "$shutdown_report" \
          --lifecycle-evidence-sha256 "$shutdown_report_sha256"; then
        shared_memory_release_status=1
      fi
    else
      shared_memory_release_status=1
    fi
    if [ "$shared_memory_release_status" -ne 0 ]; then
      printf 'clean WASIX shared-memory release validation failed for %s; see %s\n' \
        "$target" "$target_report_dir" >&2
      target_status=1
      python3 "$FRESH_ROOT/lib/shared_memory_provider.py" capture-objects \
        --provider "$shared_memory_provider" --root "$dev_shm" \
        --evidence "$shared_memory_provider_evidence" \
        --evidence-sha256 "$shared_memory_provider_sha256" \
        --output "$shared_memory_provider_post_shutdown_objects" \
        --require-main no --cgroup-identity post-shutdown || true
    fi
  fi
  adaptive_sample_window_end_ns="$(now_ns)" || {
    echo 'could not capture adaptive sample window end' >&2
    target_status=1
  }
  if [ "$target" = wasix ] && [ "$wasix_runtime_mode" = sealed-headless ]; then
    sample_contract_mode=portable-not-required
    contract_cgroup_path=none
    contract_cgroup_identity=none
    contract_memory_max_bytes=none
    contract_memory_high_bytes=none
    contract_swap_max_bytes=none
    contract_final_memory_max_bytes=none
    contract_final_memory_high_bytes=none
    contract_final_swap_max_bytes=none
    contract_window_start_ns=none
    contract_window_end_ns=none
    if [ "$adaptive_cache_evidence_policy" = constrained-linux-wal-action-v1 ]; then
      sample_contract_mode=constrained-exact-cgroup-time
      # cgroup_path is the unified-hierarchy membership path from
      # /proc/PID/cgroup.  The controller filesystem path is deliberately
      # kept separate in server_cgroup_dir: the two live in different path
      # namespaces and must never be compared lexically.
      contract_cgroup_path="$server_cgroup_membership_path"
      contract_cgroup_identity="$server_cgroup_identity"
      contract_memory_max_bytes="$server_cgroup_memory_max_bytes"
      contract_memory_high_bytes="$server_cgroup_memory_high_bytes"
      contract_swap_max_bytes="$server_cgroup_swap_max_bytes"
      contract_final_memory_max_bytes="$final_server_cgroup_memory_max_bytes"
      contract_final_memory_high_bytes="$final_server_cgroup_memory_high_bytes"
      contract_final_swap_max_bytes="$final_server_cgroup_swap_max_bytes"
      contract_window_start_ns="$adaptive_sample_window_start_ns"
      contract_window_end_ns="$adaptive_sample_window_end_ns"
    fi
    printf 'schema_version\tmeasurement_id\ttarget\tacceptance_policy\tcontract_mode\tbase_policy_sha256\tvalidator_sha256\tmanifest_sha256\tcgroup_path\tcgroup_identity\tserver_pid\tserver_birth_identity\tcgroup_unit\trequested_memory_max\trequested_memory_high\trequested_swap_max\trequested_memory_max_bytes\trequested_memory_high_bytes\trequested_swap_max_bytes\tobserved_initial_memory_max_bytes\tobserved_initial_memory_high_bytes\tobserved_initial_swap_max_bytes\tobserved_final_memory_max_bytes\tobserved_final_memory_high_bytes\tobserved_final_swap_max_bytes\tsample_window_start_monotonic_ns\tsample_window_end_monotonic_ns\tstatus\n' \
      >"$adaptive_cache_sample_contract"
    {
      printf '%s' oliphaunt.wasix-postmaster.adaptive-cache-sample-contract.v1
      printf '\t%s' "$run_label" "$target" "$adaptive_cache_evidence_policy" \
        "$sample_contract_mode" "$adaptive_cache_evidence_policy_identity" \
        "$adaptive_cache_validator_sha256" \
        "$adaptive_cache_bound_manifest_sha256" "$contract_cgroup_path" \
        "$contract_cgroup_identity" "$server_pid" "$server_birth_identity" \
        "${server_cgroup_unit:-none}" "${cgroup_memory_max:-none}" \
        "${cgroup_memory_high:-none}" "${cgroup_swap_max:-none}" \
        "$([ "$sample_contract_mode" = constrained-exact-cgroup-time ] && printf '%s' "$cgroup_memory_max_bytes" || printf none)" \
        "$([ "$sample_contract_mode" = constrained-exact-cgroup-time ] && printf '%s' "$cgroup_memory_high_bytes" || printf none)" \
        "$([ "$sample_contract_mode" = constrained-exact-cgroup-time ] && printf '%s' "$cgroup_swap_max_bytes" || printf none)" \
        "$contract_memory_max_bytes" "$contract_memory_high_bytes" \
        "$contract_swap_max_bytes" "$contract_final_memory_max_bytes" \
        "$contract_final_memory_high_bytes" "$contract_final_swap_max_bytes" \
        "$contract_window_start_ns" "$contract_window_end_ns" \
        "$adaptive_sample_contract_status"
      printf '\n'
    } >>"$adaptive_cache_sample_contract"
    chmod 0444 "$adaptive_cache_sample_contract"
    if ! python3 "$FRESH_ROOT/bin/validate-file-cache-telemetry.py" \
      --telemetry "$cache_offer_initdb_telemetry" \
      --manifest "$sealed_manifest" \
      --output "$cache_offer_initdb_validation" \
      --expected-workload runtime:initdb
    then
      printf 'initdb cache-offer telemetry validation failed for %s; see %s\n' \
        "$target" "$target_report_dir" >&2
      target_status=1
    else
      chmod 0444 "$cache_offer_initdb_telemetry"
    fi
    if ! python3 "$FRESH_ROOT/bin/validate-file-cache-telemetry.py" \
      --telemetry "$cache_offer_postgres_telemetry" \
      --manifest "$sealed_manifest" \
      --output "$cache_offer_postgres_validation" \
      --expected-workload runtime:postgres
    then
      printf 'postmaster cache-offer telemetry validation failed for %s; see %s\n' \
        "$target" "$target_report_dir" >&2
      target_status=1
    else
      chmod 0444 "$cache_offer_postgres_telemetry"
    fi
    if ! assert_frozen_adaptive_cache_evidence_policy; then
      printf 'adaptive cache evidence policy changed before validation for %s\n' \
        "$target" >&2
      target_status=1
    else
      adaptive_validator_args=(
        --telemetry "$cache_offer_postgres_adaptive_telemetry"
        --manifest "$sealed_manifest"
        --output "$cache_offer_postgres_adaptive_validation"
        --acceptance-policy "$adaptive_cache_evidence_policy"
        --measurement-id "$run_label"
        --target "$target"
      )
      if [ "$adaptive_cache_evidence_policy" = constrained-linux-wal-action-v1 ]; then
        adaptive_validator_args+=(
          --cgroup-identity "$contract_cgroup_identity"
          --cgroup-memory-max-bytes "$contract_memory_max_bytes"
          --cgroup-memory-high-bytes "$contract_memory_high_bytes"
          --cgroup-swap-max-bytes "$contract_swap_max_bytes"
          --sample-window-start-monotonic-ns "$contract_window_start_ns"
          --sample-window-end-monotonic-ns "$contract_window_end_ns"
        )
      fi
      if ! python3 "$adaptive_cache_validator" "${adaptive_validator_args[@]}"
      then
        printf 'postmaster adaptive cache telemetry validation failed for %s; see %s\n' \
          "$target" "$target_report_dir" >&2
        target_status=1
      else
        chmod 0444 "$cache_offer_postgres_adaptive_telemetry"
      fi
    fi
  fi
  if [ "$target" = wasix ] && [ "$require_zero_write_aot" -eq 1 ]; then
    if ! python3 "$FRESH_ROOT/bin/validate-sealed-loader-audit.py" \
      --audit "$sealed_loader_audit" \
      --manifest "$sealed_manifest" \
      --output "$sealed_loader_validation" \
      --required-snapshot-mode direct-immutable-inode
    then
      printf 'direct immutable sealed-loader audit validation failed for %s; see %s\n' \
        "$target" "$target_report_dir" >&2
      target_status=1
    else
      chmod 0444 "$sealed_loader_audit"
    fi
  fi
  if [ -n "$resource_monitor_pid" ]; then
    touch "$resource_stop_file"
    set +e
    wait "$resource_monitor_pid"
    resource_monitor_status=$?
    set -e
    unregister_background_pid "$resource_monitor_pid"
    if ! summarize_resource_usage_checked "$target" "$resource_samples_tsv" \
      "$resource_tsv"; then
      target_status=1
    fi
    if ! validate_target_memory_evidence "$target" "$target_report_dir" \
      "$resource_samples_tsv"; then
      printf 'memory evidence validation failed for %s; see %s\n' "$target" \
        "$target_report_dir/memory-evidence.tsv" >&2
      target_status=1
    fi
    if [ "$resource_monitor_status" -ne 0 ]; then
      printf 'resource sampler failed for %s; see %s\n' "$target" "$resource_sampler_log" >&2
      target_status=1
    fi
  else
    validate_target_memory_evidence "$target" "$target_report_dir" \
      "$resource_samples_tsv" || target_status=1
  fi
  if [ "$cold_ownership" -eq 1 ]; then
    if [ "$cold_evidence_status" -ne 0 ] ||
      ! python3 "$FRESH_ROOT/bin/validate-wasix-cold-ownership.py" \
        --residency-receipt "$cold_residency_receipt" \
        --first-query-snapshot "$cold_first_query_snapshot" \
        --final-snapshot "$cold_final_snapshot" \
        --resource-samples "$resource_samples_tsv" \
        --execution-identity "$execution_identity_tsv" \
        --carrier-root "$sealed_carrier_root" \
        --pgdata-root "$pgdata" \
        --spawn-monotonic-ns "$cold_spawn_monotonic_ns" \
        --first-query-monotonic-ns "$cold_first_query_monotonic_ns" \
        --readiness-attempts "$cold_readiness_attempts" \
        --memory-max "$cgroup_memory_max" \
        --memory-high "$cgroup_memory_high" \
        --swap-max "$cgroup_swap_max" \
        --output "$cold_sample"
    then
      printf 'cold ownership validation failed for %s; see %s\n' \
        "$target" "$target_report_dir" >&2
      target_status=1
    fi
  fi
  if [ "$target_status" -ne 0 ]; then
    invalidate_derived_summary "$target_status" "$target"
    invalidate_libpq_latency_summary "$target_status" "$target"
  fi
  if [ "$target" = "wasix" ] && [ "$wasix_perf_stats" = "1" ] && [ -s "$wasix_perf_server_log" ]; then
    "$FRESH_ROOT/bin/summarize-wasix-perf-stats.sh" \
      "$wasix_perf_server_log" \
      "$target_report_dir/wasix-perf-server" \
      >"$target_report_dir/wasix-perf-summary.log" 2>&1 || true
  fi
  provider_retention=not-applicable
  if [ "$target" = wasix ]; then
    if [ "$shared_memory_provider" = linux-tmpfs-v1 ]; then
      if release_external_shared_memory_providers target-complete; then
        provider_retention=removed-after-target
      else
        provider_retention=retained-cleanup-refused
        [ "$target_status" -ne 0 ] || target_status=125
        invalidate_derived_summary "$target_status" "$target"
        invalidate_libpq_latency_summary "$target_status" "$target"
      fi
    else
      provider_retention=retained
    fi
  fi
  if [ "$discard_pgdata" -eq 1 ] && [ "$target_status" -eq 0 ]; then
    if [ "$target" = wasix ] &&
      [ "$shared_memory_provider" = portable-file-v1 ]; then
      if python3 "$FRESH_ROOT/lib/shared_memory_provider.py" cleanup \
        --provider "$shared_memory_provider" --root "$dev_shm" \
        --evidence "$shared_memory_provider_evidence" \
        --evidence-sha256 "$shared_memory_provider_sha256" \
        --cleanup-evidence "$shared_memory_provider_cleanup" \
        --reason successful-discard; then
        provider_retention=removed-after-success
      else
        target_status=125
      fi
    fi
    if [ "$target_status" -eq 0 ]; then
      if [ "$target" = native ]; then
        fresh_require_managed_generated_path "$pgdata" "native benchmark PGDATA"
        fresh_require_managed_generated_path "$dev_shm" "native benchmark shared-memory root"
        rm -rf -- "$pgdata" "$dev_shm"
      else
        fresh_require_managed_generated_path "$pgdata" "WASIX benchmark PGDATA"
        rm -rf -- "$pgdata"
      fi
      retention_status=discarded-after-success
    else
      retention_status=retained-cleanup-failed
      invalidate_derived_summary "$target_status" "$target"
      invalidate_libpq_latency_summary "$target_status" "$target"
    fi
  else
    retention_status=retained
  fi
  {
    printf 'status=%s\npgdata=%s\ndev_shm=%s\n' \
      "$retention_status" "$pgdata" "$dev_shm"
    printf 'shared_memory_provider=%s\n' \
      "$([ "$target" = wasix ] && printf '%s' "$shared_memory_provider" || printf not-applicable)"
    printf 'shared_memory_provider_evidence=%s\n' \
      "$([ "$target" = wasix ] && printf '%s' "$shared_memory_provider_evidence" || printf none)"
    printf 'shared_memory_provider_evidence_sha256=%s\n' \
      "$shared_memory_provider_sha256"
    printf 'shared_memory_provider_retention=%s\n' "$provider_retention"
  } >"$target_report_dir/run-retention.txt"
  return "$target_status"
}

if [ "$need_wasix" -eq 1 ]; then
  prepare_wasix_runtime
  write_execution_identity
  if [ "$wasix_lifecycle_plateau" -eq 1 ]; then
    write_lifecycle_baseline_binding
  fi
  {
    printf -- '- WASIX runtime mode: `%s`\n' "$wasix_runtime_mode"
    printf -- '- Wasmer binary: `%s`\n' "$wasmer_bin"
    printf -- '- Wasmer binary hash: `%s`\n' "$wasmer_bin_hash"
    printf -- '- Execution identity receipt: `%s` (`%s`)\n' \
      "$execution_identity_tsv" "$execution_identity_sha256"
    if [ "$wasix_runtime_mode" = "sealed-headless" ]; then
      printf -- '- Wasmer version: `%s`\n' "$wasmer_version"
      printf -- '- Wasmer cache: `disabled (--disable-cache; sealed in-memory modules only)`\n'
      printf -- '- Wasmer compiler: `unavailable (headless runtime)`\n'
      printf -- '- Sealed carrier: `%s`\n' "$sealed_carrier_root"
      printf -- '- Sealed manifest: `%s`\n' "$sealed_manifest"
      printf -- '- Sealed manifest SHA-256: `%s`\n' "$sealed_manifest_hash"
      printf -- '- Sealed receipt: `%s`\n' "$sealed_receipt"
      printf -- '- Sealed receipt SHA-256: `%s`\n' "$sealed_receipt_hash"
      printf -- '- Sealed payload inventory: `%s`\n' "$sealed_payload_inventory"
      printf -- '- Sealed payload inventory SHA-256: `%s`\n' "$sealed_payload_inventory_hash"
      printf -- '- Sealed initdb module: `%s`\n' "$wasix_initdb_module"
      printf -- '- Sealed postgres module: `%s`\n' "$wasix_postgres_module"
      printf -- '- Captured sealed manifest: `%s`\n' "$report_dir/wasix-sealed-manifest.json"
      printf -- '- Captured sealed receipt: `%s`\n' "$report_dir/wasix-sealed-wasmer-build.receipt"
      printf -- '- Captured sealed payload inventory: `%s`\n' "$report_dir/wasix-sealed-payload.files"
    else
      printf -- '- Wasmer version: `%s`\n' "$(fresh_wasmer_version "$wasmer_bin" 2>/dev/null || true)"
      printf -- '- Wasmer cache dir: `%s`\n' "$wasmer_cache_dir"
      printf -- '- Wasmer compiler: `%s`\n' "$wasmer_compiler"
      printf -- '- Wasmer LLVM opt level: `%s`\n' "$wasmer_llvm_opt_level"
      printf -- '- WASMER_LLVM_NATIVE_CPU: `%s`\n' "${WASMER_LLVM_NATIVE_CPU:-0}"
      printf -- '- WASMER_LLVM_FULL_O3_PIPELINE: `%s`\n' "${WASMER_LLVM_FULL_O3_PIPELINE:-0}"
      printf -- '- WASMER_LLVM_INDIRECT_CALL_CACHE: `%s`\n' "${WASMER_LLVM_INDIRECT_CALL_CACHE:-0}"
      printf -- '- WASMER_LLVM_VOLATILE_MEMOPS: `%s`\n' "${WASMER_LLVM_VOLATILE_MEMOPS:-0}"
      printf -- '- Wasmer compiler threads: `%s`\n' "$wasmer_compiler_threads"
      printf -- '- Skip precompile: `%s`\n' "$skip_precompile"
    fi
    printf -- '- Wasmer stack size: `%s`\n' "$wasmer_stack_size"
    printf -- '- Sealed loader policy receipt: `%s` (`%s`)\n' \
      "$sealed_loader_policy_tsv" "$sealed_loader_policy_identity"
    printf -- '- Require zero-write AOT/images: `%s`\n' "$require_zero_write_aot"
    if [ "$require_zero_write_aot" -eq 1 ]; then
      printf -- '- Immutable deployment receipt: `%s` (`%s`, dev `%s`, ino `%s`)\n' \
        "$immutable_carrier_receipt" "$immutable_carrier_receipt_sha256" \
        "$immutable_carrier_receipt_dev" "$immutable_carrier_receipt_ino"
      printf -- '- Immutable carrier closure identity: `%s`\n' \
        "$immutable_carrier_closure_identity"
    fi
    if [ "$wasix_lifecycle_plateau" -eq 1 ]; then
      printf -- '- Lifecycle baseline binding: `%s`\n' \
        "$lifecycle_baseline_binding_tsv"
      printf -- '- Lifecycle baseline binding SHA-256: `%s`\n' \
        "$lifecycle_baseline_binding_identity"
    fi
    printf '\n'
  } >>"$summary"
fi

trap cleanup_active_servers EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

overall_status=0
port="$start_port"
for target in "${targets[@]}"; do
  if ! assert_frozen_measurement_tool_closure; then
    overall_status=1
    break
  fi
  if ! assert_frozen_adaptive_cache_evidence_policy; then
    overall_status=1
    break
  fi
  if ! assert_frozen_memory_budget; then
    overall_status=1
    break
  fi
  if ! assert_frozen_lifecycle_baseline; then
    overall_status=1
    break
  fi
  if ! assert_frozen_execution_identity; then
    overall_status=1
    break
  fi
  if [ "$profile_resolution_active" -eq 1 ] &&
    ! fresh_assert_postgres_profile_inputs; then
    overall_status=1
    break
  fi
  if run_target "$target" "$port"; then
    target_status=0
  else
    target_status=$?
  fi
  if [ "$target_status" -ne 0 ]; then
    overall_status=1
  fi
  if ! release_external_shared_memory_providers target-return; then
    invalidate_derived_summary 125 "$target"
    invalidate_libpq_latency_summary 125 "$target"
    overall_status=1
  fi
  if [ "$profile_resolution_active" -eq 1 ] &&
    ! fresh_assert_postgres_profile_inputs; then
    invalidate_derived_summary 125 "$target"
    invalidate_libpq_latency_summary 125 "$target"
    overall_status=1
    break
  fi
  if ! assert_frozen_lifecycle_baseline; then
    invalidate_derived_summary 125 "$target"
    invalidate_libpq_latency_summary 125 "$target"
    overall_status=1
    break
  fi
  if ! assert_frozen_execution_identity; then
    invalidate_derived_summary 125 "$target"
    invalidate_libpq_latency_summary 125 "$target"
    overall_status=1
    break
  fi
  if ! assert_frozen_measurement_tool_closure; then
    invalidate_derived_summary 125 "$target"
    invalidate_libpq_latency_summary 125 "$target"
    overall_status=1
    break
  fi
  if ! assert_frozen_adaptive_cache_evidence_policy; then
    invalidate_derived_summary 125 "$target"
    invalidate_libpq_latency_summary 125 "$target"
    overall_status=1
    break
  fi
  port=$((port + 1))
done
if ! assert_frozen_measurement_tool_closure; then
  overall_status=1
fi
if ! assert_frozen_adaptive_cache_evidence_policy; then
  overall_status=1
fi
if ! assert_frozen_memory_budget; then
  overall_status=1
fi
if ! assert_frozen_lifecycle_baseline; then
  overall_status=1
fi
if ! assert_frozen_execution_identity; then
  overall_status=1
fi

{
  printf '\n## Results\n\n'
  printf -- '- Exit code: `%s`\n' "$overall_status"
  printf -- '- Summary TSV: `%s`\n' "$summary_tsv"
  printf -- '- Client TSV: `%s`\n' "$client_tsv"
  printf -- '- Resource TSV: `%s`\n' "$resource_tsv"
  printf -- '- Checkpoint TSV: `%s`\n' "$checkpoint_tsv"
  printf -- '- Memory budget TSV: `%s` (`%s`)\n' \
    "$memory_budget_tsv" "$memory_budget_identity"
  printf -- '- Adaptive cache evidence policy TSV: `%s` (`%s`)\n' \
    "$adaptive_cache_evidence_policy_tsv" \
    "$adaptive_cache_evidence_policy_identity"
  printf -- '- Measurement-tool closure TSV: `%s` (`%s`)\n' \
    "$measurement_tool_closure_tsv" \
    "$measurement_tool_closure_evidence_identity"
  if [ "$need_wasix" -eq 1 ]; then
    printf -- '- WASIX shared-memory provider: `%s`\n' \
      "$shared_memory_provider"
    printf -- '- WASIX shared-memory provider receipt: `%s/wasix/shared-memory-provider.json`\n' \
      "$report_dir"
    printf -- '- WASIX live shared-object receipt: `%s/wasix/shared-memory-objects.json`\n' \
      "$report_dir"
    printf -- '- WASIX shared-memory release/cleanup receipts: `%s/wasix/shared-memory-{release,cleanup}.json`\n' \
      "$report_dir"
  fi
  if [ "$measurement_tool_closure_mode" = content-addressed-read-only ]; then
    printf -- '- Captured measurement-tool file manifest: `%s`\n' \
      "$measurement_tool_closure_files_tsv"
  fi
  if [ "$libpq_latency_samples" -gt 0 ]; then
    printf -- '- Native libpq true-latency summary TSV: `%s`\n' "$libpq_latency_tsv"
    printf -- '- Native libpq raw latency TSVs: `%s/<target>/libpq-latency/{persistent,reconnect}.raw.tsv`\n' "$report_dir"
    printf -- '- Native libpq latency status/logs: `%s/<target>/libpq-latency/`\n' "$report_dir"
  fi
  if [ "$wasix_perf_stats" = "1" ]; then
    printf -- '- WASIX perf stats TSV: `%s/wasix/wasix-perf-server.tsv`\n' "$report_dir"
    printf -- '- WASIX perf stats top time TSV: `%s/wasix/wasix-perf-server.top-time.tsv`\n' "$report_dir"
  fi
  if [ "$require_zero_write_aot" -eq 1 ]; then
    printf -- '- Direct immutable loader audit: `%s/wasix/sealed-loader-audit.jsonl`\n' "$report_dir"
    printf -- '- Direct immutable loader validation: `%s/wasix/sealed-loader-audit-validation.tsv`\n' "$report_dir"
  fi
  if [ "$wasix_wait_dump_interval_ms" -gt 0 ]; then
    printf -- '- WASIX wait dump log: `%s/wasix/wasix-perf-server.log`\n' "$report_dir"
  fi
  if [ "$wasix_lifecycle_plateau" -eq 1 ]; then
    printf -- '- WASIX lifecycle plateau TSV: `%s`\n' "$lifecycle_plateau_tsv"
    printf -- '- WASIX frozen lifecycle evidence: `%s/wasix/wasix-runtime-evidence.log`\n' \
      "$report_dir"
    printf -- '- WASIX lifecycle freeze receipt: `%s/wasix/wasix-runtime-evidence.freeze.tsv`\n' \
      "$report_dir"
    printf -- '- WASIX lifecycle committed ACK: `%s/wasix/wasix-runtime-fence.ack`\n' \
      "$report_dir"
    printf -- '- WASIX lifecycle baseline policy/binding: `%s` (`%s`) / `%s` (`%s`)\n' \
      "$lifecycle_baseline_policy_tsv" "$lifecycle_baseline_policy_identity" \
      "$lifecycle_baseline_binding_tsv" "$lifecycle_baseline_binding_identity"
    printf -- '- WASIX lifecycle reconnect log: `%s/wasix/lifecycle-reconnect-churn.log`\n' \
      "$report_dir"
    if [ "$wasix_lifecycle_memory_checkpoint_every" -gt 0 ]; then
      printf -- '- WASIX lifecycle quiescent memory checkpoints: `%s`\n' \
        "$lifecycle_memory_checkpoints_tsv"
      printf -- '- WASIX lifecycle memory plateau validation: `%s`\n' \
        "$lifecycle_memory_plateau_tsv"
    fi
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
