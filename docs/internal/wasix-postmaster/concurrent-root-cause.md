# WASIX PostgreSQL concurrent root-cause notes

> Historical measurement log imported from commit
> `aa4211f4485327cb7493863ea3380acf27c5f951`. It is evidence from the original
> macOS arm64 run, not a current cross-platform support claim.

Generated during the 2026-05-12 20-connection investigation.

2026-05-15 follow-up: the PG18 `release-o3` exec-backend server path was
functional but still not native-parity. In `codex-perfgated-releaseo3-20x1000`,
WASIX reached `0.599-0.646x` native throughput across the four 20-client
workloads and kept fanout RSS around `293-307 MiB`. Linker subspans in
`codex-perfstats-linker-subspan-read-20x1000` show the short-fanout cost is
mostly per-backend dynamic-main `Instance::new`, not fd read/write or table
setup.

An alternate private-state-cloning experiment passed a single-process initdb
fixture but trapped before PostgreSQL server readiness. It copied roughly
160 MiB per child and added about 56 ms of copy work per child. The prototype,
its compiler-continuation machinery, and its probes are excluded from the
canonical source and qualification gates; it is historical observation, not a
fallback or a promotion path.

## Historical Linux sealed-carrier follow-up

### Release-O3 final-module ordering regression

An earlier release-O3 investigation found a stronger root cause than
relation-extension throughput. PostgreSQL's ThinLTO input still contains the
expected sequentially consistent fences in `SetLatch`, `ResetLatch`, and
`WaitEventSetWait`, but the final release-O3 `postgres` module contains no
`atomic.fence` operators. The exact safe-O2 control module contains 275. A
standalone Binaryen 130 pass over the safe module preserves those operators,
and Wasmer's LLVM lowering emits a sequentially consistent fence when the
operator reaches it. The loss therefore occurs in the PostgreSQL optimized
guest pipeline before Wasmer AOT compilation; Wasmer cannot restore an
operator absent from the input module.

This explains the diagnostic in which the relation-extension lock holder had
`granted=true`, no blockers, and remained asleep while three peers queued. The
lock manager had completed the grant, but the separately instantiated backend
missed its latch wake.

Patch `0008-wasix-packed-atomic-latch-state.patch` makes that critical
predicate independently robust under the explicit
`PG_WASIX_ATOMIC_LATCH_STATE` feature macro:

- one naturally aligned, compile-time lock-free `pg_atomic_uint32` carries
  `SET=1` and `SLEEPING=2`; a reserved word plus static size and field-offset
  checks preserve the existing WASIX `Latch` layout;
- `SetLatch` uses one sequentially consistent fetch-or, and only the caller
  that changes SET from clear to set sends a wake when its old value also
  contained SLEEPING;
- the waiter publishes SLEEPING with fetch-or, rechecks SET with a true
  sequentially consistent atomic load, and retracts SLEEPING both when SET was
  already visible and after the readiness primitive returns;
- `ResetLatch` clears SET with fetch-and without manufacturing or clearing a
  waiter publication; and
- existing `pg_memory_barrier()` calls remain in place as a separately
  verifiable secondary contract. Native PostgreSQL retains the exact upstream
  field layout and source path under the compile-time `#else` branches.

At that point this was a source-level repair awaiting a rebuilt sealed carrier.
A later 2026-08-09 structural checkpoint proved 1,111 linked-module fences,
995 sealed-module fences, and the exact latch-critical 2/1/1 counts. That proof
predates the current `runtime-build-recipe.v3` builder identity and is
historical; no current-source artifact or carrier is admitted. The repeated
fresh-postmaster and backend-wave runtime gates were not rerun at that
structural checkpoint.

The last measured five-module 2026-08 Linux x86_64 carrier changed the memory
interpretation and exposed a separate sustained-write limit:

- Runtime ABI `995f6a9bf69ce6ff154533369eb4f9d6c45d9dfca13fdc213e0f6be8ae405217`
  with payload inventory
  `8e907e600fa9d7197c2ae98ddece5cb3093e4e7e3caf8f27f325a24955c120a7`
  and manifest
  `cea8c0933fa01f6646184c1f97c2156300e50bcf8a5d1d2e38fbb4ed2bb11fec`
  passed the predeclared `embedded-c4-lower-pressure-v1` memory gate on one
  host. Readiness PSS was 66.862 MiB; the four-client peak was 132.708 MiB PSS,
  77.473 MiB anonymous PSS, and 1.164 MiB page tables. Whole-run cgroup charge
  peaked at 224.707 MiB under 256/224/0 MiB hard/high/swap limits.
- Required fan-out phases recorded 2,528 `memory.high` events and 0.003289 PSI
  some/full stall fractions, within the predeclared 4,096, 0.015, and 0.010
  ceilings, with no `memory.max`, OOM, OOM-kill, or swap event. Bulk rates were
  352,846.832/359,874.044/42,854.082/140,449.438 logical row ops/s for
  read/mixed-write/update/insert. This is historical, uncomposed evidence; it
  does not qualify the profile for performance, latency, lifecycle, or
  durability claims.
- That run's verifier and initdb operated outside the server cgroup, so it is
  warm active-scope evidence, not a cold page-cache ownership proof. Cold
  qualification requires zero carrier/PGDATA regular-file residency at the
  final prelaunch boundary and attributed first-query cgroup I/O; see
  [cold-ownership-qualification.md](cold-ownership-qualification.md).
- Earlier exact five-module carrier runs reached 79.101 MiB quiescent readiness
  PSS in the staged ladder. Four-client indexed read reached 108.274 MiB PSS;
  default-profile writes peaked near 220 MiB. These remain historical
  optimization and attribution points, not current-carrier values.
- Raw RSS is strongly inflated by aliases inside the one host process. A live
  14–15-guest diagnostic attributed roughly 650 MiB RSS to repeated mappings
  of one approximately 142 MiB PostgreSQL shared-memory backing. PSS and cgroup
  charge, not raw RSS, are the physical viability gates.
- The optimized O3 guest reached 0.754/0.801/0.779/0.829 of native one-client
  bulk throughput for read/mixed/update/insert. These are batch wall-time
  ratios, not query-tail or backend-launch latency. A balanced one-block 100k
  diagnostic passed its throughput gates at 0.746/0.788/0.833/0.874, but failed
  batch-residual gates for mixed-write, update, and insert; it remains
  diagnostic.
- A fresh O3 four-client, one-million-iteration mixed-write run still did not
  complete after 300 seconds. Sampling showed all clients serialized on
  PostgreSQL relation extension while the holder progressed extremely slowly.
  Switching to synchronous I/O removed three AIO-worker guests and reduced
  memory, but did not remove the relation-extension throughput limit.
- The earlier synchronous-I/O/32 MiB profile completed all four 100k
  workloads at a 192/176 MiB hard/high limit with 66.515 MiB readiness and at
  most 131.709 MiB fan-out PSS. Its 4,650 high events and 34,344 update ops/s
  show page-cache/reclaim pressure. At 160/144 MiB it completed but update fell
  to 13,703 ops/s amid 11,804 high events; 160 MiB is survival-only.
- A separate multi-workload run was contaminated by timed-out clients and
  logged PostgreSQL `IO in wrong state: 0` from the PostgreSQL 18 AIO state
  machine. Its later workload rates are invalid, and this evidence supports no
  AIO-correctness or process-cleanup claim.

This does not invalidate the earlier lost-wake repair or the historical
carrier's budget pass. It does mean that sustained table
extension/HostFS/I/O scalability and AIO lifecycle remain write-path blockers
outside the qualified workload shape. O3 is unpromoted.

### Lifecycle baseline drift: PID 6 WAL-segment VFD

The verbose lifecycle diagnostic also corrected a false root-cause attribution.
PID 7 already had its `global/1262` descriptor in the first inventory and kept
the same 12 local FDs. The persistent delta occurs in PID 6, PostgreSQL's WAL
writer: it had 11 local FDs through 15.008 seconds, then opened
`pg_wal/000000010000000000000001`, after which both its local count and the
aggregate guest-FD count remained one higher (12 and 71 respectively).

This is expected PostgreSQL 18 lazy state rather than a reconnect leak. The
background writer's first approximately 15-second maintenance interval calls
`LogStandbySnapshot()`, which inserts an `XLOG_RUNNING_XACTS` record and sets an
asynchronous WAL LSN. That wakes the WAL writer; `XLogBackgroundFlush()` opens
the current segment on first write, and the cached `openLogFile` VFD remains
open while the segment remains current.

The robust lifecycle boundary is therefore event-driven. Before readiness, the
harness records the `pg_stat_io` row for
`backend_type='walwriter'`, `object='wal'`, `context='normal'`, calls
`pg_log_standby_snapshot()`, and records its returned target LSN. It polls with
fresh statistics snapshots until `writes` and `write_bytes` increase and
`pg_current_wal_flush_lsn()` reaches the target, while requiring an unchanged
`stats_reset`. This produces one natural running-transactions record and
advances the exact lazy state without a 15-second sleep, artificial bulk WAL,
or a path/FD exception. It requires `wal_level >= replica` and a primary.

After that barrier, stable idle contains six active task leases plus five
suspended parent-continuation leases: `execution_leases=11`, alongside six
registered processes/runtime states and five child edges. Treating the lease
count as six conflates tasks with the parent continuations retained across the
EXEC_BACKEND `vfork`/`exec` topology.

## Instrumentation controls

WASIX perf counters and lifecycle snapshots have deliberately separate gates:

- Build with `wasmer-wasix/perf-stats` or the CLI passthrough feature.
- Enable at runtime with `WASIX_PERF_STATS=1`.
- Write counters to a file with `WASIX_PERF_STATS_FILE=/path/to/log`.
- Dump live wait state while a futex or epoll wait remains parked with the
  runtime-owned `WASIX_WAIT_DUMP_INTERVAL_MS=N` and
  `WASIX_WAIT_DUMP_FILE=/path/to/log` controls. The benchmark exposes the
  interval only through `--wasix-wait-dump-interval-ms` in its untimed
  `--wasix-lifecycle-plateau` lane. Timed workloads and latency qualifiers
  reject wait-dump options and ambient variables, then remove all legacy and
  checkpoint wait-dump keys from the Wasmer child environment.
- Compact ordered lifecycle records are available in `headless-minimal`
  without `perf-stats`; they contain aggregate process/task ownership,
  process-topology/thread/publication/retirement state, runtime-state observer
  ownership, private/shared futex waiters and wakers, epoll internals,
  shared-registry slots, mappings, and guest-FD occupancy.
- The lifecycle harness publishes atomic nonce-bound fence requests. The
  runtime takes the referenced snapshot under its global writer lock, appends
  and syncs the visible fence, then atomically publishes a separate committed
  ACK with the exact fence-end offset. The harness removes stale ACKs before
  each request, freezes only that offset, and binds ACK/frozen hashes into a
  receipt verified again by the parser. The live diagnostic log is never
  parsed as qualification evidence.
- The baseline policy is hashed before the server starts and bound to resolved
  profile/runtime/module/carrier identities. It currently remains an
  `exploratory-unbounded`
  `relative-to-fresh-baseline` gate: tuple equality proves no reconnect
  accumulation, while absolute PSS budgets—not a nonzero readiness tuple—judge
  whether the baseline is viable for embedding.
- Detailed per-entry traversal additionally requires a `perf-stats` build and
  explicit `WASIX_WAIT_DUMP_VERBOSE=1`.
- Without `perf-stats`, counter operations compile to inline no-ops. With the
  feature but without `WASIX_PERF_STATS=1`, counters do not take locks or
  timestamps.

Use the separate helper so production release builds are not changed:

```sh
WASIX_CORE_PROFILE=release-o3 \
  src/runtimes/liboliphaunt/wasix-postmaster/bin/build-wasmer-perf-stats.sh
```

Use the separate binary only for untimed diagnostics. For the compact
lifecycle gate, run:

```sh
WASIX_CORE_PROFILE=release-o3 \
WASMER_BIN=<historical-repository>/assets/wasix-build/work/upstream/wasmer/target/perf-stats/release/wasmer \
  src/runtimes/liboliphaunt/wasix-postmaster/bin/bench-wasix-concurrent-query-suite.sh \
  --target wasix --skip-build --skip-precompile \
  --resource-detail off --wasix-lifecycle-plateau \
  --wasix-lifecycle-reconnects 64 \
  --wasix-wait-dump-interval-ms 100
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

Checkpoint native comparator for the same 20x10000 shape:

- `indexed-read`: 634,006 ops/s.
- `mixed-write`: 412,797 ops/s.
- `indexed-update`: 151,976 ops/s.
- `indexed-insert`: 198,610 ops/s.

Useful reports:

- `reports/concurrent-query-suite/codex-wait-registry-fix-release-long-20x10000-wasix/summary.tsv`
- `reports/concurrent-query-suite/codex-wait-registry-fix-release-long-20x10000-wasix/resource-summary.tsv`
- `reports/concurrent-query-suite/codex-wait-registry-fix-native-long-20x10000/summary.tsv`
- `reports/concurrent-query-suite/codex-wait-registry-fix-native-long-20x10000/resource-summary.tsv`

The historical detailed wait-registry dump was verified with
`codex-wait-registry-snapshot-smoke`; verbose snapshots include private/shared
futex counts, shared memory mappings, every FD kind, epoll queue length, and
per-subscription pending/enqueued/join state. The checkpoint lifecycle gate used
the bounded compact record instead and verifies an exact readiness-to-
post-reconnect plateau without walking entries or sweeping weak slots first.

## Root-cause assessment

The constrained paths are now split:

- Short concurrent fanout batch wall time is materially constrained by WASIX
  backend creation: `proc_exec3`, store creation, and repeated guest memory
  mapping. The historical harness did not isolate a backend-launch latency
  distribution.
- Hot read execution was not primarily constrained by socket syscalls; active
  CPU samples were overwhelmingly guest JIT code, and release WASIX
  outperformed the checkpoint native oracle on the hot read shape.
- High RSS is real and scales with concurrent backend activity. WASIX keeps PostgreSQL postmaster and backend state inside one Wasmer process, while native uses OS processes and copy-on-write. The single-process WASIX RSS reaches 672-919 MiB in long read/insert runs; this is memory amplification, not a simple monotonic leak.
- Long write/update liveness was blocked by handler replacement in the wait registry. A socket source could hold only one readiness handler, so a direct blocking socket wait could replace the epoll handler and later remove it. The fix makes readiness fan out to epoll and direct waiters without changing the source registration.
- Remaining throughput/RSS gaps were performance work, not the same liveness
  blocker. In the checkpoint 20x10000 run, WASIX reached 21.6% of native
  indexed-read throughput and 66-73% of native write/update/insert throughput.
  Peak WASIX RSS was 1.2-1.6x native for write/update/insert and 3.1x native for
  indexed-read in the sampled run.
