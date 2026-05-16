# WASIX PostgreSQL concurrent root-cause notes

Generated during the 2026-05-12 20-connection investigation.

2026-05-15 follow-up: the current PG18 `release-o3` exec-backend server path is
functional but still not native-parity. In `codex-perfgated-releaseo3-20x1000`,
WASIX reached `0.599-0.646x` native throughput across the four 20-client
workloads and kept fanout RSS around `293-307 MiB`. Linker subspans in
`codex-perfstats-linker-subspan-read-20x1000` show the short-fanout cost is
mostly per-backend dynamic-main `Instance::new`, not fd read/write or table
setup.

A copied-fork child-backend experiment was added behind
`WASIX_CORE_CHILD_BACKEND=copied-fork`. It builds and passes single-process
initdb, but it fails server readiness with `RuntimeError: unreachable`. The
parseable perf-stats diagnostic
`codex-copiedfork-readiness-diag-atomicperf` shows it also copies about
`160 MiB` per forked child and spends roughly `56 ms` per copied child in
`linker.instance_group.memory.copy_to_store`. That path is therefore not a
promotable replacement for `EXEC_BACKEND` until the runtime has no-copy/COW
instance-group memory and the startup trap is fixed.

## Instrumentation controls

WASIX perf counters are compile-time and runtime gated:

- Build with `wasmer-wasix/perf-stats` or the CLI passthrough feature.
- Enable at runtime with `WASIX_PERF_STATS=1`.
- Write counters to a file with `WASIX_PERF_STATS_FILE=/path/to/log`.
- Dump live wait state while a futex or epoll wait remains parked with
  `WASIX_PERF_WAIT_DUMP_INTERVAL_MS=N`.
- Without the feature, the instrumentation module compiles to inline no-ops.
- With the feature but without `WASIX_PERF_STATS=1`, counters do not take locks or timestamps.

Use the separate helper so production release builds are not changed:

```sh
WASIX_CORE_PROFILE=release-o3 \
  ./assets/wasix-build/experiments/fresh-wasix-postgres/bin/build-wasmer-perf-stats.sh
```

Then point the benchmark at the separate binary:

```sh
WASIX_CORE_PROFILE=release-o3 \
WASMER_BIN=/Users/sid/dev/pglite-oxide/assets/wasix-build/work/upstream/wasmer/target/perf-stats/release/wasmer \
  ./assets/wasix-build/experiments/fresh-wasix-postgres/bin/bench-wasix-concurrent-query-suite.sh \
  --target wasix --skip-build --skip-precompile \
  --connections 20 --iterations 1000 --rows 50000 \
  --workloads "read mwrite iupdate indexed" \
  --wasix-perf-stats --wasix-wait-dump-interval-ms 2000
```

## Fixed paths

- `LocalTcpListener` now preserves level-triggered accept readiness while the local accept backlog remains non-empty. This fixes the earlier concurrent connection stall at the TCP listener level.
- Guest signal interruption now distinguishes host-only wakeups from guest-delivered signals, so host `Sigwakeup` no longer leaks to PostgreSQL as `EINTR`.
- The repeated `failed to epoll during deep sleep - intr` log is gone in the 20x1000 concurrent suite.
- `futex_wake` now prefers a waiter with a registered host waker before consuming an unregistered waiter. Focused unit coverage was added for that wake selection.
- The socket readiness registry now supports an external epoll handler and direct socket waiters at the same time. The virtual-io selector wraps them in a multiplexed handler instead of replacing one with the other.
- Blocking socket send/recv/accept waits now use the source readiness polling path instead of installing/removing a one-off socket handler. This prevents a direct socket wait from detaching an active epoll subscription.

## Key measurements

20x1000 release WASIX smoke after the futex wake change:

- `indexed-read`: 16,975 ops/s, 20/20 clients, no timeout.
- `mixed-write`: 23,529 ops/s, 20/20 clients, no timeout.
- `indexed-update`: 13,899 ops/s, 20/20 clients, no timeout.
- `indexed-insert`: 13,908 ops/s, 20/20 clients, no timeout.
- Peak WASIX RSS during fanout: 315-328 MiB.

Useful reports:

- `reports/release-o3/concurrent-query-suite/codex-futexfix-smoke-20x1000-wasix/summary.tsv`
- `reports/release-o3/concurrent-query-suite/codex-futexfix-smoke-20x1000-wasix/resource-summary.tsv`

Long hot read shape:

- Native 20x100000 indexed read: 433,839 ops/s, peak summed RSS 357 MiB.
- WASIX release 20x100000 indexed read: 1,189,832 ops/s, peak RSS 672 MiB.
- WASIX perf/profiler 20x100000 indexed read: 143,071 ops/s, peak RSS 676 MiB.
- In the active profiler sample, excluding idle parked threads, visible top-stack samples were about 95% guest JIT code and under 4% host kernel/malloc/memory operations.

Useful reports:

- `reports/release-o3/concurrent-query-suite/codex-native-rootcause-read-20x100000/summary.tsv`
- `reports/release-o3/concurrent-query-suite/codex-wasix-release-read-20x100000/summary.tsv`
- `reports/release-o3/concurrent-query-suite/codex-wasix-rootcause-read-20x100000/wasix/indexed-read/symbolized-sample.txt`

Backend creation and mapping costs from the 20x1000 profiled WASIX run:

- Each 20-client fanout creates 20 backend stores.
- `task_wasm.new_with_store.plain`: about 0.7-0.9s cumulative per 20-client fanout.
- `syscall.proc_exec3`: about 1.6-2.1s cumulative per 20-client fanout.
- `syscall.mem_mmap.bytes`: 60 mappings and about 3.0 GB requested mapping bytes per 20-client fanout.

Useful reports:

- `reports/release-o3/concurrent-query-suite/codex-wasix-rootcause-20x1000/wasix/wasix-perf-server.top-time.tsv`
- `reports/release-o3/concurrent-query-suite/codex-wasix-rootcause-20x1000/wasix/wasix-perf-server.top-bytes.tsv`

## Liveness result

The long 20x10000 WASIX release sequence that previously parked now completes all four workloads with 20 clients and no epoll interrupts:

- `indexed-read`: 136,901 ops/s, 20/20 clients, no timeout.
- `mixed-write`: 276,817 ops/s, 20/20 clients, no timeout.
- `indexed-update`: 110,497 ops/s, 20/20 clients, no timeout.
- `indexed-insert`: 132,013 ops/s, 20/20 clients, no timeout.

Current native comparator for the same 20x10000 shape:

- `indexed-read`: 634,006 ops/s.
- `mixed-write`: 412,797 ops/s.
- `indexed-update`: 151,976 ops/s.
- `indexed-insert`: 198,610 ops/s.

Useful reports:

- `reports/concurrent-query-suite/codex-wait-registry-fix-release-long-20x10000-wasix/summary.tsv`
- `reports/concurrent-query-suite/codex-wait-registry-fix-release-long-20x10000-wasix/resource-summary.tsv`
- `reports/concurrent-query-suite/codex-wait-registry-fix-native-long-20x10000/summary.tsv`
- `reports/concurrent-query-suite/codex-wait-registry-fix-native-long-20x10000/resource-summary.tsv`

The wait-registry dump was also verified with `codex-wait-registry-snapshot-smoke`; snapshots include private/shared futex counts, shared memory mappings, every fd kind, epoll queue length, and per-subscription pending/enqueued/join state.

## Root-cause assessment

The constrained paths are now split:

- Short concurrent fanout latency is materially constrained by WASIX backend creation: `proc_exec3`, store creation, and repeated guest memory mapping.
- Hot read execution is not primarily constrained by socket syscalls; active CPU samples are overwhelmingly guest JIT code, and release WASIX can outperform the current native oracle on the hot read shape.
- High RSS is real and scales with concurrent backend activity. WASIX keeps PostgreSQL postmaster and backend state inside one Wasmer process, while native uses OS processes and copy-on-write. The single-process WASIX RSS reaches 672-919 MiB in long read/insert runs; this is memory amplification, not a simple monotonic leak.
- Long write/update liveness was blocked by handler replacement in the wait registry. A socket source could hold only one readiness handler, so a direct blocking socket wait could replace the epoll handler and later remove it. The fix makes readiness fan out to epoll and direct waiters without changing the source registration.
- Remaining throughput/RSS gaps are now performance work, not the same liveness blocker. In the current 20x10000 run, WASIX reaches 21.6% of native indexed-read throughput and 66-73% of native write/update/insert throughput. Peak WASIX RSS is 1.2-1.6x native for write/update/insert and 3.1x native for indexed-read in the sampled run.
