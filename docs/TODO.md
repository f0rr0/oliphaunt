# To Do

This is the single implementation backlog for `pglite-oxide`. User-facing docs
describe supported behavior; this file owns unfinished architecture,
implementation, release, and research work.

## Product Target

`pglite-oxide` should provide embedded Postgres for Rust tests and local apps:

- no Docker, local LLVM, Cranelift, or Postgres build step for users;
- direct Rust API for embedded use;
- local server mode for SQLx, `tokio-postgres`, Diesel, SeaORM, Python, Go,
  Node, and any other Postgres client;
- bundled pgvector and common SQL extensions;
- `pg_dump` support driven by the same packaged runtime.

The production runtime target is PGlite/Postgres built as WASIX dynamic-linking
modules, precompiled with Wasmer LLVM AOT in CI, then loaded through headless
Wasmer in applications.

## Release Blockers

These are the top-level blockers before calling the WASIX/Wasmer path
production ready:

1. Generate and validate asset/AOT packs across the supported target matrix:
   macOS arm64/x64, Linux x64/arm64, and Windows x64.
2. Enforce cold-start release gates in CI after collecting release-mode
   baselines on GitHub Ubuntu.
3. Broaden extension generation and smoke tests beyond `vector` and `pg_trgm`.
4. Promote the private `pg_dump` runner to public API/CLI only after public
   dump/restore tests pass.
5. Harden CI, release-plz, package-size gates, Trusted Publishing, and
   dependency invariants for all internal asset and AOT crates.

## Bucket 1: Performance And Runtime Architecture

This is the next execution bucket. Performance work is product work, not
optional research.

Classification rule: if a work item affects both cold and hot/warm behavior,
track it under cold. The hot/warm section is only for repeated-open,
steady-state, idle, or ongoing-server behavior that does not primarily block the
first startup/query experience.

### Cold Path

Cold path means first process startup, first database open, first query, first
extension load, artifact install/deserialization, and any item that also affects
warm behavior.

Current cold measurements that still need to be driven down:

- `cargo run --release -p xtask -- perf cold` now labels cache, process, root,
  query, workload, and primary visible-latency state explicitly. In the latest
  cache-existing local release run, primary visible latencies were:
  `process_cold_runtime_preload` about 53ms,
  `process_warm_new_temp_direct_first_query` about 53ms,
  `process_warm_second_new_temp_direct_first_query` about 45ms,
  `process_warm_new_temp_direct_vector_first_query` about 54ms,
  `process_warm_new_temp_server_tokio_postgres_first_query` about 47ms,
  `process_warm_new_temp_server_sqlx_first_query` about 47ms, and
  `process_warm_new_temp_server_sqlx_vector_first_query` about 54ms. Lifecycle
  totals remain higher when shutdown/teardown is included;
- `cargo run --release -p xtask -- perf cold --reset-cache` forces first-install
  cache bootstrap into the first measured operation. In the latest local run,
  runtime cache install added about 99ms to `process_cold_runtime_preload`,
  PGDATA template cache install added about 152ms to the first new temporary
  root, and vector extension-template creation added about 419ms to the first
  vector temporary root. Subsequent new roots in the same process/cache run did
  not pay those bootstrap costs;
- direct temporary scalar queries no longer pay a full array catalog scan.
  Built-in arrays are registered statically, and custom/runtime arrays are
  discovered lazily or through an explicit type-cache refresh;
- direct temporary first query is now expected to be dominated by PostgreSQL
  backend startup around 31-34ms, Wasmer instance creation around 6-10ms,
  per-root runtime setup under 1ms, startup/default-GUC handling around
  1.5-1.9ms, and the first parse/describe protocol roundtrip around 6ms. The
  direct API no longer forces a host directory `sync_all` after every query;
- C-side backend startup is now visible down through the key `InitPostgres`
  subphases. Scalar opens are still mostly `shared_memory` around 11-13ms and
  `init_postgres` around 20-30ms. Extension-enabled template opens no longer
  pay crash-recovery-shaped `StartupXLOG`; the clean template path shows
  `postgres.backend.c.startup_xlog` around 3-4ms and
  `postgres.backend.c.relcache_phase3` around 13-14ms locally;
- server first-query paths are now measured separately. Current local release
  scalar SQLx startup is dominated by proxy backend open around 37ms, especially
  PostgreSQL backend startup around 31ms and Wasmer instance creation around
  6ms. Server root preparation is about 1ms for scalar temporary roots and about
  6-7ms for extension-enabled roots that still install requested extension
  assets. SQLx's first query is around 5ms and is mostly PostgreSQL protocol
  main-loop work for the prepared/extended query batch;
- extension-enabled SQLx server startup no longer spends its dominant time in
  `CREATE EXTENSION` when the generic extension-set template cache is warm.
  The remaining bottleneck is ordinary backend open for the extension-enabled
  cluster, especially relcache/catcache work and shared-memory setup;
- PGDATA setup is no longer a dominant cost in the default overlay path.

Cold release gates should be aggressive because this product competes with
ordinary test-fixture setup, not with starting a full external Postgres server.

- temporary database first `SELECT 1` under 500ms on GitHub Ubuntu;
- persistent database first `SELECT 1` under 500ms on GitHub Ubuntu;
- `PgliteServer` start plus first SQLx query under 500ms on GitHub Ubuntu;
- temporary database with requested extensions plus first extension-backed query
  under 500ms on GitHub Ubuntu;
- private `pg_dump` startup plus first dump row under 500ms on GitHub Ubuntu;
- local maintainer machine p50 should be materially faster than CI and tracked
  separately;
- no more than 15% regression after the first stable baseline.

Cold P0, required before calling the path fast:

- keep the source patch on `postgres-pglite` `REL_17_5-pglite` at
  `01792c31a62b7045eb22e93d7dad022bb64b1184`, matching the source/artifact
  pair used by `@electric-sql/pglite` 0.4.5;
- enforce Wasmer/WebAssembly exceptions as a non-optional production invariant:
  the WASIX build must keep `-sWASM_EXCEPTIONS=yes` / `-fwasm-exceptions`, the
  runtime must use an engine path that supports Wasm EH for the main module and
  side modules, and CI must keep SQL error/longjmp recovery tests across the
  supported target matrix. Do not add an exception opt-out flag; a non-EH
  Asyncify path would be a separate experiment, not a supported fallback;
- keep WASIX dynamic-linking flags correct;
- reduce first explicit preload latency further by profiling runtime cache
  setup, default mmap/native deserialization, and Wasmer native artifact
  loading;
- turn the local release perf baselines into CI checks on representative
  runners.
- validate the spinlock-enabled WASIX build across the full target matrix.
  PostgreSQL now uses the toolchain atomics path instead of the old
  `--disable-spinlocks` semaphore fallback; keep this unless a supported target
  proves a correctness issue, and treat performance movement as workload data
  rather than as the reason for the change.

Add phase timers for:

- manifest validation;
- runtime cache/extraction;
- AOT install/decompress/hash;
- module deserialization;
- WASIX runtime construction;
- instance creation;
- backend start;
- startup packet;
- first query;
- extension load;
- first representative extension-backed query;
- `pg_dump`.

Implement and benchmark cold cache and startup fast paths:

- keep Wasmer native mmap deserialization as the default path and continue
  comparing it against `PGLITE_OXIDE_AOT_DESERIALIZE=file` only as a diagnostic
  benchmark. Do not move full content hashing back onto default startup;
- remove the `PGLITE_OXIDE_AOT_DESERIALIZE=file` diagnostic switch after mmap
  deserialization has passed the supported-target CI matrix, making native mmap
  deserialization the only production AOT loading path;
- cross-platform validate the now-default eager PGDATA template overlay;
- validate lazy/generated direct-client array metadata across more type families
  and modes: built-in arrays, runtime enum arrays, runtime domain arrays,
  runtime composite arrays, explicit `refresh_array_types`, transactions,
  row-mode array results, and caller-supplied parser/serializer overrides;
- deepen C-side backend timers further inside the remaining backend-open costs:
  shared-memory initialization, relcache/catcache work, and session
  initialization. The first instrumented-only split now covers
  `InitializeMaxBackends`, `CreateSharedMemoryAndSemaphores`, `InitProcess`,
  `RelationCacheInitializePhase3`, and `initialize_acl`; next use those numbers
  to decide whether the fix belongs in upstream PGlite/Postgres startup or in
  the Rust/WASIX host. Keep an explicit regression guard so extension-template
  opens do not fall back into slow `StartupXLOG` recovery;
- keep server perf visibility first-class for `PgliteServer`, `pglite-proxy`,
  tokio-postgres, SQLx, TCP, and Unix sockets. Server operations now capture
  phases across the listener thread and include an extension-enabled SQLx
  first-query path; extend this to proxy CLI runs;
- remove or mount-compose per-root extension archive install for requested
  extensions. The scalar temporary root is now about 1ms to prepare, but
  extension-enabled server roots still spend about 5-7ms installing requested
  extension assets into the upper root. The fix should be generic by requested
  extension set, not special-cased to vector;
- add an explicit init-profile dimension to the extension-set PGDATA template
  cache key once init options become configurable; the current cache key covers
  the runtime/base-template manifest and sorted extension archive identities;
- targeted catalog/syscache warmup before template or snapshot creation:
  `SELECT 1`, representative prepared/extended query, representative
  `CREATE EXTENSION`, extension type I/O/query smoke, and SQLx/tokio-postgres
  startup query;
- explicit temporary fast settings experiments such as `fsync=off`,
  `synchronous_commit=off`, and reduced WAL durability, while keeping persistent
  databases conservative. Do not regress the PGlite-parity buffer profile:
  `shared_buffers=128MB` and `wal_buffers=4MB` are now startup invariants unless
  a measured, correctness-preserving replacement is proven;
- ensure side-module AOT artifact identity is tied to main runtime identity.

Evaluate cold filesystem, snapshot, and runtime-state levers:

- Wasmer 7.2 alpha filesystem behavior, including MountFS;
  current result: pure mount composition is the default for fresh roots. Core
  runtime assets stay in the shared cached lower runtime, while the upper root
  contains only mutable state, device/tmp files, and requested extension assets.
  Runtime and extension smoke tests now assert that core binaries/catalog files
  are not materialized into the upper root and unrelated extensions are not
  installed;
- eager PGDATA template overlay:
  current result: the default path mounts the cached initialized
  template as the lower `/base` filesystem and materializes only files that
  PostgreSQL opens for mutation. PGDATA preparation is under 1ms locally, down
  from about 187-190ms for full template clone/install;
- PluggableRuntime shared cache behavior where Wasmer exposes it;
- nested MountFS behavior for `/`, `/base`, `/tmp`, `/lib/postgresql`, and
  `/share/postgresql`; note that nested mounts inside a supplied `WasiFsRoot`
  are discarded by `WasiRunner::prepare_webc_env`, so child mounts must be
  passed as runner mounts or represented inside the root filesystem itself;
- keep cross-platform filesystem tests for the default overlay composition
  across direct, persistent, app-id, temporary, proxy, and server roots;
- remove the `PGLITE_OXIDE_MOUNTFS=0` and `PGLITE_OXIDE_PGDATA_OVERLAY=0`
  opt-out flags after the default overlay composition has passed the
  cross-platform filesystem suite. These flags are temporary rollout levers, not
  intended public compatibility surface;
- WASIX journaling, `StoreSnapshot`, or InstaBoot-style restore for temporary
  databases. Current source review shows Wasmer 7.2 has WASIX journal/process
  snapshot APIs, while `StoreSnapshot` captures store globals only; a promoted
  path must prove PGDATA, mount, fd, direct protocol, server, extension, and
  `pg_dump` correctness and materially beat the template/overlay path.
  A removed local spike showed that instance-created restore can pass `SELECT 1`
  but does not skip Postgres backend startup, while backend-ready/protocol-ready
  snapshots took about 5.3s to capture and failed restore with a Wasmer journal
  fd seek replay error (`offset=-1`, `Whence::Cur`). Do not reintroduce runtime
  snapshot plumbing until this is reduced to a small upstream repro or fixed in
  the Wasmer/WASIX journal layer;
- keep Asyncify out of the production artifact unless a specific snapshot or
  journaling path requires an isolated experiment. Production build scripts now
  reject Asyncify flags unless `PGLITE_OXIDE_ALLOW_ASYNCIFY_EXPERIMENT=1` is
  set on an experiment branch;

Evaluate cold compiler and WebAssembly feature levers:

- stay on Wasmer `7.2.0-alpha.2` unless it blocks correctness completely;
- keep LLVM AOT as the release artifact generator with a conservative CPU
  baseline first;
- keep `release-o3` as the default asset profile unless the supported-target CI
  matrix contradicts the local SQL-workload result. The current default compiles
  WASIX C modules with `-O3 -g0 -flto=thin`, links with `-flto=thin`, and lets
  Binaryen run default wasixcc optimization plus
  `--converge:--strip-debug:--strip-producers`;
- keep `release`, `release-o3`, and `release-oz` available as comparison
  profiles. Earlier startup-only local results favored `release-os` over
  `release-oz`, but exact PGlite speed-suite runs now favor `release-o3` for
  the SQL workloads that dominate benchmark parity;
- validate ThinLTO build time and package-size budget on every supported CI
  target. Local macOS arm64 results make it worth keeping, but CI should decide
  whether it needs separate cache tuning or a release-only asset lane;
- evaluate Wasmer LLVM `non_volatile_memops` only as an explicit unsafe
  experiment: Wasmer documents it as faster but not fully WebAssembly-spec
  compliant, so it cannot become the default unless the affected memory model is
  formally justified for this single-process Postgres runtime and the full
  correctness suite passes;
- add Linux perf/perfmap support for symbolized AOT profiling. macOS sampling
  currently stops at Wasmer native `call_sys` frames, which is insufficient for
  proving whether remaining time is executor, btree, heap, WAL, memory, or
  Wasmer-generated code overhead;
- evaluate native CPU tuning only if artifacts remain portable;
- evaluate Cranelift for direct `SELECT 1`, SQL error recovery, representative
  extension create/query, server SQLx smoke, compile speed, and cross-platform
  exception/dynamic-linking behavior;
- evaluate Singlepass only after the same longjmp/error and extension suite
  passes;
- benchmark representative pgvector insert/query/distance workloads with the
  default WASIX toolchain feature baseline. The toolchain already emits
  `-msimd128`, `-mrelaxed-simd`, and `-mextended-const` for the EH+PIC sysroot;
  adding an extra project-level `-msimd128` did not change AOT sizes locally;
- inspect tail calls, extended const expressions, and wide arithmetic use so
  feature usage is consistent across target artifacts;
- evaluate V8, JavaScriptCore, or other non-Wasmer engines only for mobile or
  special embedded targets, checking WASIX, dynamic linking, filesystem,
  exceptions, and headless/AOT packaging implications.

Cold profiling and artifact tooling:

- Wasmer CLI repros for upstream issues: `wasmer run --llvm`,
  `wasmer run --cranelift`, `wasmer compile --llvm`,
  `wasmer compile --cranelift`, `--profiler perfmap`,
  `--compiler-debug-dir`, `--enable-verifier`, `--journal`, `--snapshot-on`,
  and `--stack-size`;
- Rust host profiling with tracing spans, `cargo flamegraph`, Linux `perf`, and
  macOS Instruments;
- artifact gates with `wasm-tools objdump`, Binaryen/section inspection,
  debug/name section checks, `dylink.0` presence, import/export diffing, and size
  regression checks;
- advanced Binaryen `wasm-opt` size/speed passes beyond the default
  converge/strip profile only after correctness is proven without them, one
  pass at a time;
- every failing library-path or dynamic-linking issue should have a minimal CLI
  reproducer when practical.

Cold P1, required for rich extension DX:

- generic extension-set template cache;
- Cranelift correctness/perf matrix;
- SIMD/relaxed-SIMD pgvector benchmarks;
- profiler/perfmap integration;
- `pg_dump` WASIX runner proof;
- smoke-generated extension constants.

Cold P2, high-upside experimental work:

- WASIX journaling or store snapshot restore;
- mobile/runtime alternatives;
- target-specific CPU tuning.

### Hot/Warm Path

Hot/warm path means repeated opens, already-cached startup, steady-state server
behavior, and long-running local-app behavior after the first startup work is
done.

Current hot/warm measurements that still need to be driven down:

- latest local release cache-existing primary visible latencies are roughly:
  runtime preload 16ms, new temporary direct first query 53ms, second new
  temporary direct first query 51ms, direct extension-backed first query 56ms,
  temporary server plus first `tokio-postgres` query 48ms, temporary server plus
  first SQLx query 49ms, temporary server plus first SQLx extension-backed query
  55ms, and existing persistent server SQLx extension-backed first query 43ms;
- warm paths are now dominated by real backend work rather than asset install:
  PostgreSQL backend startup around 23-36ms, `InitPostgres` around 18-21ms,
  `relcache_phase3` around 7-14ms, shared-memory setup around 12ms, and Wasmer
  instance creation around 5-10ms;
- SQLx and `tokio-postgres` first-query server paths are product-critical and
  must stay measured separately from the direct API. The client-side query work
  is now small compared with backend open, but prepared/extended query protocol
  batches still cost a few milliseconds and should be watched;
- repeated long-running server steady-state, extension-heavy steady-state, and
  `pg_dump` steady-state still need explicit release-mode baselines separate
  from first-open benchmarks.

Hot/warm release gates:

- warm temporary direct first query under 50ms locally and under 100ms on GitHub
  Ubuntu after baselines are established;
- warm temporary server plus first SQLx query under 50ms locally and under
  100ms on GitHub Ubuntu after baselines are established;
- warm temporary server plus first extension-backed SQLx query under 60ms
  locally and under 125ms on GitHub Ubuntu after baselines are established;
- steady-state repeated query overhead should stay in the low single-digit
  millisecond range for SQLx/tokio-postgres and below 1ms for direct scalar
  simple operations where PostgreSQL execution itself is trivial;
- no more than 15% regression after the first stable baseline.

Hot/warm implementation and experiments:

- reduce PostgreSQL backend startup without changing semantics: keep drilling
  into `shared_memory`, `InitPostgres`, `relcache_phase3`, database/session
  setup, and any PGlite-specific startup work that differs from regular
  Postgres;
- evaluate safe relcache/catcache/syscache warmup during template creation or
  backend startup so repeated opens do less catalog work, but only if it is a
  normal Postgres-compatible state and does not cache broken process-global
  state;
- avoid repeated AOT decompression/hash work on warm opens; default startup
  should stay on raw/mmap native artifacts with metadata/receipt checks only;
- keep Wasmer instance creation visible and test whether any supported
  engine/runtime reuse can reduce 5-10ms instance cost without leaking Store,
  WASI env, fd, mount, protocol, or database state;
- remove or mount-compose the remaining per-root requested-extension asset
  materialization cost so extension-enabled warm server roots do not pay several
  milliseconds just to expose already-cached immutable side-module files;
- use the new `perf warm` harness to collect and enforce release-mode
  steady-state baselines for long-lived `PgliteServer`: repeated connections,
  repeated SQLx/tokio-postgres prepared queries, transaction batches,
  extension-backed queries, and reconnect after client disconnect;
- extend the direct warm benchmarks from repeated queries and transaction
  batches to prepared query reuse and runtime array type discovery on first
  unknown array type;
- add warm private `pg_dump` benchmarks after the runner is promoted enough to
  measure startup separately from actual dump volume;
- context switching and experimental async APIs only if they improve concurrent
  server mode or shutdown/cancellation without hurting direct single-connection
  latency;
- runtime CPU backoff/idle controls for long-running local app/server use, with
  no background spin and no extra latency on the next query;
- an opt-in process-local backend pool only if reset semantics are stronger than
  users expect and there is no data bleed between tests;
- defer threads until the single-backend path is stable and atomics/shared
  memory do not break dynamic linking or Postgres process-global assumptions;
- keep all hot/warm experiments honest by reporting timing, correctness result,
  state-isolation result, artifact size impact, and implementation risk.

Hot/warm P2, high-upside experimental work:

- context switching/experimental async APIs;
- backend pooling for tests.

## Bucket 2: CI, CD, Release, And Workspace Hygiene

This bucket owns monorepo shape, target coverage, publishing, automation, and
repo quality gates.

Supported first-class targets:

- `aarch64-apple-darwin`;
- `x86_64-apple-darwin`;
- `x86_64-unknown-linux-gnu`;
- `aarch64-unknown-linux-gnu`;
- `x86_64-pc-windows-msvc`.

Experimental targets:

- Linux musl;
- Android;
- iOS through V8/JSC/interpreter paths if feasible;
- RISC-V after Wasmer target support matures.

Asset and AOT CI:

- run `xtask assets release-build` from a clean checkout in CI for every target;
- generate real AOT artifacts for non-local target crates instead of placeholder
  packs;
- asset build matrix with Docker Buildx cache and native AOT runners;
- keep `xtask assets build`, `assets package`, `assets aot`, dynamic-link
  closure checks, manifest validation, and package-size checks coupled in one
  release orchestration command;
- package-size gates for root, asset, and AOT crates;
- package strategy order:
  1. raw AOT artifact if the crate stays under crates.io's compressed limit;
  2. `.zst` compressed artifact with one-time expansion into the persistent
     cache;
  3. deterministic split AOT/asset packs if compression is still too large.

Workspace and monorepo hygiene:

- keep the root `pglite-oxide` crate as the public crate;
- keep asset/AOT crates internal implementation details with exact internal
  dependency versions;
- keep root packages excluding upstream checkouts and production build outputs
  that should not ship;
- move all production build inputs out of `spikes/`;
- prevent production code or `xtask` from depending on `spikes/`;
- keep one active source root: the configured `postgres-pglite`
  `REL_17_5-pglite` branch pinned to the audited commit;
- keep user-facing docs free of implementation backlog/status notes;
- keep [DONE.md](DONE.md) as the only completed-work/status document and this
  file as the only implementation backlog.

Normal CI:

- `cargo nextest`;
- doctests;
- no-default-features checks;
- feature powerset;
- no-legacy-runtime gate for Wasmtime/static-WASI regressions;
- dependency invariant gate blocking `wasmer-compiler-llvm`,
  `wasmer-compiler-cranelift`, `llvm-sys`, and Wasmtime in normal user paths;
- try minimal feature sets for both `wasmer` and `wasmer-wasix` while retaining
  host filesystem mounts, WASIX env/args, networking required by `pg_dump`, and
  dynamic linking;
- account for Wasmer `7.2.0-alpha.2` moving WASIX filesystem internals from
  UnionFS to MountFS, dropping WAMR/Wasmi support, and dropping the distributed
  `x86_64-darwin` target;
- treat macOS multi-module LLVM exception behavior as a separate support gate:
  main module plus at least two side modules, SQL error recovery after each
  load, and normal parallel test scheduling on macOS arm64 and x64;
- actionlint, cargo-deny, and GitHub Actions security audit.

Release and publishing:

- publish dry-runs for every published crate;
- release-plz version group, exact internal dependency versions, one root
  changelog, and Trusted Publishing for every published crate;
- publish internal asset/AOT crates before the root crate when exact internal
  dependency versions require those package names to exist on crates.io;
- keep root package dry-run aware that internal asset/AOT packages must be
  published or dry-run-published first;
- pin security-sensitive GitHub Actions to full commit SHAs.

Reproducible build work:

- record Wasmer crate version, Wasmer CLI/tool version, wasixcc/toolchain
  version, WASIX libc/EH-PIC sysroot identity, LLVM version, postgres-pglite
  commit, pglite-build commit, and extension repository commits;
- use Wasmer reproducible-build controls such as `WASMER_REPRODUCIBLE_BUILD=1`
  where applicable;
- make asset and AOT crate hashes stable enough for audit and cache invalidation.

## Bucket 3: Source, Build Spine, And Asset Provenance

The active source baseline is `electric-sql/postgres-pglite`
`REL_17_5-pglite` at `01792c31a62b7045eb22e93d7dad022bb64b1184`, because that
is the `postgres-pglite` submodule commit used by the audited
`@electric-sql/pglite` 0.4.5 npm release. The older
`REL_17_5_WASM-pglite-builder` branch remains reference material for extension
and `pg_dump` packaging ideas, not the production source spine.
`electric-sql/pglite-build` `portable` remains pinned as build-script
provenance, not as a second runtime source root.

Source-spine work:

- keep the stable branch's integrated PGlite lifecycle and protocol exports:
  `_start`/single-user startup, `pgl_setPGliteActive`, `pgl_startPGlite`,
  `ProcessStartupPacket`, `PostgresMainLoopOnce`, and `PostgresMainLongJmp`;
- critique and document each PGlite adaptation before copying it: `pglitec.c`
  uses libc overrides because browser/wasm hosts do not provide child
  processes, real sockets, Unix user identity, SysV shared memory, or a native
  process-exit boundary; our WASIX bridge should keep only those host ABI
  adaptations that are still necessary under Wasmer;
- keep `pglite-build` and the builder branch as reference inputs for extension
  symbol discovery and packaging, without reintroducing the old `pglite-wasm/*`
  wrapper as production runtime code;
- make the `wasix-dl` export list generated from upstream symbol/import
  discovery instead of hand-maintained;
- package extensions from install deltas and captured imports rather than
  hard-coded paths; reuse the upstream `pack_extension.py` install-delta idea
  without using its non-deterministic archive writer for published crates;
- add manifest fields for extension import lists and core export lists so
  dynamic-link failures are diagnosed before startup;
- add deterministic two-build comparison for identical source pins;
- add negative fixtures proving wrong-core side modules and unresolved imports
  fail during validation, before runtime startup;
- verify `vector`, at least one contrib extension, and `pg_dump` are always
  built from the same configured tree before exposing public APIs.

Upstream audit and lifecycle convergence:

- keep `xtask assets audit-upstream --strict` as the source of truth for newer
  upstream `postgres-pglite` fixes, marking each item as included, explicitly
  replaced by the WASIX architecture, optional, or pending;
- the current required `REL_17_5-pglite` fixes have source-spine ownership:
  real `ProcessStartupPacket` is exported from `backend_startup.c`; startup
  connection data and `ReadyForQuery` come from upstream `pgl_sendConnData()`;
  SQL error recovery uses upstream `PostgresMainLongJmp`; checkpointer,
  active-backend lifecycle state, atexit, timer, identity, dynamic-main, stack,
  and initial memory fixes are tracked by the audit;
- keep the WASIX longjmp bridge intentionally narrower than upstream
  Emscripten's `jmp_buf` content comparison. The maintained rule is pointer
  identity against the exported top-level `postgresmain_sigjmp_buf`; any future
  change must prove it does not catch nested PostgreSQL `PG_TRY` frames or skip
  portal/transaction cleanup;
- keep active-portal abort cleanup in PostgreSQL-owned code for
  `PGLITE_WASIX_DL`. Do not reintroduce Rust-side synthetic `Sync` or portal
  cleanup for simple-query/COPY errors unless a failing upstream regression test
  proves the C lifecycle boundary is insufficient;
- startup identity validation currently happens at the Rust proxy boundary
  before the backend is opened, because the stable PGlite runtime is a single
  local `postgres`/`template1` backend. If multi-database or multi-user support
  is added, move this into a documented config/database lifecycle design instead
  of widening the proxy ad hoc;
- implement a real split WASIX `initdb` runner if fresh runtime initialization
  remains a product requirement. Upstream PGlite does this with a separate
  `initdb.wasm` artifact plus host callbacks that run the backend in
  boot/single-user phases; pglite-oxide currently uses the packaged PGDATA
  template for new roots and should not resurrect the old embedded
  `pgl_initdb` wrapper;
- still audit/cherry-pick or intentionally reject remaining upstream/runtime
  items before claiming source-spine completeness: background-worker disable
  semantics, artifact cache fixes, data-directory locking deltas, startup
  `postgresConfig`, and `pgoutput` symbol exports;
- decide whether proxy/frontend startup should eventually stop fabricating
  startup responses in Rust and converge further toward the upstream
  `interactive_one`/`ProcessStartupPacket` lifecycle for every client
  connection;
- keep config changes flowing through a proper config API or pinned
  `postgresConfig` surface, not ad hoc startup mutation.

Canonical assets:

- keep timezone data generated by `zic` inside the pinned build image from
  PostgreSQL `tzdata.zi`, never from a maintainer host;
- generate PGDATA with the desired timezone instead of patching extracted config
  text;
- keep runtime prefix files packaged from the pinned configured tree, including
  timezone files, extension SQL/control files, and installed support libraries;
- keep asset manifests tied to source commits, Docker image digest, Wasmer
  version, engine identity, source module hashes, import/export sets, archive
  hashes, and package sizes.

## Bucket 4: Runtime Correctness And Protocol

Runtime correctness work:

- add larger PostgreSQL regression subsets for datatypes, DDL, transactions,
  planner/index behavior, and direct blob COPY;
- add broader raw wire-protocol/fuzz coverage around extended query sequencing;
- keep the export guard requiring `PostgresMainLongJmp`,
  `PostgresSendReadyForQueryIfNecessary`, `pgl_pq_flush`, and the WASIX
  input/output symbols;
- if a future Wasmer version resumes the C `sigsetjmp` boundary directly, keep
  the explicit recovery export as a tested no-op fallback until tests prove it
  can be removed;
- keep the guard that treats a missing `ParseComplete` as an error on successful
  Parse paths;
- keep the production patch free of `pglite-wasm/*`; any future frontend/initdb
  stubs must be justified by link-symbol analysis against the stable branch,
  not inherited from the builder wrapper;
- add a C/link audit showing whether any WASIX `popen()` replacement remains
  necessary once initdb is handled through the upstream-style separate module;
- add integration coverage for less common Postgres wait/socket paths as future
  extension smoke tests discover them;
- keep interrupted-PGDATA and root-locking tests as the owned coverage for
  failed opens. Do not add a fake child-process kill model unless the runtime
  grows a real child-process boundary.

Server-mode streaming `COPY FROM STDIN` remains unsupported by design. The
current WASIX protocol boundary steps the backend through call/return buffers,
while streaming COPY needs a transport that can yield after `CopyInResponse` and
resume inside COPY state as `CopyData` arrives. Until that transport exists,
server mode should reject streaming COPY with SQLSTATE `0A000` and leave the
connection usable.

## Bucket 5: Extensions And `pg_dump`

Extension catalog generation should merge:

- PGlite extension catalog and REPL exports;
- `postgres-pglite/pglite/other_extensions`;
- supported PostgreSQL contrib directories;
- pinned external repositories such as pgvector, pgtap, pg_uuidv7, pg_hashids,
  pg_ivm, AGE, PostGIS, and pg_textsearch.

Promotion order:

1. `vector`;
2. `pg_trgm`;
3. `hstore`;
4. `pgcrypto`;
5. one representative contrib extension;
6. `pgtap`;
7. `pg_uuidv7`;
8. `pg_hashids`;
9. `pg_ivm`;
10. `age`;
11. `pg_textsearch`;
12. PostGIS after size, dependency, and load-order proof.

Rules:

- broaden extension generation and smoke tests beyond `vector` and `pg_trgm`;
- generate public constants only after smoke tests pass;
- keep PGlite `live` out of SQL extension constants until there is a
  Rust-native live-query API;
- keep `extensions::ALL` limited to extensions passing for the current asset
  set;
- classify every extension as normal `CREATE EXTENSION`, preload-required,
  startup-config-required, native dependency/load-order-required, or not a SQL
  extension;
- add manifest fields for `requires_preload`, `postgres_config`,
  `shared_memory`, `restart_required`, `dependencies`, and `load_order`;
- prove preload-required extensions such as `pg_stat_statements` apply
  `shared_preload_libraries` before backend startup;
- add a small public config API only if extension metadata proves it is needed;
- ensure no unrequested extension files are copied into instance roots;
- make extension dependency errors fail at manifest generation time where
  possible;
- add extension load-order and missing native dependency failure tests;
- add preload/startup-config extension tests before exposing extensions that
  require postmaster-time configuration;
- add extension lifecycle negative tests for missing side modules, wrong core
  runtime, missing SQL/control files, repeated enable, and reopen after install.

`pg_dump` work:

- promote the private `pg_dump` runner to public API/CLI only after public
  dump/restore tests pass;
- expose `PgDumpOptions`, `Pglite::dump_sql`, `Pglite::dump_bytes`, and a real
  `pglite-dump` CLI only after public dump/restore tests use the packaged
  WASIX `pg_dump` module.

## Bucket 6: Examples And Ecosystem Tests

Examples and CI:

- examples and CI for SQLx, `tokio-postgres`, rstest, Diesel, SeaORM, Tauri,
  pgvector local RAG, Python/psycopg, Go/pgx, and Node `pg`;
- add Python, Go, and Node proxy examples that verify SQLSTATE preservation and
  recovery behavior through ordinary client libraries.

Required test categories:

- direct `SELECT 1`, persistence, restart, temporary template cache, and
  persistent root locks;
- SQLx and `tokio-postgres` server connections;
- SSLRequest, CancelRequest, Parse/Bind/Execute error recovery, and pipelined
  extended queries;
- vector create/insert/query/distance through direct API and server mode;
- generated extension smoke suite;
- unsafe archive rejection and canonical path validation;
- manifest SHA validation and AOT source-module hash verification;
- unsupported target errors;
- macOS multi-module exception recovery;
- private then public dump/restore;
- Python, Go, and Node proxy tests;
- package size checks and publish dry-runs.

## Bucket 7: Foundation Completion And Decision Policy

Keep this checklist until every source/build and correctness item has a
repo-visible implementation or explicit rejection:

- move all production build inputs out of `spikes/`;
- close the required upstream audit;
- make `xtask assets build` the only production build path;
- replace hard-coded artifact paths with build metadata;
- generate import/export and memory metadata;
- prove deterministic packaging;
- keep the canonical runtime layout final;
- classify and reduce C portability code;
- prove direct API correctness;
- prove server protocol correctness;
- prove root locking and interrupted initdb recovery;
- prove extension correctness;
- prove private then public `pg_dump` correctness;
- reject asset mixing through negative tests;
- prove the same matrix across every supported target.

Every runtime-affecting experiment must end in one of these repo-visible states:

- `promoted`: implementation is on the production path;
- `blocked`: evidence and blocker are documented;
- `rejected`: reason and alternative are documented.

Do not leave runtime-affecting experiments as loose notes.

## Reference Material To Recheck

- Wasmer 7 announcement and runtime feature docs;
- Wasmer 7.2 alpha release notes;
- Wasmer WASIX dynamic-linking docs;
- Wasmer WordPress/WebAssembly case study;
- Wasmer InstaBoot documentation;
- Wasmer macOS multi-module LLVM exception issue;
- Wasmer embedded/iOS tracking issue;
- Wasmer Rust API docs;
- PGlite extension docs and extension-development docs;
- `postgres-pglite` `REL_17_5-pglite` and the historical
  `REL_17_5_WASM-pglite-builder` reference branch;
- `pglite-build` `portable`;
- PGlite data-directory locking, startup config, and `pgoutput` upstream PRs.
