# Done

This is the single status document for implementation work already completed.
It records what exists so user-facing docs do not need internal notes.

## Runtime Direction

The repository now has one production direction: WASIX dynamic linking plus
headless Wasmer loading of CI-produced LLVM AOT artifacts.

Removed or excluded from the production path:

- Wasmtime/static-WASI runtime path;
- Emscripten/JavaScript glue runtime path;
- user-side Docker, LLVM, Cranelift, or local Postgres compilation;
- duplicated runtime layouts and host-side timezone/path rewrite shims.

`spikes/` remains historical evidence only. Production build inputs now live
under `assets/`.

## Workspace And Asset Crates

Implemented:

- root `pglite-oxide` crate remains the public crate;
- `pglite-oxide-assets` holds packaged runtime assets;
- target AOT crates exist under `crates/aot/*`;
- `xtask` owns source checks, build orchestration, packaging, manifest checks,
  package sizing, upstream audits, and source-spine validation;
- upstream checkouts moved to `assets/checkouts`;
- source pins live in `assets/sources.toml`;
- root packages exclude upstream checkouts from published crates.

Current local asset set:

- portable PGlite WASIX runtime archive;
- `pg_dump.wasix.wasm`;
- deterministic `.tar.zst` archives for `vector` and `pg_trgm`;
- prepopulated PGDATA template archive;
- macOS arm64 Wasmer LLVM AOT artifacts for runtime, runtime support modules,
  `vector`, `pg_trgm`, and `pg_dump`;
- placeholder AOT crates for other targets until their native CI artifacts are
  generated.

## Source And Build Spine

Implemented:

- active source baseline switched to `electric-sql/postgres-pglite`
  `REL_17_5-pglite` at `01792c31a62b7045eb22e93d7dad022bb64b1184`, matching
  the audited `@electric-sql/pglite` 0.4.5 source/artifact pair;
- `pglite-build` `portable` is pinned as build-script provenance;
- maintained WASIX build files live under `assets/wasix-build`;
- `xtask assets build --execute` can produce the main runtime, support modules,
  `vector`, `pg_trgm`, and `pg_dump` for the local target;
- `xtask assets package` emits deterministic archives, generated manifests, and
  crate assets;
- `xtask assets aot` regenerates local Wasmer LLVM AOT artifacts;
- `xtask assets check --strict-generated` validates generated metadata;
- `xtask assets source-spine --check-patch-applies` validates the maintained
  source patch and C ABI harness;
- `xtask assets audit-upstream --strict` records upstream fix decisions;
- required upstream fixes from `REL_17_5-pglite` are now the active source
  spine rather than comparison material. The WASIX patch keeps dynamic-main and
  side-module support, C startup timers, and explicit exports for the stable
  branch lifecycle while reusing upstream `pgl_startPGlite`,
  `pgl_setPGliteActive`, `ProcessStartupPacket`, `PostgresMainLoopOnce`, and
  `PostgresMainLongJmp`;
- source-spine review conclusion: upstream PGlite's libc/host adaptations are
  purposeful for wasm hosts, not arbitrary shortcuts. `pglitec.c` supplies
  stable `postgres` identity, explicit process-active state, manual top-level
  longjmp recovery, socket callbacks, shared-memory emulation, and explicit
  atexit replay because browser/Emscripten cannot provide normal Postgres
  child processes, sockets, Unix users, SysV shared memory, or a native process
  lifecycle. The WASIX bridge keeps the same architectural contracts where
  Wasmer still needs host assistance, but uses Rust-owned input/output buffers
  instead of Emscripten callback pointers because the Rust host does not have
  Emscripten's JS table callback mechanism;
- WASIX-specific deviation from upstream PGlite: top-level Postgres longjmp
  detection uses `jmp_buf` pointer identity instead of upstream's buffer-content
  `memcmp`. The memcmp test is acceptable in the Emscripten artifact it was
  written for, but under Wasmer/WASIX it misclassified nested PostgreSQL
  `PG_TRY` handlers and skipped normal portal cleanup. Pointer identity keeps
  the host escape hatch scoped to the single exported top-level recovery buffer;
- WASIX-specific PostgreSQL fix: active portal abort cleanup is owned in
  `AtAbort_Portals` for `PGLITE_WASIX_DL`, not in Rust. This keeps simple-query
  and COPY error recovery at the PostgreSQL portal lifecycle boundary and avoids
  fabricating cleanup behavior in the wire proxy;
- stable branch behavior note: startup `ParameterStatus` messages may be emitted
  on raw protocol paths before `ReadyForQuery`. Tests now allow those legal
  PostgreSQL messages instead of assuming the older minimal message sequence;
- new roots are now created through the packaged PGDATA template path. The old
  embedded-backend `pgl_initdb` path was removed with the builder wrapper, and
  `fresh_temporary()` now reports that the split WASIX `initdb` runner is not
  implemented instead of creating an empty PGDATA directory and failing later;
- the old builder-branch `pglite-wasm/*` runtime wrapper is no longer the
  production patch target. It remains historical/reference material only;
- `xtask package-size --enforce` passes locally for the root, asset, and macOS
  arm64 AOT crates.

Parity verified against upstream PGlite stable source and TypeScript host:

- startup/initdb: upstream TypeScript creates a cluster with `initdb.wasm`,
  dumps PGDATA, loads that tarball into the main runtime, calls
  `_pgl_setPGliteActive(1)`, runs `callMain([...startParams, -D, PGDATA,
  PGDATABASE])`, expects exit `99`, then calls `_pgl_startPGlite()`.
  pglite-oxide matches the main-runtime lifecycle from `_pgl_setPGliteActive`
  onward and deliberately consumes a packaged PGDATA template instead of
  exposing split runtime `initdb` yet. That is an explicit product gap, not a
  hidden fallback;
- startup packet: upstream calls `_pgl_getMyProcPort()`,
  `_ProcessStartupPacket(...)`, `_pgl_sendConnData()`, and `_pgl_pq_flush()`.
  pglite-oxide uses the same C exports and keeps Rust-side startup identity
  rejection before opening a backend because the current runtime has one local
  `postgres`/`template1` identity;
- query loop: upstream feeds the whole frontend message buffer, repeatedly calls
  `_PostgresMainLoopOnce()` while frontend bytes or libpq buffered data remain,
  catches status `100`, calls `_PostgresMainLongJmp()`, then always calls
  `_PostgresSendReadyForQueryIfNecessary()` and `_pgl_pq_flush()`. The Rust host
  now follows that control flow with Rust-owned input/output buffers instead of
  Emscripten callback pointers;
- close: upstream clears active state, sends protocol terminate, and replays
  `_pgl_run_atexit_funcs()`. The Rust host clears active state and replays
  atexit on shutdown, while tests cover clean restart, root locking, and stale
  runtime-state cleanup;
- host ABI: upstream `pglitec.c` emulates sockets, identity, shared memory,
  `system`/`popen`, timers, longjmp, and atexit because browser/Emscripten does
  not provide normal process or OS services. pglite-oxide keeps the same
  categories only where WASIX still needs host assistance, and the ABI harness
  tests stable identity, fail-closed `system`, protocol fd bridging, shared
  memory, atexit replay, mmap, and libpq encoding aliases;
- justified deviations: WASIX longjmp detection uses pointer identity instead of
  upstream's `jmp_buf` content `memcmp`; simple-query/COPY portal abort cleanup
  is owned in PostgreSQL `AtAbort_Portals`; startup `ParameterStatus` messages
  are accepted as legal protocol output; fresh initdb is held for the split
  WASIX `initdb` runner rather than resurrecting the old builder wrapper.

## Runtime Behavior

Implemented:

- runtime loads verified headless Wasmer AOT artifacts;
- AOT artifacts record source module hash, Wasmer version, and engine identity;
- runtime verifies asset and archive hashes before use;
- unsupported targets return a clear missing-AOT-artifact error instead of
  compiling locally;
- `Pglite::preload()` and `Pglite::preload_extensions(...)` exist;
- `Pglite::preload()` now warms the persistent runtime cache, headless Wasmer
  engine, main AOT module, shared WASIX runtime, and runtime side modules;
- `Pglite::preload_extensions(...)` warms requested extension artifacts and
  side-module cache entries generically;
- direct, persistent, app-id, proxy, server, and temporary roots now share the
  same root-preparation pipeline;
- roots can install immutable runtime files from a persistent runtime cache and
  install the embedded PGDATA template without rebuilding initdb;
- mutable PGDATA template files are copied or archive-installed, never
  hardlinked; immutable runtime files hardlink from cache when possible;
- persistent roots use lock files to prevent concurrent direct/server opens;
- runtime and extension archive extraction rejects unsafe paths, symlinks,
  hardlinks, device nodes, and unsupported archive entry types;
- runtime uses canonical Postgres paths:
  `/bin`, `/lib/postgresql`, `/share/postgresql/extension`, and
  `/share/postgresql/timezonesets`.

## Public API Surface

Implemented:

- `PgliteBuilder::extension`;
- `PgliteBuilder::extensions`;
- `Pglite::enable_extension`;
- `Pglite::preload`;
- `Pglite::preload_extensions`;
- `PgliteServerBuilder::extension`;
- `PgliteServerBuilder::extensions`;
- `PgliteServer::database_url`;
- extension constants `extensions::VECTOR`, `extensions::PG_TRGM`, and
  `extensions::ALL`.

`pglite-dump` no longer exposes the old archive-unpack behavior. The real
`pg_dump` runner exists privately in tests but is not yet public API.

## Protocol And Server Correctness

Implemented coverage:

- direct Rust API open/init/query;
- persistence, close/reopen, stale runtime-state cleanup, interrupted PGDATA
  cleanup, and root-lock conflicts;
- SQLx and `tokio-postgres` local-server connections;
- SSLRequest no-SSL response;
- CancelRequest safe close;
- Parse, Bind, and Execute error recovery;
- SQLSTATE preservation for syntax, missing relation, invalid typed parameter,
  wrong parameter count, and extension-originated errors;
- extended-query `ReadyForQuery` synchronization;
- successful pipelined extended queries;
- mixed success/error/success pipelined queries;
- explicit prepared-statement reuse;
- transaction error recovery through rollback;
- client disconnect during an extended-query exchange;
- partial TCP reads and pipelined simple queries;
- server-mode `COPY FROM STDIN` fails closed with SQLSTATE `0A000` and recovers.

## Extensions And `pg_dump`

Implemented coverage:

- `vector` direct API load, `CREATE EXTENSION`, insert, distance query, and
  pgvector type cases;
- `vector` through `PgliteServer` and SQLx;
- SQLx recovery after vector-originated errors;
- demand-driven extension install and idempotent `enable_extension`;
- installed extension side modules are seeded into the headless Wasmer cache on
  reopen;
- `pg_trgm` direct API and SQLx server smoke coverage;
- extension archive hash mismatch rejection;
- private WASIX `pg_dump` runner loads through the AOT manifest, connects to
  `PgliteServer`, dumps plain SQL, restores into fresh `Pglite`, and verifies
  schema/data;
- private `pg_dump` coverage includes indexes, views, sequences,
  `--schema-only`, `--quote-all-identifiers`, source-server reuse after dump,
  and vector extension dump/restore.

## WASIX C Boundary Ownership

The remaining C-side differences are owned as WASIX portability and host ABI,
not hidden generic stubs:

- `pg_proto.c` manually coordinates `ReadyForQuery` for the current
  call/return protocol loop and is covered by SQLx, `tokio-postgres`, and raw
  wire-protocol tests;
- `pg_main.c` drives initdb boot/single-user phases inside one embedded process,
  with named helpers for boot, stdin restoration, and single-user replay;
- `pgl_os.h` emulates only the expected initdb boot/single `popen()` commands
  under `PGLITE_WASIX_DL` and fails closed otherwise;
- `pgl_stubs.h` is gated to `PGLITE_WASIX_DL`, and future removals are driven by
  link-symbol analysis;
- `pglite_wasix_bridge.c` owns locale command emulation, stable `postgres`
  uid/passwd identity, protocol socket buffers, fail-closed `system()`, selected
  fd/socket delegation to WASIX libc, and single-process SysV shared memory.

The source-spine guard checks for removed spike smells: debug-only `#pragma`
markers, diagnostic `popen`, broad socket fake-success behavior, layout
mirroring, timezone rewrites, and generic stub logging.

## Validation Already Run

The following local gates passed before this consolidation:

```sh
cargo fmt --check
cargo check -p pglite-oxide --all-targets
cargo check -p pglite-oxide --no-default-features --all-targets
cargo run -p xtask -- assets check --strict-generated
cargo run -p xtask -- assets source-spine --check-patch-applies
cargo run -p xtask -- assets audit-upstream --strict
cargo run -p xtask -- package-size --enforce
cargo test --test client_compat
cargo test --test runtime_smoke
cargo test --test extensions_smoke
```

The private `pg_dump` round-trip tests and asset/AOT hash-mismatch tests also
passed locally.

## Cold-Start Performance Work

Implemented:

- internal phase timing via `capture_phase_timings`;
- `cargo run -p xtask -- perf cold` emits structured JSON with explicit
  `cacheStateBefore`, `processStateBefore`, `rootState`, `queryState`, and
  `workload` fields, so first-install bootstrap, process warmup, new-root first
  query, and client/server first query are no longer conflated;
- `cargo run -p xtask -- perf cold --reset-cache` removes the pglite-oxide cache
  before measuring, making runtime extraction, AOT materialization, PGDATA
  template install, and extension-template creation visible in the first
  operation that pays each cost;
- process-wide headless Wasmer engine cache;
- process-wide AOT `Module` cache keyed by artifact hash;
- AOT manifests now include raw artifact SHA256/size metadata; the default
  startup path uses an atomic cache receipt and file metadata instead of scanning
  the raw AOT file;
- bundled runtime, extension, PGDATA-template, and AOT content hashes are kept
  off the default startup path and are only scanned with
  `PGLITE_OXIDE_AOT_VERIFY=full`;
- process-wide shared Tokio runtime, WASIX runtime, and `SharedCache`;
- side-module seeding is reused by module hash;
- phase timing now propagates into the server listener thread, so
  `PgliteServer` cold runs report root preparation, listener bind/spawn,
  proxy backend open, client connect, first query, and shutdown phases instead
  of a single opaque total;
- server accept loops now use blocking `accept()` plus an explicit wake
  connection during shutdown, removing the previous nonblocking accept plus
  10ms sleep polling jitter;
- fresh proxy backend initialization no longer runs the post-client
  `ROLLBACK`/`DISCARD ALL` cleanup path. Fresh startup applies default GUCs
  directly; full reset remains in place after client disconnects;
- persistent runtime asset cache under the platform cache directory;
- runtime-cache repair removes mutable scratch state and restores required
  support files before the cache is used as a shared overlay source;
- per-root runtime scratch directories are reset during root preparation;
- `password` is copied as per-root mutable support data instead of hardlinked
  from the shared runtime cache;
- PGDATA template manifests are parsed without archive hashing on the default
  path;
- the parsed generated asset manifest is cached process-wide, avoiding repeated
  1.4 MB JSON parses during AOT, extension, and PGDATA template checks;
- an eager PGDATA template overlay is implemented behind
  `PGLITE_OXIDE_PGDATA_OVERLAY=1`: the cached initialized template is mounted
  as lower `/base`, the per-instance upper starts almost empty, and individual
  template files are copied into the upper only before mutating opens;
- the eager PGDATA overlay is passed as a runner-level WASIX mount. Nested
  mounts placed inside the supplied `WasiFsRoot` were not sufficient because
  `WasiRunner::prepare_webc_env` rebuilds the final mount tree from the root
  `/` filesystem plus runner-owned mounts;
- direct `Pglite::open` no longer performs a separate session-setup round trip
  and no longer folds session defaults into array discovery SQL. The Rust WASIX
  host now calls the real C `ProcessStartupPacket` export from
  `backend_startup.c`; C `pgl_sendConnData()` applies the direct-session
  defaults before connection data is sent, so `BeginReportingGUCOptions`
  observes `TimeZone=UTC` and `search_path=public`;
- direct scalar open/query paths no longer scan `pg_type` for array metadata.
  Built-in PostgreSQL array OIDs are registered statically in the Rust direct
  client, and runtime-created enum/domain/composite arrays are discovered
  lazily from parameter/result OIDs or through explicit
  `refresh_array_types()` calls;
- the old `pgl_stubs.h` `ProcessStartupPacket` placeholder has been removed
  from the maintained WASIX patch. Startup packet parsing now lives in
  PostgreSQL's `backend_startup.c`, and the host no longer calls a separate
  Rust-side default-GUC helper;
- focused tests cover process AOT cache reuse, extension preload reuse,
  cross-instance state isolation, mutable PGDATA clone safety, eager PGDATA
  lower-file visibility, direct runtime smoke, vector direct/server smoke, and
  proxy smoke.

Previous local debug `xtask perf cold` run after explicit preload:

- explicit preload: about 605ms;
- temporary first query: about 553ms;
- warm temporary first query: about 547ms;
- representative extension-backed first query after extension preload: about
  646ms;
- server plus first `tokio-postgres` query: about 543ms.

In that run bundled archive/module SHA scans were absent from the default path.
The remaining visible costs were main Wasmer deserialization at about 447ms and
temporary filesystem setup at about 321ms, mostly runtime clone plus PGDATA
template clone.

Latest local debug `PGLITE_OXIDE_MOUNTFS=1 cargo run -p xtask -- perf cold`
run after the shared root-preparation work:

- explicit preload: about 640ms;
- temporary first query: about 404ms;
- warm temporary first query: about 386ms;
- representative extension-backed first query after extension preload: about
  504ms;
- server plus first `tokio-postgres` query: about 371ms.

That run removed the full immutable runtime clone from temporary opens. The
same prepared runtime-layout machinery now feeds direct, persistent, app-id,
proxy, and server roots as well. Per-root runtime setup was about 30ms and
`wasix.mountfs_overlay_construct` was under 1ms at that point. The dominant
remaining setup cost was PGDATA template clone/install at about 187-190ms,
followed by
backend start around 44-48ms and Wasmer instance creation around 30-36ms.

Latest local debug
`PGLITE_OXIDE_MOUNTFS=1 PGLITE_OXIDE_PGDATA_OVERLAY=1 cargo run -p xtask -- perf cold`
run after the eager PGDATA overlay and parsed-manifest cache:

- explicit preload: about 601ms;
- temporary first query: about 191ms;
- warm temporary first query: about 144ms;
- representative extension-backed first query after extension preload: about
  257ms;
- server plus first `tokio-postgres` query: about 123ms.

In that run `pgdata.overlay_prepare` was about 0.4-0.5ms, down from the
previous 187-190ms template clone/install cost. The visible per-open costs are now
Wasmer instance creation around 30-37ms and PostgreSQL backend start around
49-52ms. Main-module AOT deserialization remains the dominant explicit preload
cost at about 506ms on this local debug profile.

Historical local debug run after removing the separate direct session-setup
round trip, before lazy/generated array metadata:

- explicit preload: about 535ms;
- temporary first query: about 230ms;
- warm temporary first query: about 133ms;
- representative extension-backed first query after extension preload: about
  254ms;
- server plus first `tokio-postgres` query: about 118ms.

The warm direct `pglite.open` phase dropped to about 112ms. At that point the
remaining direct-open client-side cost was the array catalog scan, about 30ms
for the warm catalog query and less than 1ms for Rust-side parser/serializer
registration. Scalar paths no longer pay that scan after lazy/generated array
metadata.

Latest local release work:

- asset release builds now default to `release-o3`, which compiles WASIX C
  modules with `-O3 -g0 -flto=thin` and links with `-flto=thin`;
- release profiles run wasixcc's default Binaryen optimization plus
  `--converge`, `--strip-debug`, and `--strip-producers`;
- the current exact PGlite speed-suite run favors `release-o3 + converge/strip`
  plus ThinLTO for SQL workload parity. The package-size gate still passes
  locally with the macOS arm64 AOT crate at about 7.2MiB compressed and the
  asset crate at about 5.6MiB compressed. Earlier startup-only runs favored
  `release-os` over `release-oz`, and adding a project `-msimd128` flag was
  redundant because the WASIX EH+PIC sysroot already invokes clang with SIMD,
  relaxed SIMD, and extended const enabled;
- exact PGlite speed-suite comparison now has its own harness and diagnostic
  path. The latest ThinLTO `release-o3` direct run on macOS arm64 measured test
  9 at about 569ms, test 10 at about 724ms, test 11 at about 98ms, and test 14
  at about 77ms. Against the locally audited npm NodeFS reference, the direct
  suite is about 1.22x faster geomean, with 16/18 wins but not a 10x-class
  result under identical SQL/Postgres semantics;
- selected speed-case diagnostics show that host filesystem work is not the
  remaining dominant cost on the heavy SQL cases. Test 10, for example, was
  about 748ms total with about 21ms in traced filesystem work and about 743ms
  inside PostgreSQL/AOT dispatch. This points the next investigation at
  symbolized AOT/Postgres executor profiling, not more Rust result parsing or
  root-layout tuning;
- an unsafe Wasmer LLVM `non_volatile_memops` experiment was tested through the
  AOT serializer and then removed from packaged artifacts. It improved the
  direct speed-suite geomean by only about 5%, had noisy server regressions, and
  Wasmer documents that mode as not fully WebAssembly-spec compliant;
- PostgreSQL spinlocks are enabled in the WASIX build. The earlier
  `--disable-spinlocks` fallback is gone, and the source-spine guard rejects it
  if it returns. This is a correctness/architecture baseline because wasixcc
  exposes the required atomic operations; local single-backend speed numbers are
  mixed enough that it should not be treated as a standalone benchmark win;
- the shared runtime overlay and eager PGDATA overlay are now default-on, with
  `PGLITE_OXIDE_MOUNTFS=0` and `PGLITE_OXIDE_PGDATA_OVERLAY=0` as opt-outs;
- local release `cargo run -p xtask -- perf cold` with no env overrides showed
  warmed preload around 18ms, temporary first query around 100ms, warm temporary
  first query around 83ms, representative extension-backed first query around
  148ms after extension preload, and server first query around 77ms;
- that run predated lazy/generated array metadata and showed direct open
  dominated by backend startup around 33-40ms plus the old array catalog scan
  around 24-33ms. Scalar paths no longer pay that catalog scan; new release
  numbers should replace this historical baseline;
- after adding deeper preload instrumentation, local release runs showed
  explicit preload between about 15ms and 56ms depending on OS cache warmth.
  The first uncached visible run spent about 37ms in main AOT mmap
  deserialization and about 10ms in runtime cache setup; repeated warmed runs
  spent about 10ms in main AOT deserialization for both mmap and file modes;
- Wasmer AOT loading now defaults to the native mmapped-file deserializer, with
  `PGLITE_OXIDE_AOT_DESERIALIZE=file` kept as a diagnostic comparison path;
- after static built-in arrays and lazy runtime array discovery, local release
  `cargo run --release -p xtask -- perf cold` showed explicit preload about
  52ms, temporary first query about 88ms, warm temporary first query about 79ms,
  representative extension-backed first query about 131ms after extension
  preload, and server first query about 75ms. Scalar direct paths did not emit
  the `pglite.array_type_catalog_query` phase;
- after server-thread timing and accept-loop cleanup, local release
  `cargo run --release -p xtask -- perf cold` showed explicit preload about
  19-22ms, temporary first query about 86-89ms, warm temporary first query about
  77ms, representative extension-backed first query about 132-140ms after
  extension preload, tokio-postgres server first query about 68ms, and SQLx
  server first query about 68-70ms. The server path now shows `server.start`
  around 52-54ms,
  `proxy.backend_open` around 44-46ms, `postgres.backend_start` around 35-37ms,
  tokio-postgres connect around 0.6ms/query around 5.5ms, and SQLx connect
  around 2.1ms/query around 6.0ms;
- `xtask perf cold` includes the extension-enabled SQLx server path, now named
  `process_warm_new_temp_server_sqlx_vector_first_query`, which starts
  `PgliteServer` with a requested bundled extension and measures a first
  extension-backed SQLx query for a new temporary server root. This keeps
  server-mode extension install/load, `CREATE EXTENSION`, client connect, and
  first extension query visible as one product-shaped path. The first local
  release run measured about 175ms total, dominated by `proxy.extension_enable`
  around 107ms; SQLx connect and the
  first vector query were both sub-millisecond on that run;
- cold perf reporting now breaks out preload runtime cache setup, AOT install,
  mmap/file deserialization, WASIX runtime construction, instance creation,
  startup-packet/default-GUC work, client protocol round trips, extension side
  module seeding, and private `pg_dump` runner phases;
- instrumented WASIX runtime artifacts can export C-side backend startup timers
  via `pgl_backend_timing_elapsed_us`, and the Rust host records them as
  `postgres.backend.c.*` phases when the export is present. Production WASIX
  artifacts keep `PGLITE_OXIDE_WASIX_BACKEND_TIMING=0`, so the C timing macros
  compile away and the export is absent. Local release instrumented runs show
  backend startup split mainly between `postgres.backend.c.shared_memory` around
  11-12ms and `postgres.backend.c.init_postgres` around 19-21ms, inside
  `postgres.backend.c.async_single_user_main` around 33-36ms;
- C-side timers now reach inside `InitPostgres`: `StartupXLOG`,
  relcache/catcache initialization, transaction snapshot, session-user setup,
  database lookup/recheck/path validation, `CheckMyDatabase`, startup option
  processing, session initialization, and session preload libraries are reported
  as individual `postgres.backend.c.*` phases;
- the C timing ABI has additional instrumented-only IDs for
  `InitializeMaxBackends`, `CreateSharedMemoryAndSemaphores`, `InitProcess`,
  `RelationCacheInitializePhase3`, and `initialize_acl`, so the two remaining
  startup hotspots can be subdivided without adding production clock reads;
- a generic extension-set PGDATA template cache now builds templates through
  normal `CREATE EXTENSION`, runs `CHECKPOINT`, then closes the embedded backend
  through the runtime `pgl_shutdown` export before caching the template. The
  cache is keyed by the base runtime/template manifest plus sorted extension
  archive identities and is mounted as the lower PGDATA template for direct and
  server temporary roots;
- direct and server extension paths skip redundant `CREATE EXTENSION` when the
  requested extension set is already present in the cached template, while still
  installing/preloading side-module assets into each instance root;
- extension-template cache keys were bumped to version 2 after adding clean
  backend shutdown, so older templates that left `pg_control` in a
  recovery-heavy state are ignored;
- current local release timings with the clean generic extension template cache
  show extension-template lookup/overlay under 1ms, extension archive install
  around 5ms, and extension-enabled `StartupXLOG` around 3-4ms instead of the
  previous roughly 350ms recovery path. In the steady cached run, the direct
  vector first-query path for a new temporary root was about 82-93ms and the
  SQLx vector first-query path for a new temporary server root was about
  74-78ms;
- pure MountFS runtime composition now keeps core runtime assets in the shared
  cached lower runtime and materializes only mutable state plus requested
  extension assets in the per-root upper layer. Runtime and extension smoke
  tests assert that core binaries/catalog files are not copied into the upper
  root and unrelated extensions are not installed. Local release comparison
  showed per-root runtime setup dropping from roughly 7ms to about 0.6-0.9ms,
  the SQLx first-query path for a new temporary server root around 55ms, and
  the SQLx vector first-query path for a new temporary server root around 66ms
  after cache cleanup;
- cold perf operations now report `primaryLatencyPhase` and
  `primaryLatencyMicros` so user-visible latency is separated from teardown.
  The deeper local release run showed direct first-query totals were previously
  inflated by a Rust-side host directory sync during query finish;
- direct `Pglite` no longer calls host directory `sync_all` after every
  non-transaction query. PostgreSQL's WAL/fsync path owns durability, and the
  server path already avoided this extra host sync. In the local release run,
  direct visible latency dropped from about 68ms to about 53ms for the first
  new temporary root and to about 45ms for the second new temporary root;
- direct and server protocol timing now splits startup packet handling,
  protocol input/output, guest `PostgresMainLoopOnce`, direct parse/describe,
  direct execute, and direct result finish. The remaining first-query protocol
  cost is mostly PostgreSQL main-loop work for the parse/describe or prepared
  extended-query batch, not Rust parsing or buffer copies;
- `cargo run -p xtask -- perf warm` now measures true warm behavior separately
  from first-open work: repeated direct scalar queries, direct transaction
  batches, direct extension-backed queries, SQLx repeated queries over one
  connection, SQLx repeated connect-query-close cycles, SQLx extension-backed
  repeated queries, and tokio-postgres repeated queries. It reports total and
  per-iteration average phases while keeping open/shutdown phases as context;
- `cargo run --release -p xtask -- perf bench` now provides a product-style
  benchmark harness similar to PGlite's published benchmark families. It runs
  trimmed-average CRUD round-trip benchmarks and a generated SQLite
  speedtest-style suite through both the direct Rust API and `PgliteServer`
  with a long-lived SQLx connection. The speed suite is generated locally
  instead of vendoring PGlite's multi-megabyte generated SQL files, and supports
  `--suite`, `--mode`, `--iterations`, and `--scale` for local and CI runs;
- May 1, 2026 local release parity/timing run after pinning
  `REL_17_5-pglite@01792c31` recorded raw JSON under `target/perf/`:
  `cold-release-latest.json`, `warm-release-latest.json`, and
  `bench-release-latest.json`;
- that cold release run used existing caches and production artifacts, so C-side
  backend timers were absent by design. Primary visible latencies were:
  preload 28.8ms, first direct temporary query 41.1ms, second direct temporary
  query 30.0ms, vector preload 8.4ms, first direct vector query 36.8ms,
  first tokio-postgres server query 31.4ms, first SQLx server query 31.9ms,
  first SQLx server vector query 36.9ms, and first SQLx vector query on an
  existing persistent root 25.8ms;
- dominant cold phases in that run were production runtime/AOT preload
  (`aot.deserialize.mmap` 16.3ms), Wasmer instance creation for new roots
  (about 5.3-10.2ms), backend start for template roots (about 18-24ms), and
  first protocol dispatch/query work (about 4.4-6.1ms). Per-root runtime setup
  stayed below the 1ms reporting threshold for scalar temporary roots;
- warm release run with 100 query iterations and 20 connect iterations showed:
  direct scalar repeated query average 0.024ms, direct transaction batch average
  0.022ms, direct vector repeated query average 0.025ms, SQLx single-connection
  query average 0.054ms, SQLx vector single-connection query average 0.058ms,
  tokio-postgres single-connection query average 0.175ms, and SQLx
  connect-query-close average 18.565ms;
- product-style benchmark run with `--suite all --mode all --iterations 100
  --scale 1` showed RTT trimmed averages from about 0.031-0.101ms for direct
  CRUD cases and about 0.055-0.130ms for SQLx server CRUD cases. The generated
  speed suite remained dominated by indexed updates: direct 25k indexed update
  4.390s, direct 25k text indexed update 8.024s, SQLx server 25k indexed update
  4.350s, and SQLx server 25k text indexed update 8.057s;
- follow-up parity work found that the WASIX host was starting single-user
  Postgres with `shared_buffers=400kB`, while `@electric-sql/pglite@0.4.5`
  reports `shared_buffers=128MB`. The fix moved the intended buffer GUCs into
  the Rust startup arguments (`shared_buffers=128MB`, `wal_buffers=4MB`,
  `min_wal_size=80MB`). The exact PGlite speed-source rerun now records local
  all-suite direct timings around 570ms for Test 9, 732ms for Test 10, 106ms for
  Test 11, and 86ms for Test 14; SQLx server timings were about 593ms, 726ms,
  102ms, and 83ms for the same tests.
  `perf diagnose-buffer-cache` verifies zero Postgres shared read blocks for the
  table-copy hotspots after setup, matching PGlite's effective buffer behavior;
- `xtask assets check` now guards production WASIX inputs for mandatory
  WebAssembly exception and dynamic-linking flags and rejects Asyncify markers
  in production configure scripts;
- production profile scripts reject Asyncify flag injection by default; the
  explicit `PGLITE_OXIDE_ALLOW_ASYNCIFY_EXPERIMENT=1` override is reserved for
  local snapshot/journaling experiments;
- final package sizes stayed under crates.io's 10 MB compressed limit:
  `pglite-oxide` about 7.15 MB, `pglite-oxide-assets` about 4.87 MB, and
  `pglite-oxide-aot-aarch64-apple-darwin` about 5.62 MB;
- `cargo test --release --workspace --all-targets`,
  `cargo check --workspace --no-default-features --all-targets`,
  `cargo run -p xtask -- assets check --strict-generated`, and
  `cargo run -p xtask -- package-size --limit 10000000` passed against the
  regenerated artifacts.
