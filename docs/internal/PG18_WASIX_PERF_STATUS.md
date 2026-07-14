# PG18 WASIX Performance Status

Date: 2026-05-29

## 2026-05-29 Recheck

The active PG18 WASIX runtime is now the 37-patch Oliphaunt-style
implementation stack.  The apparent `1.26x`-`1.28x` regression came from
running the perf harness through a dev `cargo run` host.  The comparable
product path is `cargo run --release -p xtask ...`; with that release host, the
regenerated 37-patch PG18 artifact is faster than same-host PG17.5 and the
documented PG17.5 release table on every speed-test head.

Upstream `postgres/postgres` was checked against real PostgreSQL
base tags by fetching `REL_17_5` and `REL_18_3` from `postgres/postgres` into
the local Oliphaunt checkouts.  `PG17 legacy lane` changes 54 files versus
PostgreSQL `REL_17_5`; `PG18 legacy lane` changes 55 files versus PostgreSQL
`REL_18_3`.  The core runtime deltas are the same in both branches:
`build-oliphaunt.sh`, `oliphaunt/src/oliphauntc/oliphauntc.c`, `xlog.c`,
`checkpointer.c`, `postgres.c`, `postinit.c`, `guc.c`, plus storage/init
support files.  The upstream PG18 branch does not contain hidden btree, hash,
LIKE, or executor speed patches beyond the Oliphaunt single-backend lifecycle
shape.

Diagnostic timing/count patches `0035`-`0039` are not release implementation
patches and are not in the active series.  `0039` was explicitly harmful
because it added live `XLogWrite()` counters even when backend timing was not
compiled in.  A later release-candidate `0035` experiment that tried to coalesce
single-user `XLogWrite()` buffer writes was also rejected: the broadened
ring-contiguous version made the Test 11 diagnostic worse (`INSERT 2` about
`204 ms`, `COMMIT` about `38 ms`) than the 34-patch lane (`INSERT 2` about
`93 ms`, `COMMIT` about `14 ms`).

Another rejected `0035` experiment tried to avoid the `xlblocks` readiness scan in
single-user `XLogWrite()` while preserving write grouping and LSN advancement.
It built, but regressed the focused Test 11 buffer/cache diagnostic
(`INSERT 1` `45.412 ms`, `INSERT 2` `144.774 ms`, `COMMIT` `21.959 ms`), so it
was removed and the active artifacts were restored to the 34-patch fingerprint
below.

The accepted `0035` patch,
`0035-oliphaunt-wasix-avoid-xlogwrite-prevseg-division.patch`, keeps the
PostgreSQL `XLogWrite()` grouping and LSN advancement semantics but replaces the
per-WAL-page `XLByteInPrevSeg()` dynamic division in the hot scan loop with
cached open-segment byte bounds.  This did not fix the isolated Test 11 COMMIT
diagnostic (`15.603 ms`, versus `13.993 ms` for the 34-patch baseline and
`0.711 ms` for same-host PG17.5), but it materially improved the full speed
suite.

A release-o3/ThinLTO rebuild of the same 35-patch source was tested at
`target/perf/pg18-wasix-core-release-o3-35patch-prevseg-bounds-release-host-speed-server-sqlx.json`.
It improved Test 15 (`73.637 ms`, `0.989x` documented PG17.5) but regressed
overall (`1.104x` geomean versus the O2 35-patch median) and missed documented
PG17.5 on Tests 1, 3, 6, 10, 11, and 16.  Keep the active perf artifact on the
O2 release profile.

Current active artifact:

- PostgreSQL version: `18.4`
- active patch count: `36`
- source fingerprint:
  `18.4:81a81ec695fb0c7901407defaa1d2f7973617154cf27ba74e3a7ab8e64436094:3cfc56f67ba63996e8efd7414464c269a3e65f3d4abbd3c65c7a4cf8e8b0d7c4`
- latest accepted perf patch:
  `0036-oliphaunt-wasix-skip-activity-id-reporting.patch`
- verification:
  `assets release-build --profile release
  --skip-build --skip-package-size` passes source-spine, source-isolation,
  canonical-layout, manifest-pin, and AOT packaging checks.
- current release-host result files:
  `target/perf/pg18-wasix-core-release-o2-36patch-skip-activity-id-release-host-speed-server-sqlx.json`,
  `target/perf/pg18-wasix-core-release-o2-36patch-skip-activity-id-release-host-speed-server-sqlx-rerun.json`,
  `target/perf/pg18-wasix-core-release-o2-36patch-skip-activity-id-release-host-speed-server-sqlx-rerun2.json`
- release-host reruns can use the stable PG18 generated asset and AOT paths:
  `OLIPHAUNT_WASM_GENERATED_ASSETS_DIR=.../target/oliphaunt-wasix/assets`,
  and `OLIPHAUNT_WASM_GENERATED_AOT_DIR=.../target/oliphaunt-wasix/aot`.
  Asset, PGDATA-template, and AOT manifests carry source-fingerprint metadata,
  so a stale artifact fails with a fingerprint mismatch before measurement.

Current 37-patch O2 release-host three-run median against same-host PG17.5
`0.5.0` and the documented PG17.5 release-lane table in
`src/docs/content/reference/performance.md`:

| Test | PG18 37-patch O2 median ms | PG17.5 same-host median ms | PG18 / same-host | Documented PG17.5 ms | PG18 / documented |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 19.565 | 19.893 | 0.984 | 19.76 | 0.990 |
| 2 | 144.833 | 165.821 | 0.873 | 149.54 | 0.969 |
| 2.1 | 50.490 | 61.670 | 0.819 | 59.39 | 0.850 |
| 3 | 209.441 | 253.007 | 0.828 | 253.38 | 0.827 |
| 3.1 | 79.769 | 107.124 | 0.745 | 95.12 | 0.839 |
| 4 | 142.026 | 190.276 | 0.746 | 162.89 | 0.872 |
| 5 | 236.305 | 388.982 | 0.607 | 338.01 | 0.699 |
| 6 | 11.756 | 14.996 | 0.784 | 13.08 | 0.899 |
| 7 | 120.748 | 142.110 | 0.850 | 125.31 | 0.964 |
| 8 | 68.267 | 85.746 | 0.796 | 74.42 | 0.917 |
| 9 | 520.213 | 610.845 | 0.852 | 578.96 | 0.899 |
| 10 | 583.991 | 775.341 | 0.753 | 712.38 | 0.820 |
| 11 | 76.259 | 97.814 | 0.780 | 97.43 | 0.783 |
| 12 | 6.814 | 10.813 | 0.630 | 9.74 | 0.700 |
| 13 | 11.898 | 27.974 | 0.425 | 26.58 | 0.448 |
| 14 | 69.192 | 78.119 | 0.886 | 71.60 | 0.966 |
| 15 | 74.343 | 90.388 | 0.822 | 74.49 | 0.998 |
| 16 | 6.777 | 9.970 | 0.680 | 10.17 | 0.666 |

Geomean: `0.759x` same-host PG17.5 and `0.826x` documented PG17.5.  This is
per-head parity against both the same-host PG17.5 release-lane rerun and the
documented PG17.5 release table.  The previous 35-patch O2 median was already
green against same-host PG17.5 but missed the documented table on Test 15
(`75.954 ms` versus `74.49 ms`).  The accepted 36th patch removes unused
pg_stat_activity query/plan ID reporting from the embedded WASIX runtime,
bringing Test 15 to `74.343 ms` while keeping every other head under both
baselines.

The current Test 15 diagnostic is at
`target/perf/pg18-wasix-core-release-o2-36patch-skip-activity-id-diagnose-speed-15.json`.
It records `74.108 ms` total for the selected benchmark buffer, with
`73.530 ms` inside `postgres.protocol.dispatch_buffer`, `253 us` in
`postgres.protocol.input_write`, `30 us` in output read, and `0 us` in
`client.finish.sync_to_fs`.  The same diagnostic on the old 31-patch stack was
`104.165 ms` with `103.748 ms` in dispatch, and the 35-patch release candidate
was `76.756 ms` with `76.271 ms` in dispatch.

The current branch also cannot directly rerun the released PG17.5 AOT: the Rust
loader now expects the newer PG18 protocol-buffer export
`oliphaunt_wasix_input_reset`, while the released PG17.5 module does not export
`_oliphaunt_wasix_input_reset`.  Therefore the preserved `0.5.0` same-host JSON
files remain the PG17.5 comparison baseline unless a compatibility runner is
restored.

Implementation comparison status:

- The PG18 37-patch lane has the important Oliphaunt-style PG18.3 lifecycle hints
  from upstream `PG18 legacy lane` commit
  `cf82a9936be24e6b4203855b34d77a49c83ba2bd`: postmaster-environment flags,
  XLog checkpoint-request guard, local in-process checkpoint behavior, GUC
  report allocation skip, and the POSIX semaphore reset fast path.  The
  LIKE/hash/btree/top-XID fast paths are not upstream Oliphaunt deltas; they were
  ported from the concurrent WASIX experiment and are already in this PG18
  lane.
- `XLogFlush()` is not materially different between PG17.5 Oliphaunt and PG18.3
  Oliphaunt.  The earlier isolated COMMIT diagnostic gap pointed at PG18
  `XLogWrite()`/WAL-buffer scan behavior or the current Oliphaunt WASIX runtime
  state around it, but that sub-step no longer blocks speed-suite parity.
- Strict speed-suite parity is now met on the current three-run median.  Future
  work should focus on validating the activity-ID reporting tradeoff against
  any pg_stat_activity/query-id tests we decide to support in the embedded
  embedded product, plus broader smoke coverage for extensions and pg_dump.

## Current Status

Superseded by the `2026-05-29 Recheck` section above.  This section is retained
as historical context for the earlier 31-patch and pre-release-host
measurements; do not use its fingerprint or result files as the active PG18 lane
status.

The PG18 WASIX runtime builds and runs the product-style
`OliphauntServer` + SQLx speed suite as a core-only perf probe.  It is not yet a
replacement candidate for the released PG17.5 WASIX lane.

Current repeated PG18 probe:

- PostgreSQL version: `18.4`
- source fingerprint:
  `18.4:81a81ec695fb0c7901407defaa1d2f7973617154cf27ba74e3a7ab8e64436094:56d87b5a7e76fca055e49574e8c09df1e363905a2d60d0e81853a679824c192a`
- build profile: `release` (`-O2 -g0`)
- scope: core-only, extensions and `pg_dump` skipped through
  `OLIPHAUNT_WASM_SKIP_EXTENSIONS_FOR_PERF=1`
- result files:
  `target/perf/pg18-wasix-core-release-o2-31patch-speed-server-sqlx.json`,
  `target/perf/pg18-wasix-core-release-o2-31patch-speed-server-sqlx-rerun.json`,
  and
  `target/perf/pg18-wasix-core-release-o2-31patch-speed-server-sqlx-rerun2.json`

The current fair comparison is the product-style `OliphauntServer` + SQLx speed
suite against the documented PG17.5 release-lane table in `src/docs/content/reference/performance.md`.
Across three local PG18 runs, the median geomean is `1.063x` PG17.5, not the
older `1.4-1.5x` estimate from stale single-run files.  The first run after AOT
crate rebuild was a cold outlier (`1.410x` geomean); the next two runs were
`0.983x` and `1.046x`.

Median PG18 server-SQLx misses vs documented PG17.5 release lane:

- Test 15, big DELETE plus 12k small INSERTs: `95.92 ms` vs `74.49 ms`
  (`1.29x`).
- Test 1, 1000 INSERTs: `24.40 ms` vs `19.76 ms` (`1.23x`).
- Test 14, big INSERT after big DELETE: `87.57 ms` vs `71.60 ms` (`1.22x`).
- Test 11, INSERTs from SELECT: `119.07 ms` vs `97.43 ms` (`1.22x`).
- Test 10, 25k text indexed UPDATEs: `862.53 ms` vs `712.38 ms` (`1.21x`).
- Test 7, 5000 indexed SELECTs: `146.06 ms` vs `125.31 ms` (`1.17x`).

The current lane is therefore near parity, but not equal across all heads.  The
remaining repeatable gap is simple-query per-statement overhead, especially
Test 15's `BEGIN; DELETE FROM t1;` followed by 12k one-row `INSERT` statements.
Focused Test 15 diagnostic
`target/perf/pg18-wasix-core-release-o2-31patch-speed-diagnose-15.json`
recorded `104.17 ms` (`1.40x` PG17.5), all inside backend protocol dispatch.

A same-host PG17.5 release-lane rerun was attempted from the public `0.5.0`
release artifacts.  Those artifacts cannot be run through the current PG18
branch loader because the released PG17.5 module uses the old `oliphaunt` archive
names and does not export the newer `oliphaunt_wasix_input_reset`
protocol-buffer entrypoint.  Running the `0.5.0` code in a detached worktree
with the public `0.5.0` assets does work, and gives a same-host baseline:

- PG17.5 same-host server-SQLx files:
  `target/perf/oliphaunt17-0.5.0-samehost-speed-server-sqlx.json` and
  `target/perf/oliphaunt17-0.5.0-samehost-speed-server-sqlx-rerun.json`.
- PG17.5 same-host median is `1.088x` the documented release table geomean.
- PG18 median is `0.977x` the same-host PG17.5 median geomean.

The same-host comparison means PG18 is at overall parity with the released
PG17.5 lane on this machine.  The remaining work is per-head parity, not broad
throughput parity.  PG18 still trails same-host PG17.5 most on:

- Test 1, 1000 INSERTs: `24.40 ms` vs PG17.5 `19.89 ms` (`1.23x`).
- Test 11, INSERTs from SELECT: `119.07 ms` vs PG17.5 `97.81 ms` (`1.22x`).
- Test 14, big INSERT after big DELETE: `87.57 ms` vs PG17.5 `78.12 ms`
  (`1.12x`).
- Test 10, 25k text indexed UPDATEs: `862.53 ms` vs PG17.5 `775.34 ms`
  (`1.11x`).

## Upstream PG18.3 Oliphaunt Branch Hints

Checked upstream `postgres/postgres` branch `PG18 legacy lane` at
commit `cf82a9936be24e6b4203855b34d77a49c83ba2bd` on 2026-05-29.

Superseded by the `2026-05-29 Recheck` implementation-comparison bullets above.
The active 37-patch PG18 lane now carries the relevant upstream Oliphaunt
lifecycle/runtime choices under Oliphaunt-owned markers.  The historical detail
below records what was found before those patches were incorporated.

The branch has six relevant PG18.3 choices:

- `src/backend/tcop/postgres.c`: `oliphaunt_wasix_start()` sets
  `IsPostmasterEnvironment = true` and `IsUnderPostmaster = true`.  The PG18
  Oliphaunt lane now ports those flags in `oliphaunt_wasix_start()` as patch
  `0034`.
- `src/backend/access/transam/xlog.c`: upstream Oliphaunt wraps the
  `XLogCheckpointNeeded(openLogSegNo) -> RequestCheckpoint(CHECKPOINT_CAUSE_XLOG)`
  path in `#ifndef __OLIPHAUNT__`, preventing automatic XLog-size checkpoint
  requests in the Oliphaunt build.
- `src/backend/postmaster/checkpointer.c`: upstream Oliphaunt wraps the
  `if (!IsPostmasterEnvironment)` guard in `#ifndef __OLIPHAUNT__`, so
  `RequestCheckpoint()` runs the local `CreateCheckPoint(... |
  CHECKPOINT_IMMEDIATE)` body even after Oliphaunt marks itself as a postmaster
  environment.
- `src/backend/port/posix_sema.c`: upstream Oliphaunt changes
  `PGSemaphoreReset()` to a single `sem_trywait()` under `__OLIPHAUNT__`.
- `src/backend/utils/misc/guc.c`: upstream Oliphaunt skips the
  `guc_strdup(record->last_reported)` copy in `ReportGUCOption()`.
- `build-oliphaunt.sh`: upstream PG18.3 still uses `--disable-spinlocks`.

The old PG17.5 release lane already guarded for the upstream Oliphaunt
checkpointer shape in its source-spine checks (`stable-checkpointer-disable`,
`stable-external-checkpointer`, and `stable-postmaster-environment`).  The PG18
embedded WASIX runtime intentionally renamed the markers to `OLIPHAUNT_WASM_*` and
currently bans direct `__OLIPHAUNT__` inheritance, so these should be ported as
Oliphaunt-specific patches if we adopt them.

This upstream comparison lines up with the focused Test 11 evidence.  In the
same-host focused buffer/cache diagnostic, PG18 and PG17.5 had near-identical
`INSERT INTO ... SELECT` execution times, but PG18 spent `13.993 ms` in
`COMMIT` while PG17.5 spent only `0.711 ms`.  The most plausible upstream hint
for that miss is not btree/executor work; it is the XLog/checkpoint behavior
around transaction end.

Later WAL instrumentation narrows this further.  Timing patch `0038` showed the
PG18 COMMIT miss is not raw `pg_pwrite`, WALWriteLock, pgstat accounting, fsync,
or walsender wakeup.  Almost all time is in `XLogWrite()`'s per-page loop:

- `COMMIT`: `13.912 ms`
- `commit_xlog_flush`: `13.824 ms`
- `xlog_flush_xlog_write`: `13.821 ms`
- `xlog_write_loop`: `13.819 ms`
- `xlog_write_loop_scan`: `12.884 ms`
- `xlog_write_pwrite`: `0.819 ms`

Counter patch `0039` shows why: on the Test 11 COMMIT, PG18 writes one full
`wal_buffers` ring worth of WAL:

- `xlog_write_loop_count`: `512`
- `xlog_write_page_count`: `512`
- `xlog_write_group_count`: `2`
- `xlog_write_pwrite_count`: `2`
- `xlog_write_pwrite_bytes`: `4,194,304`
- `xlog_write_request_bytes`: `4,188,592`

That means PG18 is doing 512 page-readiness checks and two actual writes at
COMMIT.

A PG17.5 `0.5.0` same-host WAL-state rerun with the same diagnostic shape shows
that PG17.5 reaches COMMIT with essentially the same WAL state, but completes
the tail write much faster:

| Statement | PG17.5 elapsed | PG17.5 insert/flush gap | PG18 elapsed | PG18 insert/flush gap |
| --- | ---: | ---: | ---: | ---: |
| `BEGIN` | `0.065 ms` | `0` | `0.022 ms` | `0` |
| first `INSERT INTO ... SELECT` | `102.184 ms` | `2,757,824` | `29.965 ms` | `2,757,824` |
| second `INSERT INTO ... SELECT` | `197.732 ms` | `9,277,984` | `94.253 ms` | `9,278,000` |
| `COMMIT` | `1.093 ms` | `0` | `13.890 ms` | `0` |

The PG17.5 elapsed values in this WAL-state rerun were produced from a local
diagnostic build of the `0.5.0` xtask, so they should not replace the documented
release-lane timing table. The WAL LSN state is still decisive: PG18 is not slow
because it uniquely defers more WAL to COMMIT. It is slow because the same
already-open WAL tail write path costs much more in the current PG18 WASIX
artifact.

A direct single-user `XLogWrite()` fast-path experiment was tested and rejected.
The first version skipped the normal segment initialization path and failed
during buffer-cache setup case 10 with `WASI exited with code: ExitCode::127`.
Changing the fast path to use `XLogFileInit()` fixed the crash, but made Test 11
COMMIT slower: `23.197 ms` vs the existing PG18 `13.993 ms` and PG17.5
`0.711 ms`.  The experiment was removed from the active patch series.  The
saved failed-result file is
`target/perf/pg18-wasix-core-release-o2-40patch-xlog-fastpath-init-buffer-cache.json`.

An even narrower replacement experiment,
`0040-oliphaunt-wasix-fast-path-open-segment-xlog-write.patch`, was also tested
and rejected. It only ran when the WAL segment was already open and the write
stayed inside that segment. The focused diagnostic result is saved at
`target/perf/pg18-wasix-core-release-o2-40patch-open-segment-xlog-fastpath-buffer-cache.json`.
It reduced Test 11 `COMMIT` only from `13.890 ms` to `11.890 ms`, while
regressing the two `INSERT INTO ... SELECT` statements from `29.965/94.253 ms`
to `119.319/209.435 ms`. It also produced a WAL state after `BEGIN` where
write/flush LSN was ahead of insert LSN by `2216` bytes, so the approach is not
correct enough to keep in the active patch series. The active lane is back to
39 patches.

Patch status:

- `0032-oliphaunt-wasix-avoid-xlog-size-checkpoint-requests.patch` now ports the
  upstream XLog/checkpointer behavior under `OLIPHAUNT_WASM_SINGLE_USER`.
  It intentionally does not set `IsPostmasterEnvironment` or
  `IsUnderPostmaster` in `oliphaunt_wasix_start()`, so the startup-environment
  change remains isolated for a later A/B test.
- `0033-oliphaunt-wasix-use-lightweight-embedded-runtime-paths.patch` now
  ports upstream PG18.3 Oliphaunt's smaller `PGSemaphoreReset()` and
  `ReportGUCOption()` shortcuts under `OLIPHAUNT_WASM_SINGLE_USER`.
- `0034-oliphaunt-wasix-set-embedded-postmaster-environment.patch` now matches
  the released PG17.5 lane and upstream PG18.3 Oliphaunt by setting
  `IsPostmasterEnvironment = true` and `IsUnderPostmaster = true` in
  `oliphaunt_wasix_start()`. This is paired with `0032` so the lane does not
  inherit the multi-process XLog/checkpointer path.
- The sibling PG18/native worktree's perf notes called out the release-lane
  WASIX buffer profile as critical for Oliphaunt benchmark parity:
  `shared_buffers=128MB`, `wal_buffers=4MB`, and `min_wal_size=80MB`.  The PG18
  single-user Rust startup path already preserves those same defaults in
  `DEFAULT_STARTUP_GUCS`, matching the PG17.5 release lane, so the current
  remaining misses are not explained by falling back to PostgreSQL's tiny
  standalone `shared_buffers` default.  The source-spine guard now checks this
  explicitly.

Recommended next measurement order:

1. Rerun the full server-SQLx median table from the restored 39-patch artifact
   if we need a fresh all-head view after the 0040 rejection. The generated
   runtime and AOT manifests are back on source fingerprint
   `18.4:81a81ec695fb0c7901407defaa1d2f7973617154cf27ba74e3a7ab8e64436094:56d87b5a7e76fca055e49574e8c09df1e363905a2d60d0e81853a679824c192a`.
2. Avoid direct XLogWrite fast paths that advance write/flush from rounded page
   boundaries without preserving PostgreSQL's insert-LSN invariants. The next
   WAL attempt should either reduce per-page metadata cost without changing LSN
   advancement, or move unavoidable work earlier only if the full per-head
   median table improves.
3. Keep `PGSemaphoreReset()` and `ReportGUCOption()` as secondary evidence
   until measured. They are credible micro-optimizations, but the current
   evidence points first at COMMIT/checkpoint behavior and many-small-statement
   overhead.

The previous `target/perf/pg18-wasix-core-release-o2-31patch-speed-diagnose-9-10.json`
file is stale for current status.  Rerunning the same focused diagnostic in
`target/perf/pg18-wasix-core-release-o2-31patch-speed-diagnose-9-10-rerun.json`
gave:

- Test 9, 25k indexed UPDATEs: `645.27 ms` vs documented PG17.5
  release-lane `578.96 ms` (`1.11x` slower).
- Test 10, 25k text indexed UPDATEs: `949.05 ms` vs documented PG17.5
  release-lane `712.38 ms` (`1.33x` slower).

Additional controlled indexed-update diagnostic:
`target/perf/pg18-wasix-core-release-o2-31patch-diagnose-indexed-update.json`

This synthetic run uses the PG18 AOT/runtime asset lane and fresh temporary
databases for each case.  It is useful for isolating logged/indexed update
mechanics, but it is not the fair release-lane speed benchmark shape because it
does not run all earlier benchmark cases before measuring Test 9/10:

- exact numeric indexed update: `1128.52 ms`, `1.95x` the documented PG17.5
  Test 9 number (`578.96 ms`).
- exact text indexed update: `1500.82 ms`, `2.11x` the documented PG17.5 Test
  10 number (`712.38 ms`).
- lookup-index-only numeric update: `964.99 ms`, `1.67x` PG17.5 Test 9.
- lookup-index-only text update: `995.51 ms`, `1.40x` PG17.5 Test 10.
- unlogged numeric update: `1196.71 ms`, not better than logged.
- unlogged text update: `1160.32 ms`, better than the exact logged text case
  but still `1.63x` PG17.5 Test 10.

This rules out WAL/fsync as the dominant explanation for the synthetic cold
indexed-update miss.  Removing the updated-column index helps, but only
partially; the remaining cost is still in repeated statement execution plus
tuple/index maintenance.

Upstream PG18.3 Oliphaunt keeps using `--disable-spinlocks`, but this is no longer
a leading explanation for the PG18 Test 11 gap. The current PG18 WASIX
`pg_config.h` has no `HAVE_SPINLOCKS` define and links `src/backend/port/tas.s`
to `tas/dummy.s`; the lane is already on PostgreSQL's no-native-spinlock TAS
path. The `OLIPHAUNT_WASM_PG18_DISABLE_SPINLOCKS=1` knob remains wired, but the
configure script reports the option as unrecognized on this PG18 branch and the
observed build state is already spinlock-disabled.

For historical context, the last full PG18 speed-table probe before the later
diagnostic patches was:
`target/perf/pg18-wasix-core-release-o2-24patch-speed-server-sqlx.json`.  Against
the documented PG17.5 release-lane table in `src/docs/content/reference/performance.md`, that run is
`1.480x` geomean, or about `48.0%` slower.  Against native Postgres + SQLx from
the same table, it is `2.270x` geomean, or about `127.0%` slower.

In that older 24-patch run, the only wins over the documented PG17.5 release
lane were:

- Test 5, string comparison SELECTs: `271.85 ms` vs `338.01 ms`
- Test 12, DELETE without index: `8.73 ms` vs `9.74 ms`
- Test 13, DELETE with index: `15.24 ms` vs `26.58 ms`

The release-blocking misses are concentrated in ordinary insert/index/update
workloads:

- Test 2, 25k INSERTs in a transaction: `317.42 ms` vs `149.54 ms`
- Test 3, 25k INSERTs into an indexed table: `463.47 ms` vs `253.38 ms`
- Test 7, 5000 indexed SELECTs: `316.48 ms` vs `125.31 ms`
- Test 9, 25k indexed UPDATEs: `1322.57 ms` vs `578.96 ms`
- Test 10, 25k text indexed UPDATEs: `1520.13 ms` vs `712.38 ms`
- Test 15, big DELETE plus 12k small INSERTs: `186.20 ms` vs `74.49 ms`

## Backend Timing Probe

A timing-enabled core-only artifact was built with
`OLIPHAUNT_WASM_WASIX_BACKEND_TIMING=1` and used only for diagnostics.  Do not
treat that artifact as a release artifact.

Diagnostic file:
`target/perf/pg18-wasix-core-release-o2-backend-timing-diagnose-speed-9-10.json`

The probe measured fresh-database speed cases 9 and 10 through
`perf diagnose-speed-cases --engine wasix --ids 9,10`.  It recorded backend C
timings around `exec_simple_query`, `PortalRun`, and `finish_xact_command`:

- Test 9, indexed integer UPDATEs: `1422.63 ms` measured.  `exec_simple_query`
  was `1414.48 ms`; `PortalRun` was `593.69 ms`; `finish_xact_command` was only
  `0.58 ms`.
- Test 10, indexed text UPDATEs: `1611.18 ms` measured.  `exec_simple_query`
  was `1599.00 ms`; `PortalRun` was `731.02 ms`; `finish_xact_command` was only
  `0.41 ms`.

This rules out transaction finish, fsync, or client/protocol transport as the
primary explanation for these two misses.  The time is almost entirely inside
backend simple-query execution, but only about `42-45%` of elapsed time is
currently attributed to `PortalRun`.  The remaining `54-58%` is still inside
`exec_simple_query` and needs finer probes around parse/rewrite/plan, command
counter, command completion, receiver teardown, and per-statement loop costs.

Expanded diagnostic file:
`target/perf/pg18-wasix-core-release-o2-backend-timing-expanded-diagnose-speed-9-10.json`

The expanded probe adds timing around simple-query parse, snapshot,
analyze/rewrite, plan, portal start, destination receiver setup, command
counter, and command completion.  Its absolute elapsed times are not directly
comparable to release numbers because it adds many timing calls inside the 25k
statement loop, but the distribution is useful:

- Test 9: `exec_plan` was `684.44 ms` (`35.0%`), `PortalRun` was `548.21 ms`
  (`28.0%`), and `pg_analyze_and_rewrite_fixedparams` was `118.44 ms`
  (`6.1%`).  `finish_xact_command` was `0.62 ms`.
- Test 10: `exec_plan` was `719.02 ms` (`32.9%`), `PortalRun` was `707.39 ms`
  (`32.4%`), and `pg_analyze_and_rewrite_fixedparams` was `135.94 ms`
  (`6.2%`).  `finish_xact_command` was `0.41 ms`.

The indexed-update regression is therefore not just btree execution.  Repeated
simple-query planning is as large as, or larger than, execution for these
cases.  That makes the next high-signal experiment a protocol/query-path
comparison: run equivalent prepared extended-protocol updates against PG18
WASIX and the documented PG17.5 release lane before adding more btree-specific
shortcuts.

## Prepared Update Comparison

Prepared-update diagnostics were run against the timing-enabled PG18 artifact
with source fingerprint
`18.4:81a81ec695fb0c7901407defaa1d2f7973617154cf27ba74e3a7ab8e64436094:62572d0cf8eb828bf90085986da48f17bccfd06cca8444224f431e326b4f8983`.
The timing patch only instruments simple-query execution; the direct raw
extended-protocol measurement below does not run through those simple-query
probes during the measured update batch.

SQLx prepared update file:
`target/perf/pg18-wasix-core-release-o2-prepared-updates-sqlx.json`

SQLx prepared updates are not a useful rescue path in the current server shape:

- numeric indexed update: `3790.06 ms`
- text indexed update: `3828.13 ms`
- protocol shape: `50000` Bind, `50000` Execute, and `50002` Sync messages
  across the two cases, with `50010` protocol batches and `50084` socket
  flushes.

This is slower than simple-query speed tests 9 and 10 because SQLx issues a
Sync boundary per update in this harness.  Avoiding planning does not help if
the protocol path adds 25k round-trip/flush boundaries.

Direct raw pipelined prepared update file:
`target/perf/pg18-wasix-core-release-o2-prepared-updates-direct-raw-pipelined.json`

The raw frontend/backend protocol path prepares one statement, sends all 25k
Bind/Execute/ClosePortal messages in one batch, then sends one Sync:

- numeric indexed update: `1029.91 ms`, down from the PG18 simple-query
  `1322.57 ms` (`22.1%` faster), but still `1.78x` the documented PG17.5
  release-lane simple-query time of `578.96 ms`.
- text indexed update: `1026.58 ms`, down from the PG18 simple-query
  `1520.13 ms` (`32.5%` faster), but still `1.44x` the documented PG17.5
  release-lane simple-query time of `712.38 ms`.

Conclusion: repeated simple-query planning and protocol shape explain a large
piece of the PG18 indexed-update regression, especially for text updates, but
they do not explain enough to make PG18 competitive with the released PG17.5
lane.  Even with planning mostly removed and the protocol batched, PG18 still
needs executor/storage/btree work before it can replace the release lane.

The tokio-postgres prepared server path currently fails before measurement with
`invalid message length: expected buffer to be empty`.  That should be tracked
as an extended-protocol compatibility bug, but it is not the primary perf
blocker because the direct raw protocol path can already run the prepared batch.

## Storage/Executor Timing Probe

Patch `0026` adds diagnostic-only timing around coarse executor/storage hot
paths:

- `heapam_tuple_update`
- `_bt_doinsert`
- `XLogInsertRecord`

Storage diagnostic file:
`target/perf/pg18-wasix-core-release-o2-backend-timing-storage-diagnose-speed-9-10.json`

This diagnostic was run against the 26-patch timing-enabled artifact with
source fingerprint
`18.4:81a81ec695fb0c7901407defaa1d2f7973617154cf27ba74e3a7ab8e64436094:4a71c8a39ce745890a54f69c9f55b069122729a6f08fe15159de07e2925a4b94`.
The absolute elapsed numbers are inflated by additional timing calls inside the
25k statement loop, but the distribution is useful:

- Test 9: `exec_plan` was `689.95 ms`; `PortalRun` was `1106.64 ms`;
  `_bt_doinsert` was `316.71 ms`; `heapam_tuple_update` was `254.55 ms`;
  `XLogInsertRecord` was `184.12 ms`; `finish_xact_command` was `0.54 ms`.
- Test 10: `exec_plan` was `725.38 ms`; `PortalRun` was `1276.53 ms`;
  `_bt_doinsert` was `446.81 ms`; `heapam_tuple_update` was `266.85 ms`;
  `XLogInsertRecord` was `202.59 ms`; `finish_xact_command` was `0.42 ms`.

The storage timings are nested/coarse and should not be summed as independent
costs.  They do show that after separating planning/protocol overhead, btree
insertion is the largest named execution component for indexed updates,
especially for text updates.  Heap update and WAL insertion are material but
smaller.  The next probe should split `_bt_doinsert` into scan-key build,
unique check/search, insert-location search, page insertion/split, and WAL
record construction.

## Btree Insert Timing Probe

Patch `0027` splits the coarse `_bt_doinsert` probe into btree subphases:

- scan-key construction
- root-to-leaf insert search
- uniqueness check
- insert-location search
- page insertion
- page split

Btree diagnostic file:
`target/perf/pg18-wasix-core-release-o2-backend-timing-btree-diagnose-speed-9-10.json`

This diagnostic was run against the 27-patch timing-enabled artifact.  As with
the other timing builds, absolute elapsed time is inflated by instrumentation in
the 25k statement loop.  The subphase distribution is still useful:

- Test 9: `_bt_doinsert` was `862.00 ms`; scan-key build was `71.30 ms`;
  insert search was `87.28 ms`; insert-location search was `96.72 ms`;
  page insertion was `260.63 ms`; page split was only `14.12 ms`.
- Test 10: `_bt_doinsert` was `987.99 ms`; scan-key build was `71.21 ms`;
  insert search was `88.75 ms`; insert-location search was `223.50 ms`;
  page insertion was `259.59 ms`; page split was only `13.91 ms`.

No uniqueness-check timing was reported in cases 9 or 10 because these benchmark
indexes are not unique.  Page splits are also not the culprit.  The text update
case pays much more in `_bt_findinsertloc` than the numeric update case, while
both cases spend a similar amount in page insertion.  A substantial residual
remains inside `_bt_doinsert` after the named subphases, so the next btree probe
should look at comparator/TID/posting-list/dedup support paths used between the
current timers rather than at split handling.

Patch `0028` adds that next diagnostic layer.  It times leaf-page insert binary
search and `_bt_compare` separately as `btree_binsrch_insert` and
`btree_compare`.  `_bt_compare` is intentionally a diagnostic-only timer because
it can run many times per statement and will perturb absolute elapsed time; the
useful signal is whether comparison/search accounts for the residual left by
the `0027` split.  The probe uses only `oliphaunt_wasix_*` timing symbols and
remains compiled out of normal release artifacts.

The 29-patch timing artifact was rebuilt and packaged with
`OLIPHAUNT_WASM_SKIP_EXTENSIONS_FOR_PERF=1` for the focused diagnostic.  That
perf package includes the PG18 runtime, plpgsql, dict_snowball, initdb, and AOT
artifacts, but intentionally skips external PGXS extensions.

Btree compare diagnostic file:
`target/perf/pg18-wasix-core-release-o2-backend-timing-btree-compare-diagnose-speed-9-10.json`

This run is more invasive than the `0027` split because it times `_bt_compare`
inside hot binary-search loops and nested timers double-count.  Absolute elapsed
time should therefore not be compared to release numbers.  The distribution is
still useful:

- Test 9: elapsed was `7310.06 ms`; `_bt_doinsert` was `3578.45 ms`;
  `_bt_compare` was `1867.51 ms`; leaf insert binary search was `1333.26 ms`;
  root-to-leaf insert search was `1307.54 ms`; insert-location search was
  `1507.74 ms`; page insertion was `293.59 ms`; page split was `16.12 ms`.
- Test 10: elapsed was `8093.33 ms`; `_bt_doinsert` was `3999.24 ms`;
  `_bt_compare` was `2023.19 ms`; leaf insert binary search was `1392.06 ms`;
  root-to-leaf insert search was `1468.11 ms`; insert-location search was
  `1725.99 ms`; page insertion was `311.86 ms`; page split was `18.77 ms`.

Conclusion: comparison/search work is now the leading btree signal for indexed
integer lookup and reinsertion.  The next candidate should not target page
splits.  It should either revive a corrected first-column int4 tuple-data
compare shortcut for the simple integer benchmark shape or split heap update
and WAL behavior before changing more release-default behavior.

Patch `0030` is the first release-default candidate from that conclusion.  It
adds a corrected first-column int4 leaf-tuple fast path.  Unlike the earlier
full-concurrent experiment shortcut, this version keeps the old `oliphaunt` naming
out of the source, requires the built-in integer btree opfamily, requires a
normal non-null non-posting non-pivot leaf tuple, and treats equality as a
successful key comparison so the attribute loop is skipped while PostgreSQL's
existing heap-TID/truncated-key tie-break code still runs.  It should primarily
affect Test 9.  Test 10 still needs heap update, non-HOT update, and WAL
investigation because it updates an unindexed text column while looking up rows
through the integer index on `a`.

Focused non-timing diagnostic file after `0030`:
`target/perf/pg18-wasix-core-release-o2-30patch-speed-diagnose-9-10.json`

This was run against a rebuilt non-timing release-profile artifact with external
PGXS extensions skipped for the perf package:

- Test 9: `1256.64 ms`.
- Test 10: `1476.79 ms`.

Compared with the earlier PG18 simple-query speed run (`1322.57 ms` and
`1520.13 ms`), `0030` is a small directional win for the int4 indexed-update
case and a marginal win for the text case.  It is not enough to catch the
documented PG17.5 release lane (`578.96 ms` and `712.38 ms`).  Keep the patch
as a candidate, but the next material optimization needs to address heap
update/WAL behavior and/or remove more repeated planning/protocol overhead.

Patch `0031` corrects the next diagnostic direction: Test 10 updates the
unindexed text column `c` while using the integer index on `a` for lookup, so it
is not primarily a text btree comparator workload.  The patch adds
diagnostic-only heap update timers for modified-column detection, toast work,
new-page buffer selection, heap tuple insertion, and heap update WAL logging.

Heap diagnostic file:
`target/perf/pg18-wasix-core-release-o2-31patch-backend-timing-heap-diagnose-speed-9-10.json`

This timing artifact is intentionally not a release-performance comparison.  It
adds hot-loop timing calls around btree comparison and heap update internals and
inflates the absolute elapsed time to `6657.05 ms` for Test 9 and `6944.91 ms`
for Test 10.  The useful signal is distribution:

- Test 9: `_bt_doinsert` was `3161.08 ms`; `_bt_compare` was `1642.43 ms`;
  `exec_plan` was `694.00 ms`; `heapam_tuple_update` was `459.31 ms`;
  `XLogInsertRecord` was `176.97 ms`; heap subprobes were small
  (`heap_get_buffer_for_tuple` `44.50 ms`, `heap_determine_columns`
  `40.03 ms`, `heap_put_tuple` `37.47 ms`).
- Test 10: `_bt_doinsert` was `3338.45 ms`; `_bt_compare` was `1683.47 ms`;
  `exec_plan` was `716.89 ms`; `heapam_tuple_update` was `469.71 ms`;
  `XLogInsertRecord` was `193.83 ms`; heap subprobes were again small
  (`heap_get_buffer_for_tuple` `45.60 ms`, `heap_put_tuple` `37.76 ms`,
  `heap_determine_columns` `37.15 ms`).

Conclusion: the Test 10 miss is not primarily TOAST, heap-page selection, heap
tuple copy, or heap-update WAL logging.  The timing artifact still points at
non-HOT indexed update behavior, btree reinsertion/search/compare work, and
repeated simple-query planning as the high-value areas.  The heap subprobes do
not justify a heap-specific shortcut yet.

The full-concurrent experiment's btree bottom-up-delete runtime toggle was also
tested as a possible diagnostic import.  It is not carried in the patch stack.
Even with upstream behavior selected by default, the local embedded port
regressed the no-timing 9/10 run to `2284.27 ms` and `2795.44 ms`; the
`index-unchanged-off` override was no better overall (`2327.91 ms` and
`2765.07 ms`).  That makes the hook itself too perturbing for this lane, and
disabling bottom-up deletion remains rejected as a default behavior change.

Patch `0029` also fixes a buildability issue found while refreshing the timing
package: standalone PG18 WASIX `pg_dump` references `fork()` through PostgreSQL's
parallel dump support, but the single-user sysroot does not provide that symbol.
The patch gives the packaged tool a local `ENOSYS` fork stub under
`OLIPHAUNT_WASM_SINGLE_USER`, so `pg_dump` links without a fork runtime import
and any accidental parallel worker use fails through the existing error path.

## Release Hygiene

The rebuilt PG18 runtime binary does not contain the old `pgl_*`/`Oliphaunt`
runtime symbol strings when inspected from the packaged `oliphaunt/bin/oliphaunt`
module.  The PG18 patch stack and build scripts also keep the new
`oliphaunt_wasix_*` naming.

Patch `0030` work also tightened generated metadata: PG18 asset manifests now
filter released-lane source pins whose names, URLs, or branch labels refer to
the old Oliphaunt provenance and replace the PostgreSQL source pin with the PG18
tarball plus the PG18 patch-series fingerprint.  The regenerated PG18 perf
manifest now reports PostgreSQL `18.4`, and
zero old `pgl`/`oliphaunt` provenance references in its source pins.

## Patch Disposition From This Run

The full-concurrent experiment's LIKE literal substring fast path remains in
the embedded WASIX runtime as patch `0024`.  It appears directionally useful for Test
5, but it does not address the dominant misses.

The full-concurrent experiment's first-column int4 tuple-data btree shortcut was
tested and removed from the default patch stack.  With that shortcut present,
the core-only O2 run was still not competitive (`1.385x` geomean vs PG17.5),
and the indexed update cases remained more than `2x` slower.  The patch remains
recorded as deferred in
`src/runtimes/liboliphaunt/wasix/assets/build/postgres/experiment-patch-disposition.toml`.

## Full Concurrent WASIX Direction

The concurrent PG18 WASIX experiment is still valuable runtime research, but it
is not a near-term performance replacement path.  Its upstream Wasmer and
WASIX-libc patches are mostly correctness/runtime-enablement work:

- fixed shared file-backed memory remapping and `msync`
- memory-copy exclusion for forked stores
- resource limits for stack reporting
- socket, epoll, waitpid, futex, signal, and `sigsetjmp` behavior fixes
- fork declarations and full EXEC_BACKEND runtime unblockers

Those are necessary for proper multi-process PostgreSQL semantics under WASIX,
but they add lifecycle and memory-management work that the product-style
single-backend lane intentionally avoids.  They should be tracked upstream and
mined for narrow fixes, not used as the default product architecture until the
runtime can show competitive steady-state SQL numbers.

The actual local concurrent experiment branch is
`/Users/sid/dev/oliphaunt-oxide-wasix-pg18-experiment` on
`f0rr0/wasix-pg18-experiment`, with a detached copy at
`/Users/sid/.codex/worktrees/2eae/oliphaunt-oxide`.  Its query-hot PostgreSQL patch
stack has now been fully triaged against this embedded WASIX runtime:

- `0006-like-literal-substring-fast-path.patch`: already ported as `0024` with
  tighter LIKE/collation guards.
- `0007-top-xid-current-transaction-fast-path.patch`: already ported as `0015`.
- `0008-btree-int4-compare-fast-path.patch`: already ported as `0016` with
  tighter opfamily/type/collation guards.
- `0009-btree-delete-stack-state.patch`: already ported as `0017` under
  `__wasi__ && OLIPHAUNT_WASM_SINGLE_USER`.
- `0010-btree-bottomup-delete-runtime-toggle.patch`: remains rejected for the
  default lane. A local embedded port of the diagnostic hook made the default
  release-profile Test 9/10 run slower before any override was enabled, and
  disabling bottom-up deletion changes PostgreSQL index maintenance behavior.
- `0011-btree-first-int4-compare-fast-path.patch`: already ported as `0030`
  with tighter leaf/non-null/non-posting/non-pivot/built-in-int4 guards.

That leaves the remaining same-host misses after `0032`-`0034` as measurement
work rather than an obvious unported concurrent-experiment patch.  The next
artifact rebuild needs to answer whether the newly ported checkpoint,
postmaster-environment, semaphore-reset, and GUC-reporting changes close Test
11 and improve the smaller Test 1/10/14/15 misses.

## Recommendation

Do not promote PG18 WASIX as the `0.6.0` replacement yet solely on this local
evidence.  The lane is close enough to parity that the old "2x slower indexed
updates" framing should be retired, but release confidence still needs a
repeat-based run under the same conditions as the PG17.5 release-lane table.

Continue the PG18 WASIX runtime, not the full concurrent WASIX lane, as the
main product direction.  The next perf work should focus on closing the
remaining median misses rather than adding broad speculative PostgreSQL
shortcuts:

- use repeated server-SQLx runs and compare medians/p90s, because the first run
  after AOT crate rebuild can be a cold outlier;
- focus next on Test 15 and other many-small-simple-statement cases, where PG18
  still shows per-statement overhead;
- keep the spinlock-disabled build knob as the highest-signal upstream Oliphaunt
  PG18.3 experiment once Docker is available;
- treat old indexed-update files above `2x` as stale unless reproduced with the
  current AOT/runtime lane;
- keep `release`/O2 as the measured baseline until `release-o3`/thin-LTO or
  wasm-opt proves a repeatable win for this workload;
- leave the full concurrent WASIX mmap/fork patches as runtime research unless
  a narrow part directly improves the single-backend lane.

## 2026-05-29 34-Patch Rebuild

Docker was brought up locally and the PG18 WASIX runtime was rebuilt with the
34-patch stack in release/O2 profile:

```sh
OLIPHAUNT_WASM_SKIP_EXTENSIONS_FOR_PERF=1 \
OLIPHAUNT_WASM_BUILD_PROFILE=release \
FORCE_RECONFIGURE=1 \
cargo run -p xtask -- assets release-build \
  \
  --profile release \
  --skip-package-size
```

The backend/runtime build completed. Packaging then required the maintainer-only
template runner, so the packaging/AOT phase was rerun with:

```sh
OLIPHAUNT_WASM_SKIP_EXTENSIONS_FOR_PERF=1 \
OLIPHAUNT_WASM_BUILD_PROFILE=release \
cargo run -p xtask --features template-runner -- \
  assets release-build \
  \
  --profile release \
  --skip-build \
  --skip-package-size
```

The generated runtime and AOT manifests now report fingerprint
`18.4:81a81ec695fb0c7901407defaa1d2f7973617154cf27ba74e3a7ab8e64436094:941081dbd639e3aa39f631673060cb4b9f506bcb6fb81da821959bb64eab4552`.

Focused diagnostics after the rebuild:

- Test 1: `20.720 ms`
- Test 11: `114.064 ms`

That improves the old focused PG18 31-patch Test 1/11 numbers (`24.40 ms` and
`119.07 ms`), but still does not fully match same-host PG17.5 for Test 11.

The full server-SQLx speed benchmark was run twice against the rebuilt PG18 AOT
artifact:

- `target/perf/pg18-wasix-core-release-o2-34patch-speed-server-sqlx.json`
- `target/perf/pg18-wasix-core-release-o2-34patch-speed-server-sqlx-rerun.json`

Using the median of those two PG18 runs against the median of the two same-host
PG17.5 `0.5.0` runs gives `1.002x` geomean. Against the documented release-lane
table it is still `1.090x` geomean. The parity is therefore geomean-only; it is
not per-head parity.

| Test | PG18 median ms | PG17.5 same-host median ms | PG18 / PG17.5 | PG18 / documented |
| --- | ---: | ---: | ---: | ---: |
| 1 | 21.40 | 19.89 | 1.076 | 1.083 |
| 2 | 170.08 | 165.82 | 1.026 | 1.137 |
| 2.1 | 62.47 | 61.67 | 1.013 | 1.052 |
| 3 | 289.88 | 253.01 | 1.146 | 1.144 |
| 3.1 | 90.27 | 107.12 | 0.843 | 0.949 |
| 4 | 191.12 | 190.28 | 1.004 | 1.173 |
| 5 | 361.47 | 388.98 | 0.929 | 1.069 |
| 6 | 17.42 | 15.00 | 1.162 | 1.332 |
| 7 | 164.94 | 142.11 | 1.161 | 1.316 |
| 8 | 94.25 | 85.75 | 1.099 | 1.266 |
| 9 | 665.56 | 610.85 | 1.090 | 1.150 |
| 10 | 822.84 | 775.34 | 1.061 | 1.155 |
| 11 | 112.66 | 97.81 | 1.152 | 1.156 |
| 12 | 9.90 | 10.81 | 0.916 | 1.016 |
| 13 | 15.38 | 27.97 | 0.550 | 0.579 |
| 14 | 80.28 | 78.12 | 1.028 | 1.121 |
| 15 | 103.93 | 90.39 | 1.150 | 1.395 |
| 16 | 8.73 | 9.97 | 0.876 | 0.858 |

The Test 11 buffer/cache diagnostic still shows the same COMMIT gap as the
31-patch lane:

| Statement | PG18 34-patch ms | PG17.5 same-host ms |
| --- | ---: | ---: |
| `BEGIN` | 0.019 | 0.023 |
| `INSERT INTO t1 SELECT b,a,c FROM t2` | 29.808 | 29.384 |
| `INSERT INTO t2 SELECT b,a,c FROM t1` | 93.056 | 90.342 |
| `COMMIT` | 13.993 | 0.711 |

This confirms that patches `0032` and `0034` are applied and built, but they do
not explain or remove the remaining Test 11 COMMIT cost. Source inspection also
confirms the rebuilt PG18 source contains the same upstream PG18.3 Oliphaunt-style
`IsPostmasterEnvironment = true`, `IsUnderPostmaster = true`,
`XLogCheckpointNeeded` guard, and `RequestCheckpoint` guard. The remaining
COMMIT gap is therefore either a different PG18 WAL/checkpoint/pgstat/SLRU path,
or an interaction with the current Oliphaunt WASIX runtime/startup state, not a
simple failure to port those upstream Oliphaunt branch hints.

The status after this rebuild is:

- PG18 WASIX is now geomean-parity with same-host PG17.5 within local
  two-run noise.
- PG18 WASIX is still not per-test parity and is still behind the
  documented release-lane table.
- The broad "PG18 is catastrophically slower" claim is no longer accurate for
  the current 34-patch release/O2 artifact.
- The remaining high-signal misses are Test 3, 6, 7, 8, 11, and 15, with Test
  11 still carrying a clear COMMIT-specific gap.

## 2026-05-29 COMMIT Timing Split

The Test 11 COMMIT gap was split with diagnostic-only timing patches:

- `0035-oliphaunt-wasix-add-commit-backend-timing-probes.patch`
- `0036-oliphaunt-wasix-add-commit-record-backend-timing-probes.patch`
- `0037-oliphaunt-wasix-add-xlog-flush-write-timing-probes.patch`
- `0038-oliphaunt-wasix-split-xlog-write-tail-timing.patch`

Both patches are compiled out unless `OLIPHAUNT_WASIX_BACKEND_TIMING=1`.

The first timing build showed that the cost is inside
`RecordTransactionCommit()`:

| Phase | Time |
| --- | ---: |
| `COMMIT` wall time | `13.870 ms` |
| `exec_finish_xact` | `13.805 ms` |
| `commit_record` | `13.780 ms` |
| `commit_resource_locks` | `0.010 ms` |
| `commit_local_cleanup` | `0.004 ms` |
| all other commit cleanup probes | `0.001 ms` each |

The second timing build split `RecordTransactionCommit()`:

| Phase | Time |
| --- | ---: |
| `COMMIT` wall time | `20.725 ms` |
| `commit_record` | `20.642 ms` |
| `commit_xlog_flush` | `20.634 ms` |
| `commit_xlog_record` | `0.002 ms` |
| `commit_clog_commit_tree` | `0.002 ms` |
| `commit_sync_rep_wait` | `0.001 ms` |

The timing build has extra probe overhead and a different code shape, so its
absolute COMMIT time should not be compared directly to release/O2. The useful
fact is the attribution: essentially all of the PG18 Test 11 COMMIT gap is
`XLogFlush(XactLastRecEnd)`, even with:

| Setting | Value |
| --- | --- |
| `fsync` | `off` |
| `synchronous_commit` | `on` |
| `shared_buffers` | `128MB` |
| `wal_buffers` | `4MB` |

This rules out the PG18 transaction cleanup additions as the main cause:
`AtEOXact_Aio`, relcache/typecache cleanup, invalidation, procarray end,
resource-owner cleanup, notification, memory cleanup, CLOG commit, WAL record
construction, and sync-rep wait are all microsecond-level in the diagnostic.

The PG17.5 Oliphaunt-style source and the current PG18 source are structurally
similar in `RecordTransactionCommit()`: both call `XLogFlush(XactLastRecEnd)`
when `synchronous_commit > off`. Upstream `PG18 legacy lane` does not carry an
additional Oliphaunt-specific `XLogFlush` fast path; it only has the checkpoint
guard that is already ported as `OLIPHAUNT_WASM_SINGLE_USER`.

The third timing build ruled out the obvious lower-level suspects:

| Phase | Time |
| --- | ---: |
| `COMMIT` wall time | `13.750 ms` |
| `commit_xlog_flush` | `13.653 ms` |
| `xlog_flush_xlog_write` | `13.650 ms` |
| `xlog_write_pwrite` | `0.760 ms` |
| `xlog_flush_wal_write_lock` | `0.001 ms` |

A `max_wal_senders=0` startup-GUC diagnostic still showed the same shape:
`COMMIT` was `15.535 ms` and `commit_xlog_flush` was `15.437 ms`. So the
remaining gap is not walsender wakeup, WALWriteLock waiting, fsync, or raw host
write time.

The fourth timing build split `XLogWrite()` itself:

| Phase | Time |
| --- | ---: |
| `COMMIT` wall time | `13.912 ms` |
| `commit_xlog_flush` | `13.824 ms` |
| `xlog_flush_xlog_write` | `13.821 ms` |
| `xlog_write_loop` | `13.819 ms` |
| `xlog_write_loop_scan` | `12.884 ms` |
| `xlog_write_pwrite` | `0.819 ms` |
| `xlog_write_pgstat_io` | `0.001 ms` |
| `xlog_write_fsync` | `0.001 ms` |
| `xlog_write_walsnd_request` | `0.001 ms` |

This changes the diagnosis: the PG18 COMMIT miss is dominated by the
per-WAL-page scan/grouping loop in `XLogWrite()`, not by PG18's new
`pgstat_count_io_op_time()` accounting, the filesystem call, fsync, or
walsender signaling. Relation sizes match the PG17.5 diagnostic exactly, so the
next question is whether PG18 is arriving at COMMIT with more unwritten WAL or
whether the same WAL-buffer walk is materially slower in the PG18/WASIX codegen
path.

Next high-signal checks:

- add a count/byte diagnostic for `XLogWrite()` loop iterations, pages grouped,
  and bytes passed to `pg_pwrite()` for PG18, then compare against a PG17.5
  timing build if feasible;
- inspect `AdvanceXLInsertBuffer()`/WAL-buffer-full write behavior to see whether
  PG18 defers more WAL to COMMIT than PG17.5 under the same `wal_buffers=4MB`;
- evaluate a WASIX-single-user fast path that writes WAL from contiguous buffer
  ranges without the full per-page scan when the target range is known ready;
- separately test `relaxed_durability(true)` / `synchronous_commit=off`, because
  that should bypass the synchronous `XLogFlush()` commit path and establish the
  upper bound for Test 11 parity.
