# Fresh WASIX PostgreSQL Experiment

> Historical checkpoint imported from commit
> `aa4211f4485327cb7493863ea3380acf27c5f951`. Paths and PostgreSQL 18.3
> commands below describe that run; use the project root README and Moon tasks
> for the current PostgreSQL 18.4 source contract. No carrier built from the
> current source is admitted.

> Performance terms below retain the historical experiment's labels. In the
> current harness, fan-out duration is explicitly **bulk batch wall time** and
> the derived rate is logical row operations per second. Neither is a
> per-query latency, backend-launch latency, request rate, or tail percentile.
> Later historical evidence and current non-admission are indexed in
> `replay-status.md` and
> `rss-memory-model.md`.

This is a quarantined implementation lane for building upstream PostgreSQL
`REL_18_3` under WASIX. It is source-controlled here so the work is not lost,
but it must not affect the existing single-user production asset path.

The scripts default to ignored work/cache directories:

- experiment work root:
  `assets/wasix-build/work/experiments/fresh-wasix-postgres`
- upstream runtime/libc work root:
  `assets/wasix-build/work/upstream`

Those paths hold source checkouts, native and WASIX build trees, installs,
Wasmer caches, patched sysroots, probe binaries, and generated reports. They are
intentionally ignored so the repo tracks only source inputs and harness logic.

## Tracked Inputs

- `bin/`: PostgreSQL baseline, overlay, build, smoke, and fast `make` helpers.
- `lib/common.sh`: shared path, Docker, Wasmer, and report helpers.
- `bench/sql/`: smoke and performance SQL probes.
- `overlays/wasix-core/`: WASIX PostgreSQL port overlay copied onto clean
  PostgreSQL.
- `patches/`: PostgreSQL source patches applied to clean `REL_18_3`.
- `runtime-probes/`: early standalone WASIX capability probes.
- `upstream/bin/`: contained Wasmer/wasix-libc blocker check harness.
- `upstream/probes/`: C probes for runtime/libc blockers.
- `upstream/patches/`: exported local Wasmer and wasix-libc WIP patch sets.

## Isolation Rules

- Do not change the existing production `assets/wasix-build/*.sh` scripts for
  this experiment unless we explicitly promote a piece of work.
- Do not write build outputs into this tracked tree.
- Keep generated source checkouts and compiled artifacts under the ignored
  `work/` roots above.
- Treat the existing single-user code as reference material only, not as source lineage.
- Preserve PostgreSQL semantics. Missing POSIX behavior is a WASIX/runtime/libc
  blocker unless a narrow PostgreSQL port-layer patch is justified by evidence.

## Fast Path

```sh
cd <historical-repository>/assets/wasix-build/experiments/fresh-wasix-postgres
./bin/prepare-baseline.sh
./bin/apply-wasix-core-overlay.sh
./bin/build-native-oracle.sh
./bin/smoke-native-oracle.sh
./bin/build-wasix-core.sh
./bin/smoke-wasix-core.sh
```

Use `./bin/run-acceptance.sh --continue` to run the lane and collect reports
even after expected blockers.

## Tight Iteration Loop

Baseline network refresh is opt-in. After the first checkout, scripts reuse the
local `REL_18_3` tag unless `--refresh` is passed to `prepare-baseline.sh`.

The WASIX build directory is incremental. It is cleaned only when the upstream
commit, overlay digest, script digest, or sysroot input changes. For focused
compiler work:

```sh
./bin/wasix-make.sh -C src/backend/port pg_shmem.o
./bin/wasix-make.sh -C src/bin/initdb initdb
./bin/wasix-make.sh -C src/bin/psql psql
```

The upstream blocker probes also reused their compiled `.wasm` files when the
probe source and sysroot signature had not changed. A representative selected
probe was:

```sh
./upstream/bin/run-blocker-probes.sh --probe rlimit-stack --strict
```

Filtered probe runs keep their own compile signatures, so this path rebuilds
only the selected probe artifacts when sources or the sysroot change.

An alternate private-state-cloning experiment reported green focused fixtures,
but it failed full PostgreSQL readiness and has been removed from the canonical
patch and probe set. Those results are archaeology, not a supported capability.

A small upstream PostgreSQL regression subset can run against the cached WASIX
postmaster without rebuilding:

```sh
./bin/run-native-regress-subset.sh
./bin/run-wasix-regress-subset.sh
```

The default subset was `boolean case copy`. `run-wasix-regress-subset.sh`
built the WASIX `regress.so` support library, used the hash-scoped Wasmer
cache, and precompiled the core modules unless `WASIX_SKIP_PRECOMPILE=1`.
Pass explicit test names to widen it, for example:

```sh
./bin/run-wasix-regress-subset.sh test_setup boolean case copy database create_function_c transactions encoding euc_kr infinite_recurse
```

The concurrent backend/socket smoke starts one WASIX postmaster and fans out
native `psql` clients over TCP:

```sh
./bin/smoke-wasix-concurrent-connections.sh --connections 2 --iterations 4
```

It checks that each client got a distinct backend PID, that all client
lifetimes overlapped, and that the concurrent backends can insert/update indexed
rows successfully. Raise `--connections` for stress runs; the default is the
checkpoint blocker gate. The default acceptance run did not require this; run
`./bin/run-acceptance.sh --continue` or set `WASIX_ACCEPTANCE_CONCURRENT=1` to
include it while collecting broader process/socket evidence.

For concurrent throughput work, run the native/WASIX query suite:

```sh
./bin/bench-wasix-concurrent-query-suite.sh \
  --connections 8 \
  --iterations 1000 \
  --rows 100000
```

It keeps setup outside the measured fanout window and runs indexed reads,
mixed insert/update writes, indexed updates, and indexed inserts against one
postmaster per target. The summary TSV records fanout wall time, logical
operations per second, per-client status/timing, verification counts, timeout
status, server log path, and the WASIX `failed to epoll during deep sleep - intr`
count. The resource summary TSV records per-phase process-tree RSS, VSZ, CPU,
sample count, and process count; native samples sum the postmaster process tree
while WASIX samples the Wasmer process. A nonzero verification mismatch, client
failure, timeout, or repeated WASIX epoll interrupt log fails the run. Use
`--target native` for harness validation, `--target wasix` for runtime-focused
testing, `--resource-interval` for sustained resource probes, and
`--postgres-guc` or `--wasmer-arg` only for recorded diagnostic A/B runs.

The runner sets an explicit bounded Wasmer stack (`WASMER_STACK_SIZE`, default
32 MiB) and reports it with the Wasmer hash/cache path. The patched runtime
exports `proc_rlimit_get`, and wasix-libc `getrlimit(RLIMIT_STACK)` reports the
runtime-owned limit. The CLI derives that limit conservatively from the actual
Wasmer stack size and caps it by the guest C stack. With the default 32 MiB
Wasmer stack this reports a 4 MiB `RLIMIT_STACK`, letting PostgreSQL use its
normal 2 MiB dynamic default while still keeping `infinite_recurse` on the SQL
stack-depth error path instead of exhausting the Wasmer host stack.

The fresh WASIX build supports multiple artifact-preserving profiles through
`WASIX_CORE_PROFILE`:

- `safe-o2` kept the checkpoint's conservative bring-up flags and artifact
  roots: `builds/wasix-core` and `install/wasix-core`.
- `o3` enables `-O3` without LTO or Binaryen post-link optimization.
- `o3-wasmopt` adds Binaryen post-link converge/strip without ThinLTO.
- `o3-thinlto` adds ThinLTO without Binaryen post-link optimization.
- `release-o3` mirrors the production release lane: `-O3 -g0 -flto=thin`,
  link-time `-flto=thin`, and wasixcc wasm-opt with
  `--converge:--strip-debug:--strip-producers`.
- `release-o3-symbols` keeps the same compiler and linker flags as
  `release-o3`, but uses wasm-opt `--converge:--debuginfo` so Wasmer perfmap
  profiling can emit Wasm function names instead of `function_N` fallbacks.

Checkpoint optimization status: `o3`, `o3-wasmopt`, `o3-thinlto`, and
`release-o3` all built and passed the WASIX `initdb` smoke against the patched
Wasmer/libc stack. The release-lane blocker was split into two defensible fixes:
wasix-libc invoked the internal default signal handler directly instead of
seeding it through an indirect table entry, and pg_dump's local `executeQuery`
helper was renamed so ThinLTO did not collide with `fe_utils/query_utils.c`.
`release-o3` was therefore benchmarkable, but it was not the fastest warm
query profile on all workloads.

Non-default profiles are written to suffixed roots such as
`builds/wasix-core-release-o3` and `install/wasix-core-release-o3`, so the
checkpoint `safe-o2` artifacts remained available for A/B benchmarks.

`precompile-wasix-core.sh` defaulted to the release-hot runtime scope:
`postgres`, `initdb`, `pg_dump`, `libpq`, and installed PostgreSQL side modules.
Use `WASIX_PRECOMPILE_SCOPE=minimal` for the old three-module loop, or
`WASIX_PRECOMPILE_SCOPE=all` when intentionally probing every installed tool.

To run the native/WASIX performance matrix:

```sh
./bin/bench-wasix-core-profiles.sh --profiles "safe-o2 o3 o3-wasmopt o3-thinlto release-o3"
```

The matrix writes raw phase timings and logs under
`assets/wasix-build/work/experiments/fresh-wasix-postgres/reports/perf-matrix`.
It measures native and WASIX `initdb`, postmaster readiness, and
`bench/sql/perf-probes.sql`; use `--skip-build` to reuse existing artifacts or
`--profile release-o3` for a focused optimized run. The SQL probe defaults to
100k generated rows; use `--rows 1000` for quick iteration and
`--sql-timeout 0` only when intentionally allowing an unbounded run.

For query-focused performance work, use the per-workload suite:

```sh
./bin/bench-wasix-query-suite.sh \
  --profiles "safe-o2 o3 o3-wasmopt o3-thinlto release-o3" \
  --rows 100000 \
  --update-rows 100000 \
  --transaction-rows 100000 \
  --sql-timeout 120
```

It runs native and WASIX against the same SQL workload files in
`bench/sql/query-perf`: bulk insert, unlogged bulk insert, single-transaction
insert, indexed insert, index build, indexed reads, indexed updates,
transactional update batches, and COPY out. Each workload keeps setup outside
`psql` timing and enables timing only for the measured operation(s). The summary
TSV records wall time, summed `psql` time, timed-statement count, log path, and
the row-count/GUC context.

Use `--postgres-guc name=value` or `POSTGRES_GUCS='name=value ...'` for
diagnostic parity runs. For example, `--postgres-guc wal_buffers=16MB` isolated
the checkpoint's 100k logged-insert cliff, and adding
`--postgres-guc synchronous_commit=off` isolates commit-flush cost. These are
diagnostic controls, not production bypasses; the target remains native
PostgreSQL durability semantics.

Use `--wasmer-arg value` or `WASMER_RUN_EXTRA_ARGS='value ...'` for targeted
runtime feature comparisons against the same PostgreSQL artifacts. Keep the
default path as the baseline and record any extra Wasmer arguments in the report
before comparing timings.

Use `WASMER_COMPILER=llvm|cranelift|singlepass` for backend A/B runs, but only
with a Wasmer CLI built with the matching backend feature. The harness requires
the explicit CLI backend flag for the selected compiler so a Cranelift or
Singlepass run cannot silently fall back to LLVM. LLVM was the only viable backend
for the checkpoint EH/PIC/dynamic PostgreSQL module in the patched release binary:
`o3-cranelift-unlogged-backend-toggle` fails at `initdb` with Wasmer reporting
that Cranelift does not support the module's required features. Use
`WASMER_LLVM_NATIVE_CPU=1` to opt into host-CPU LLVM codegen only for a native
target carrying the exact detected host feature set; the harness stores those
artifacts under a separate cache suffix. Treat this lane as host-local: LLVM's
CPU name can encode ISA details beyond Wasmer's portable feature taxonomy, so
native-CPU artifacts must not enter the postmaster product cache or carrier.

Checkpoint WAL latency findings for the stable `o3` artifact and patched release
Wasmer:

- Host-file `O_DSYNC`/`O_SYNC`, blocking positioned writes, native
  `fsync`/`fdatasync`, blocking `pwritev`, repeated-ciovec coalescing, and
  verified zero-write are implemented below PostgreSQL in Wasmer/virtual-fs.
- WAL segment initialization was native-level in the fdatasync stats probe:
  `o3-wal-io-stats-fdatasync-single-iov-fastpath` reports 16 MiB WAL init at
  2.29 ms write + 1.37 ms sync on WASIX versus 2.20 ms + 1.52 ms native.
- The warm `open_datasync` path was at-or-better-than native for the 100k
  insert/update pair: `o3-warm-open_datasync-single-iov-fastpath` reports
  283/504 ms WASIX versus 351/579 ms native.
- The explicit `fdatasync` path remains the next runtime target:
  `o3-warm-fdatasync-single-iov-fastpath` reports 189/387 ms WASIX versus
  105/231 ms native. The remaining measured gap is no longer WAL segment
  zero-fill; it is concentrated in normal WAL sync/syscall boundary cost.
- CPU/query execution was the broader warm-path blocker after the WAL
  zero-fill fix: `o3-cpu-wal-isolation-single-iov-fastpath` reports logged
  bulk insert at 217 ms WASIX versus 105 ms native, unlogged bulk insert at
  127 ms versus 76 ms, indexed read at 4.0 ms versus 2.2 ms, and COPY out at
  25.9 ms versus 19.1 ms. Explicit `--enable-simd --enable-relaxed-simd
  --enable-extended-const` did not improve the checkpoint `o3` artifact; wasixcc
  already emits the SIMD/relaxed-SIMD feature flags in the build.
- The optimized release profiles were correctness-unblocked but did not close
  the tuple-heavy execution gap. `o3-wasmopt-nativecpu-unlogged` is the best
  constant-insert sample so far at 101.7 ms, while
  `o3-thinlto-nativecpu-unlogged` is better on md5 scan, unlogged bulk insert,
  and COPY out at 30.0/122.7/25.2 ms. `release-o3-nativecpu-unlogged` passes but
  is not faster on this set. Native samples in the same runs remain roughly
  55-79 ms constant insert, 25 ms md5 scan, 77-78 ms unlogged bulk insert, and
  19 ms COPY out, so the next target is compiled Wasm/VM execution overhead, not
  WAL zero-fill or release-lane correctness.

Use `--precompile-scope minimal` for focused edit-test loops that only need
`initdb`, `postgres`, and `libpq`, or `--skip-precompile` when the selected
Wasmer binary hash already had the needed cache artifacts. Full matrix runs
should keep the default `runtime` scope.

Accepted warm-path artifacts can be pinned as a named runtime bundle so later
experiments do not force a rebuild or a Wasmer recompile before benchmarking:

```sh
WASMER_BIN=/path/to/accepted/wasmer \
WASMER_LLVM_NATIVE_CPU=1 \
WASMER_LLVM_FULL_O3_PIPELINE=1 \
./bin/pin-runtime-artifacts.sh --name release-o3-3a31-nativecpu-fullo3 --profile release-o3

./bin/bench-pinned-warm-matrix.sh --pin release-o3-3a31-nativecpu-fullo3 \
  --rows 100000 --update-rows 100000 --transaction-rows 100000 \
  --warmup-runs 2 --measure-runs 5
```

The pinned wrapper fails if the pinned install tree or Wasmer cache changes
during a run. Set `FRESH_PINNED_VERIFY_HASH=1` for full content-hash checking;
the default uses a faster file list/size/mtime check.

To force the existing patched sysroot into the PostgreSQL build without
rebuilding it:

```sh
export WASIXCC_SYSROOT_PREFIX=<historical-repository>/assets/wasix-build/work/upstream/build/patched-wasixcc-sysroot
./bin/build-wasix-core.sh
```

## Cached Artifacts

The latest expensive local artifacts are intentionally preserved outside Git:

- patched Wasmer:
  `assets/wasix-build/work/upstream/wasmer/target/release/wasmer`
- patched wasix-libc sysroot:
  `assets/wasix-build/work/upstream/build/patched-wasixcc-sysroot`
- compiled blocker probes:
  `assets/wasix-build/work/upstream/build/probes`
- WASIX PostgreSQL install:
  `assets/wasix-build/work/experiments/fresh-wasix-postgres/install/wasix-core`
- optimized WASIX PostgreSQL installs:
  `assets/wasix-build/work/experiments/fresh-wasix-postgres/install/wasix-core-$WASIX_CORE_PROFILE`
- native PostgreSQL oracle install:
  `assets/wasix-build/work/experiments/fresh-wasix-postgres/install/native-oracle`
- Wasmer module caches:
  `assets/wasix-build/work/experiments/fresh-wasix-postgres/tools/wasmer-cache/$WASMER_HASH`
- pinned accepted runtime bundles:
  `assets/wasix-build/work/experiments/fresh-wasix-postgres/tools/pinned-runtimes/$PIN_NAME`

## Historical checkpoint status

- The checkpoint baseline was upstream PostgreSQL `REL_18_3`.
- Native PostgreSQL 18.3 oracle build and smoke pass.
- WASIX PostgreSQL 18.3 core build and `initdb` smoke pass under the patched
  Wasmer/WASIX stack.
- The WASIX `pg_regress` slice `test_setup boolean case copy database
  create_function_c transactions encoding euc_kr infinite_recurse` passes
  against PostgreSQL 18.3 expected files, including backend-side loading of
  the WASIX `regress.so` support library.
- Runtime-owned `RLIMIT_STACK` reporting is wired through WASIX
  `proc_rlimit_get` and wasix-libc `getrlimit()`; it keeps PostgreSQL
  stack-depth checks ahead of Wasmer host stack exhaustion without a PostgreSQL
  shim.
- The psql teardown blocker is fixed by preserving `SOCK_NONBLOCK` and
  `SOCK_CLOEXEC` in wasix-libc `socket()`: the latest trace shows the final
  nonblocking `recv` returning `EAGAIN` immediately and psql sending
  `Terminate`.
- Local TCP listener readiness in the checkpoint preserved level-triggered accept
  semantics when multiple inbound connections are already queued. The
  `virtual-net` test
  `test_local_tcp_listener_reports_readable_while_accept_backlog_remains`
  proves readiness is re-emitted after each accept while backlog remains.
- Host-only WASIX `Sigwakeup` notifications are processed internally during
  asyncify/deep-sleep polling instead of surfacing as guest `EINTR`. Real guest
  signals still return `EINTR`; pending dynamic-link operations are drained
  before the syscall resumes. The epoll unit suite passes, and the concurrent
  query benchmark treats repeated PostgreSQL `failed to epoll during deep sleep
  - intr` logs as a failure.
- The rebuilt release-o3 Wasmer hash
  `2ce6b09de8327dbc55e63bcaed7e6f41157f770d9ebabaed54f28b35dc220a2d` passes
  the concurrent query suite with zero repeated epoll warning count. The
  20-connection/1000-iteration native-vs-WASIX sample
  `codex-concurrent-20x1000` passed indexed read, mixed write, indexed update,
  and indexed insert verification for both targets. A longer
  20-connection/10000-iteration indexed-read resource run also passed; WASIX
  peak fanout RSS was 387.8 MiB versus 92.0 MiB sampled native process-tree RSS,
  and neither target showed monotonic memory growth across fanout samples.
- At the checkpoint, the selected upstream blocker probes passed with the
  patched Wasmer and patched wasix-libc sysroot.
- The checkpoint Wasmer LLVM lowered Wasm `i32/i64.rotl/rotr` through LLVM
  funnel-shift intrinsics. The real PostgreSQL `md5_calc` hot function emitted
  AArch64 `ror` instructions instead of shift/add rotate sequences. This was a
  generic compiler fix and improved the 100k `release-o3` md5/query warm
  repeat, but the 5M md5 pass showed it was not sufficient by itself for native
  latency.
- The strict `dynamic-dlopen` probe proves the production extension-loading
  shape: an EH/PIC dynamic-main module loads and calls a WASIX side module.

## Patch Discipline

PostgreSQL patches here must explain:

- what native PostgreSQL behavior is being preserved;
- which WASIX/runtime/compiler fact forced the patch;
- which alternative was rejected and why;
- which smoke/regression/performance gate proves the patch.

Upstream Wasmer/wasix-libc patches are WIP export artifacts. Before sending any
piece upstream, split it into one coherent change, remove stale experiment code,
match upstream style, and prove it with the smallest relevant probe/test.
