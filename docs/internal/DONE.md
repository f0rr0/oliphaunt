# Done (Maintainers)

This is the single status document for implementation work already completed.
It is maintainer-facing and intentionally separate from the end-user docs.

## Native Perf Evidence

Implemented:

- native benchmark provenance now distinguishes release evidence, partial
  reports, and diagnostic runs;
- React Native benchmark reports now include app-reported process memory through
  `Oliphaunt.processMemory()`. iOS records Mach task resident/physical-footprint
  bytes, Android records `Debug.MemoryInfo` PSS/dirty/heap fields, and the
  mobile footprint matrix summarizes those fields instead of trusting missing
  host-side process output as zero;
- release-grade perf validation requires the full native matrix: direct,
  broker, server, native PostgreSQL controls, SQLite control, RTT, speed,
  streaming, and prepared-update suites;
- release-grade perf validation now verifies the raw benchmark JSON and
  resource files exist for base runs and configured repeats, including p50,
  p90, p95, and p99 latency fields for benchmark reports;
- no-build harness checks synthesize a tiny release fixture so provenance and
  raw-output validation stay in the fast maintainer loop without launching the
  native benchmark suite.
- native perf reports include throughput, backup/restore, p90/p99 CPU/RSS and
  child-RSS evidence, plus a `Native Direct Regression Diagnostics` section with
  focused rerun and `perf diagnose-speed-cases` commands when NativeDirect
  misses a native PostgreSQL gate;
- native perf reports now keep backup payload bytes visible and include a
  same-semantics native PostgreSQL physical-archive control. The current matrix
  compares liboliphaunt physical backup/restore against a `pg_backup_start` /
  `pg_backup_stop` filtered-PGDATA tar control with equal `56.17 MB` p50
  payloads. The logical `pg_dump`/`pg_restore -Fc` row remains comparison data,
  not the direct parity gate.
- direct physical backups now prefer `oliphaunt_backup_ex`, which appends SDK
  root/archive metadata while the C archive is still being written instead of
  validating and copying the full archive in Rust afterward. The C tar writer
  also uses direct `read(2)` file reads, per-entry buffer reservation, and
  opt-in `OLIPHAUNT_TRACE_BACKUP=1` phase diagnostics.
- `tools/perf/matrix/run_native_speed_diagnostics.sh` runs repeated
  fresh-process native-direct and native-PostgreSQL speed-case diagnostics and
  writes versioned `oliphaunt.native-speed-diagnostics.v1` summaries. The first
  current-source follow-up run for `20260524T090412Z` reproduced speed misses
  for cases `1`, `2.1`, `3`, `4`, `10`, and `13`; cases `2`, `3.1`, and `5`
  did not reproduce above the
  5% tolerance in isolated diagnostics.
- the mobile footprint matrix emits Android/iOS Expo dev-client benchmark and
  process-death recovery cases for the requested shared-buffer, WAL-buffer,
  WAL-size, and Safe/Balanced durability sweep; its no-build guard verifies
  honest case counts, skips invalid 8MB/16MB WAL-minimum cases for the current
  16MB WAL-segment PG18 build, and summarizes p50/p90/p95/p99, package size,
  Android PSS/RSS, and iOS resident memory.
- the iOS device artifact lane now builds a current XCFramework with device and
  simulator slices that fail freshness checks if PostgreSQL imports
  mobile-forbidden shared-memory or semaphore APIs; the physical iPhone
  installed-app path reached successful build/install, crash-recovery verify,
  a full smoke run with automatic physical-device background/foreground
  lifecycle exercise through Safari, and quick plus full-candidate installed-app
  footprint matrices with Safe/Balanced durability, same-device SQLite
  baselines, process-death WAL recovery, and app-reported Mach task
  resident/physical-footprint memory. A follow-up physical iPhone quick tuning
  slice varied `shared_buffers=8/16/32/64/128MB` and
  `min_wal_size=8/16/32MB` under Balanced durability with 15/15 passing cases,
  proving effective GUC capture and showing physical footprint is mostly flat
  across small WAL minima while 128MB shared buffers add a modest footprint
  step. The harness also has a reuse-installed-app retry mode for locked-device
  launch failures, and a post-change physical iPhone reuse-installed smoke
  passed background/foreground lifecycle SQL after adding a bounded Expo launch
  URL read in the example app.
- the Android Expo installed-app lane was recovered on the local API 34 emulator
  by cold-starting the AVD with `-gpu swiftshader_indirect` and
  `-no-snapshot-load`; the balancedMobile Safe 32MB/shared-buffers, 4MB-WAL
  quick slice passed benchmark and process-death recovery, including same-device
  SQLite comparison and Android PSS/RSS capture. Later Android emulator retry
  evidence also proved app-reported `Debug.MemoryInfo` capture in one
  balancedMobile quick case, but the same local AVD killed a follow-up app
  process before attach/startup, so that failure is recorded as harness/device
  instability rather than database performance evidence.
- SDK parity checks now guard the mobile direct-mode lifecycle contract:
  one resident backend per process, one physical session, serialized requests,
  same-root logical reopen only, no crash isolation, and
  `prepareForBackground`/`resumeFromBackground` documentation.
- `target/perf/native-liboliphaunt-20260524T090412Z/report.md` is a complete
  PostgreSQL 18.4 native release matrix with direct, broker, server, native
  PostgreSQL, and SQLite rows for RTT, speed, streaming, prepared updates, and
  backup/restore. Strict
  `tools/perf/check-native-perf-report.sh` provenance
  verification passed against that recorded source/artifact set; later backup
  ABI/tar-writer changes require a refreshed full matrix before current-source
  release claims. The report shows
  NativeDirect passing RTT, open, and RSS gates while still missing speed-suite
  p90, speed tail throughput, physical backup/restore p90, and physical backup
  throughput, so those misses remain tracked work instead of parity claims.
- `tools/xtask` now keeps `wasmer-types` behind the AOT serializer feature.
  Native no-default-feature builds no longer compile that legacy runtime crate,
  and `tools/policy/check-native-boundaries.sh` guards the feature boundary.

## Runtime Direction

The repository now has one production direction: WASIX dynamic linking plus
headless Wasmer loading of CI-produced LLVM AOT artifacts.

Removed or excluded from the production path:

- Wasmtime/static-WASI runtime path;
- Emscripten/JavaScript glue runtime path;
- user-side Docker, LLVM, Cranelift, or local Postgres compilation;
- duplicated runtime layouts and host-side timezone/path rewrite shims;
- historical spike workspaces from the tracked repository.

Production build inputs now live under `assets/`.

## Workspace And Asset Crates

Implemented:

- root `oliphaunt-wasix` crate remains the public crate;
- `liboliphaunt-wasix-portable` is the published runtime asset crate skeleton;
- source-only target AOT crate templates exist under `src/runtimes/liboliphaunt/wasix/crates/aot/*`;
- `xtask` owns source checks, build orchestration, packaging, manifest checks,
  package sizing, upstream audits, and source-spine validation;
- upstream checkouts are no longer tracked; maintainers fetch pinned sources on
  demand into ignored `target/oliphaunt-sources/checkouts`;
- source pins live in `src/sources/third-party/**`;
- root packages exclude upstream checkouts from published crates.
- `xtask assets verify-committed` validates source-controlled asset inputs,
  source pins, package metadata, AOT crate templates, and generated extension
  coherence when generated manifests are installed, without local upstream
  checkouts;

Generated release asset set:

- portable Oliphaunt WASIX runtime archive;
- `pg_dump.wasix.wasm`;
- deterministic `.tar.zst` archives for the 37 requested extension build
  candidates. All 37 promoted exact extensions are stable public constants after
  direct, server, restart, and lifecycle materialization gates;
- prepopulated PGDATA template archive;
- native Wasmer LLVM AOT artifacts.

These artifacts are generated locally under `target/oliphaunt-wasix/**` or by the
Builds workflow WASIX runtime jobs and are consumed by release staging without
being committed to git.

## Builder-First Release Staging

Implemented:

- the Builds workflow now owns release-shaped runtime, SDK, and exact-extension
  package artifacts; the Release workflow requires same-SHA Builds artifacts
  and consumes them instead of rebuilding native assets during publish;
- exact-extension package staging now renames native and WASIX assets into the
  independent extension product/version namespace and writes a release manifest
  beside the archive assets;
- exact-extension artifact targets are now product-local metadata under each
  external extension, and the Builds workflow derives the native extension
  matrix from those targets across macOS, Linux, Windows, iOS, and Android;
- React Native mobile build jobs consume native exact-extension artifact
  outputs and stage package-shaped manifests locally instead of waiting for the
  aggregate native+WASIX extension package release assembly;
- GitHub release asset verification reads staged exact-extension package
  manifests for extension products, and attestation verification includes
  extension, broker, Node direct, liboliphaunt, and WASIX asset families;
- the Rust SDK no longer declares a false `github-release-assets` publish target
  because it has no GitHub release asset payload beyond the registry package.

## Source And Build Spine

Implemented:

- active source baseline switched to `postgres/postgres`
  `PG17 legacy lane` at `01792c31a62b7045eb22e93d7dad022bb64b1184`, matching
  the audited `@electric/wasm` 0.4.5 source/artifact pair;
- `oliphaunt-build` `portable` is pinned as build-script provenance;
- maintained WASIX build files live under `src/runtimes/liboliphaunt/wasix/assets/build`;
- `xtask assets build --execute` can produce the main runtime, support modules,
  requested contrib/PGXS extension side modules, SQL-only extension payloads,
  and `pg_dump` for the local target;
- `xtask assets package` emits deterministic archives, generated manifests, and
  crate assets;
- `xtask assets aot` regenerates local Wasmer LLVM AOT artifacts;
- `xtask assets check --strict-generated` validates generated metadata;
- `xtask assets source-spine --check-patch-applies` validates the maintained
  source patch and C ABI harness;
- `xtask assets audit-upstream --strict` records upstream fix decisions;
- required upstream fixes from `PG17 legacy lane` are now the active source
  spine rather than comparison material. The WASIX patch keeps dynamic-main and
  side-module support, C startup timers, and explicit exports for the stable
  branch lifecycle while reusing upstream `oliphaunt_wasix_start`,
  `pgl_setOliphauntActive`, `ProcessStartupPacket`, `PostgresMainLoopOnce`, and
  `PostgresMainLongJmp`;
- source-spine review conclusion: upstream Oliphaunt's libc/host adaptations are
  purposeful for wasm hosts, not arbitrary shortcuts. `oliphauntc.c` supplies
  stable `postgres` identity, explicit process-active state, manual top-level
  longjmp recovery, socket callbacks, shared-memory emulation, and explicit
  atexit replay because browser/Emscripten cannot provide normal Postgres
  child processes, sockets, Unix users, SysV shared memory, or a native process
  lifecycle. The WASIX bridge keeps the same architectural contracts where
  Wasmer still needs host assistance, but uses Rust-owned input/output buffers
  instead of Emscripten callback pointers because the Rust host does not have
  Emscripten's JS table callback mechanism;
- WASIX-specific deviation from upstream Oliphaunt: top-level Postgres longjmp
  detection uses `jmp_buf` pointer identity instead of upstream's buffer-content
  `memcmp`. The memcmp test is acceptable in the Emscripten artifact it was
  written for, but under Wasmer/WASIX it misclassified nested PostgreSQL
  `PG_TRY` handlers and skipped normal portal cleanup. Pointer identity keeps
  the host escape hatch scoped to the single exported top-level recovery buffer;
- WASIX-specific PostgreSQL fix: active portal abort cleanup is owned in
  `AtAbort_Portals` for `OLIPHAUNT_WASIX_DL`, not in Rust. This keeps simple-query
  and COPY error recovery at the PostgreSQL portal lifecycle boundary and avoids
  fabricating cleanup behavior in the wire proxy;
- stable branch behavior note: startup `ParameterStatus` messages may be emitted
  on raw protocol paths before `ReadyForQuery`. Tests now allow those legal
  PostgreSQL messages instead of assuming the older minimal message sequence;
- new roots are now created through the packaged PGDATA template path. The old
  embedded-backend `pgl_initdb` path was removed; explicit fresh-initdb paths
  now use the bundled split WASIX `initdb` command and remain outside the
  default fast path;
- the old builder-branch `oliphaunt-wasix/*` runtime wrapper is no longer the
  production patch target. It remains historical/reference material only;
- `xtask package-size --enforce` passes locally for the root, asset, and macOS
  arm64 AOT crates.

Parity verified against upstream Oliphaunt stable source and TypeScript host:

- startup/initdb: upstream TypeScript creates a cluster with `initdb.wasm`,
  dumps PGDATA, loads that tarball into the main runtime, calls
  `_pgl_setOliphauntActive(1)`, runs `callMain([...startParams, -D, PGDATA,
  PGDATABASE])`, expects exit `99`, then calls `_oliphaunt_wasix_start()`.
  oliphaunt-wasix matches the main-runtime lifecycle from `_pgl_setOliphauntActive`
  onward and deliberately consumes a packaged PGDATA template instead of
  exposing split runtime `initdb` yet. That is an explicit product gap, not a
  hidden fallback;
- startup packet: upstream calls `_pgl_getMyProcPort()`,
  `_ProcessStartupPacket(...)`, `_pgl_sendConnData()`, and `_pgl_pq_flush()`.
  oliphaunt-wasix uses the same C exports. Server connections now open the
  embedded backend against the startup packet database, apply client startup
  options on the C side, and apply non-`postgres` users through PostgreSQL
  `SET ROLE` semantics, matching Oliphaunt's single-process identity model;
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
- host ABI: upstream `oliphauntc.c` emulates sockets, identity, shared memory,
  `system`/`popen`, timers, longjmp, and atexit because browser/Emscripten does
  not provide normal process or OS services. oliphaunt-wasix keeps the same
  categories only where WASIX still needs host assistance, and the ABI harness
  tests stable identity, fail-closed `system`, protocol fd bridging, shared
  memory, atexit replay, mmap, and libpq encoding aliases;
- justified deviations: WASIX longjmp detection uses pointer identity instead of
  upstream's `jmp_buf` content `memcmp`; simple-query/COPY portal abort cleanup
  is owned in PostgreSQL `AtAbort_Portals`; startup `ParameterStatus` messages
  are accepted as legal protocol output; split WASIX `initdb` is now the owned
  template-generation path instead of resurrecting the old builder wrapper.

## Runtime Behavior

Implemented:

- runtime loads verified headless Wasmer AOT artifacts;
- AOT artifacts record source module hash, Wasmer version, and engine identity;
- runtime verifies asset and archive hashes before use;
- unsupported targets return a clear missing-AOT-artifact error instead of
  compiling locally;
- `Oliphaunt::preload()` and `Oliphaunt::preload_extensions(...)` exist;
- `Oliphaunt::preload()` now warms the persistent runtime cache, headless Wasmer
  engine, main AOT module, shared WASIX runtime, and runtime side modules;
- `Oliphaunt::preload_extensions(...)` warms requested extension artifacts and
  side-module cache entries generically;
- direct, persistent, app-id, proxy, server, and temporary roots now share the
  `RootPlan`/`prepare_root` root-preparation pipeline;
- direct API, server API, proxy CLI, raw protocol API, and direct `pg_dump` now
  share `BackendSession` for WASIX instance creation, backend start, startup
  packet handling, protocol transport, shutdown, restart, and atexit replay;
- roots can install immutable runtime files from a persistent runtime cache and
  install the embedded PGDATA template without running initdb on the default
  startup path;
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

- `OliphauntBuilder::extension`;
- `OliphauntBuilder::extensions`;
- `OliphauntBuilder::username`;
- `OliphauntBuilder::database`;
- `OliphauntBuilder::debug_level`;
- `OliphauntBuilder::relaxed_durability`;
- `OliphauntBuilder::startup_arg`;
- `OliphauntBuilder::startup_args`;
- `OliphauntBuilder::load_data_dir_archive`;
- `Oliphaunt::enable_extension`;
- `Oliphaunt::preload`;
- `Oliphaunt::preload_extensions`;
- `Oliphaunt::dump_data_dir`;
- `Oliphaunt::dump_data_dir_with_format`;
- `Oliphaunt::try_clone`;
- physical PGDATA archives now apply Wasmer overlay whiteouts, so files deleted
  from the lower template are not resurrected by dump/load/clone;
- physical PGDATA archives are written from a materialized effective PGDATA view
  instead of directly mixing lower-template and upper-overlay entries in the tar
  writer;
- physical PGDATA archive/clone now checkpoints, quiesces the backend,
  materializes the archive, and restarts the same backend session; docs state
  this is a same-runtime/same-version physical import/export path, not a
  cross-version backup protocol;
- `Oliphaunt::exec_protocol_raw`;
- `Oliphaunt::exec_protocol_raw_stream`;
- `Oliphaunt::dump_sql`;
- `Oliphaunt::dump_bytes`;
- `OliphauntServerBuilder::extension`;
- `OliphauntServerBuilder::extensions`;
- `OliphauntServerBuilder::username`;
- `OliphauntServerBuilder::database`;
- `OliphauntServerBuilder::debug_level`;
- `OliphauntServerBuilder::relaxed_durability`;
- `OliphauntServerBuilder::startup_arg`;
- `OliphauntServerBuilder::startup_args`;
- `OliphauntServer::database_url`;
- `OliphauntServer::dump_sql`;
- `OliphauntServer::dump_bytes`;
- `PgDumpOptions`;
- 37 public extension constants plus `extensions::ALL`, covering the smoke-gated
  packaged Oliphaunt/Postgres catalog: `amcheck`, `auto_explain`, `bloom`,
  `age`, `btree_gin`, `btree_gist`, `citext`, `cube`, `dict_int`, `dict_xsyn`,
  `earthdistance`, `file_fdw`, `fuzzystrmatch`, `hstore`, `intarray`, `isn`,
  `lo`, `ltree`, `pageinspect`, `pg_buffercache`, `pg_freespacemap`,
  `pg_hashids`, `pg_ivm`, `pg_surgery`, `pg_textsearch`, `pg_trgm`,
  `pg_uuidv7`, `pg_visibility`, `pg_walinspect`, SQL-only `pgtap`, `seg`,
  `tablefunc`, `tcn`, `tsm_system_rows`, `tsm_system_time`, `unaccent`, and
  `vector`.

`oliphaunt-wasix-dump` no longer exposes the old archive-unpack behavior. It is now a
real logical dump CLI backed by the packaged WASIX `pg_dump` module.

`relaxed_durability` is a startup-profile flag rather than a hidden mutation of
`PostgresConfig`; explicit user `postgres_config` values win and
`relaxed_durability(true).relaxed_durability(false)` returns to the normal
profile.

## Protocol And Server Correctness

Implemented coverage:

- direct Rust API open/init/query;
- persistence, close/reopen, stale runtime-state cleanup, interrupted PGDATA
  cleanup, and root-lock conflicts;
- SQLx and `tokio-postgres` local-server connections;
- SSLRequest no-SSL response;
- CancelRequest safe close;
- backend-open failures no longer map every non-`template1` startup failure to
  SQLSTATE `3D000`. PostgreSQL/C now owns startup identity and database errors:
  the WASIX backend captures `InitPostgres` startup `ErrorResponse` bytes, the
  proxy forwards them directly, and runtime/filesystem failures before
  PostgreSQL can speak protocol remain synthesized `XX000`;
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
- server-mode `COPY FROM STDIN` now streams through the backend-owned protocol
  pump instead of Rust SQL-text detection or proxy-fabricated COPY state. Normal
  SQLx/tokio-postgres traffic uses the buffered raw-protocol path; when
  PostgreSQL emits a real `CopyInResponse`, `CopyOutResponse`, or
  `CopyBothResponse`, the WASIX bridge flushes buffered backend output to the
  attached socket continuation and lets PostgreSQL continue on the socket. Raw
  wire coverage includes simple COPY, extended-protocol COPY, CSV `WITH (...)`
  COPY, binary COPY, `CopyData`, `CopyDone`, `CopyFail`, Unix-socket COPY
  parity, and post-COPY connection reuse.
- continuation bytes are borrowed in the proxy read loop and materialized only
  after the C bridge reports active streaming COPY;
- direct raw protocol streaming is routed through the shared `BackendSession`
  framed sender instead of a separate client-only transport path;
- Rust-owned guest bridge allocations are scoped through `pg_free`/`free`, and
  debug builds now have a direct raw-protocol stress test proving repeated
  bridge round trips keep allocation/free counters balanced;
- direct LISTEN/UNLISTEN quotes channel identifiers and dispatches notifications
  by the exact backend channel name, including case-sensitive and quoted names.
- a larger PostgreSQL regression subset now ports the relevant Oliphaunt test
  surface for datatypes, DDL, transactions/savepoints, planner/index behavior,
  and direct `/dev/blob` CSV COPY. The datatype coverage also found and fixed a
  direct-client multidimensional array parser bug, with unit coverage for
  nested arrays, quoted values, and unquoted NULL handling.

## Independent P0 Architecture Review

The P0 review was re-run against the current Rust host, WASIX bridge, source
patch, and regression tests. No current P0 architecture blockers remain in the
reviewed surface. The completed P0 items were moved out of the backlog; future
major protocol, backup, runtime, or source-spine changes should get a new
review entry here instead of leaving completed checklists in `TODO.md`.

Verified ownership boundaries:

- Rust owns hosting, root preparation, caches, process lifecycle, direct/server
  API shape, and typed fallbacks for host/runtime failures before PostgreSQL can
  speak wire protocol;
- PostgreSQL/C owns SQLSTATEs, startup identity/database errors, query protocol
  state, COPY state, portal cleanup, and longjmp recovery boundaries;
- the WASIX bridge owns only the host ABI that Wasmer/WASIX cannot provide as a
  normal OS process boundary: protocol fd transport, locale/identity shims,
  single-process shared memory, fail-closed process calls, and explicit
  allocation/free ownership.

Review conclusions:

- guest-memory ownership is scoped through `GuestAllocator`, `pg_free`/`free`,
  and debug allocation/free counters;
- detached protocol stdio fails closed rather than silently accepting bytes;
- COPY state is reported by PostgreSQL through
  `pgl_protocol_report_copy_response`; the proxy no longer parses SQL text,
  fabricates COPY state, scans whole backend buffers, or eagerly copies
  continuation bytes for ordinary traffic;
- direct raw protocol streaming and direct `pg_dump` use the shared
  `BackendSession` transport instead of a separate clone/server path;
- startup role/database failures are PostgreSQL-owned: WASIX backend open
  captures `InitPostgres` `ErrorResponse` bytes, the proxy forwards those bytes,
  and Rust no longer probes `pg_database` or string-guesses `3D000`;
- direct API, server API, proxy CLI, raw protocol, physical archive/clone, and
  direct `pg_dump` share `RootPlan`/`prepare_root` and `BackendSession`
  lifecycle paths;
- side-module cache seeding is keyed by artifact name, source module hash,
  Wasmer version, Wasmer-WASIX version, and engine identity;
- AOT startup keeps full SHA verification behind
  `OLIPHAUNT_WASM_AOT_VERIFY=full` while default loading uses metadata receipts
  and mmap/native deserialization;
- PGDATA physical archive/clone materializes the effective overlay view with
  whiteouts, quiesces/restarts the backend, and is documented as
  same-runtime/same-version physical transfer rather than a WAL-aware backup;
- public API parity additions were reviewed at that point: raw protocol
  streaming is real, physical clone/export has honest semantics, startup args
  remain advanced, and listener channel names are identifier quoted.

Residual work from this review is intentionally not P0 architecture debt:
target-matrix CI, broader extension generation, additional PostgreSQL
regression subsets, release performance gates, and future split-WASIX `initdb`
support remain tracked in `TODO.md`.

## Extensions And `pg_dump`

Implemented coverage:

- `vector` direct API load, `CREATE EXTENSION`, insert, distance query, and
  pgvector type cases;
- `vector` through `OliphauntServer` and SQLx;
- SQLx recovery after vector-originated errors;
- demand-driven extension install and idempotent `enable_extension`;
- installed extension side modules are seeded into the headless Wasmer cache on
  reopen;
- `pg_trgm` direct API and SQLx server smoke coverage;
- `hstore` direct API, persistence/reopen, and SQLx server smoke coverage;
- Oliphaunt extension tests were ported into a generic promotion gate for direct
  API, server API, restart, and lifecycle materialization. The gate now covers
  every packaged candidate. AGE now uses its upstream 32-bit `SIZEOF_DATUM=4`
  SQL generation path, passes direct/server/restart/lifecycle gates, and is
  exposed as `extensions::AGE`;
- extension discovery now merges Oliphaunt docs/REPL exports, Oliphaunt package
  exports, PostgreSQL contrib metadata, `postgres-oliphaunt` `other_extensions`
  pins, Oliphaunt tests, and the packaged asset manifest into
  `src/extensions/generated/extensions.catalog.json`;
- `xtask assets fetch` now clones/fetches every pinned source from
  `src/sources/third-party/**` into ignored `target/oliphaunt-sources/checkouts/**` directories,
  including the external extension sources for pgtap, pg_ivm, pg_uuidv7,
  pg_hashids, AGE, PostGIS, and pg_textsearch;
- extension build intent now lives in `src/extensions/catalog/extensions.promoted.toml` instead
  of being inferred from already-packaged artifacts. The generated catalog
  separates requested, packaged, stable, and publicly promoted state;
- extension smoke evidence now lives in `src/extensions/catalog/extensions.smoke.toml`;
  generated public constants require requested + packaged + stable + direct,
  server, and restart smoke status recorded as passed;
- `xtask extensions build-plan --write` generates
  `src/extensions/generated/extensions.build-plan.json`,
  `src/extensions/generated/contrib-build.tsv`, and
  `src/extensions/generated/pgxs-build.tsv`; `xtask assets check --strict-generated`
  fails if those generated files drift;
- the WASIX extension build spine now uses generic contrib and PGXS build
  scripts driven by the generated build plans, replacing the previous
  `pg_trgm`-only and `pgvector`-only Docker scripts;
- the generated catalog now requires every discovered SQL extension to be
  either requested for build or explicitly blocked with a concrete reason. The
  current catalog discovers 40 SQL extensions, requests/packages 37, and blocks
  only `pgcrypto`, PostGIS, and `uuid-ossp` on missing pinned native dependency
  stacks;
- native side-module names are generated from control-file `module_pathname`
  and PGXS Makefile metadata instead of assuming `<sql_name>.so`. This covers
  cases such as `intarray` using `_int.so` and SQL-only extensions such as
  `pgtap`;
- both generated build plans now support native and SQL-only extensions. The
  local WASIX build produced all requested contrib and PGXS extension payloads,
  generated local macOS arm64 AOT artifacts for all requested native modules,
  and packaged all requested extension archives into `liboliphaunt-wasix-portable`;
- contrib packaging now carries extension-owned tsearch rule files into
  `share/postgresql/tsearch_data`, matching Oliphaunt behavior for `dict_xsyn` and
  `unaccent`;
- generated extension constants are emitted only for extensions that are
  requested, packaged, stable, and direct/server/restart smoke-passed; generated
  asset includes carry all packaged candidates so private promotion tests can
  exercise candidates before they become public API;
- manifest metadata records extension source kind, control files,
  dependencies, lifecycle, imports, required core exports, unresolved imports,
  installed files, load order, and smoke status;
- the `wasix-dl` export list is generated from the runtime exports plus
  runtime-support/extension side-module imports, rather than being a
  hand-maintained export allowlist;
- extension archive hash mismatch rejection;
- public WASIX `pg_dump` runner loads through the AOT manifest, connects to
  `OliphauntServer`, dumps plain SQL, restores into fresh `Oliphaunt`, and verifies
  schema/data;
- direct `Oliphaunt::dump_sql` no longer uses a temporary physical clone, public
  `OliphauntServer`, or OS loopback TCP; it runs the standalone WASIX `pg_dump`
  against an in-process Wasmer virtual TCP connection whose host side is routed
  through the same direct raw-protocol backend;
- direct `Oliphaunt::dump_sql` rejects database/user options that would imply a
  different backend than the already-open direct session; callers needing that
  use the server `pg_dump` path;
- the direct `pg_dump` transport keeps `pg_dump`/libpq stock and owns the only
  required semantic adapter in Rust: a first-write-readiness normalization for
  Wasmer's in-memory `TcpSocketHalf` so libpq's connect-time and first-write
  polls remain level-triggered;
- public `pg_dump` coverage includes indexes, views, sequences,
  `--schema-only`, `--quote-all-identifiers`, source-server reuse after dump,
  and vector extension dump/restore;
- `PgDumpOptions` rejects passthrough flags that conflict with the typed
  output/connection contract instead of letting callers override the internal
  output file, format, host, port, username, database, or job count.

## WASIX C Boundary Ownership

The remaining C-side differences are owned as WASIX portability and host ABI,
not hidden generic stubs:

- `pg_proto.c` manually coordinates `ReadyForQuery` for the current
  call/return protocol loop and is covered by SQLx, `tokio-postgres`, and raw
  wire-protocol tests;
- `pg_main.c` drives initdb boot/single-user phases inside one embedded process,
  with named helpers for boot, stdin restoration, and single-user replay;
- `pgl_os.h` emulates only the expected initdb boot/single `popen()` commands
  under `OLIPHAUNT_WASIX_DL` and fails closed otherwise;
- `pgl_stubs.h` is gated to `OLIPHAUNT_WASIX_DL`, and future removals are driven by
  link-symbol analysis;
- `oliphaunt_wasix_bridge.c` owns locale command emulation, stable `postgres`
  uid/passwd identity, protocol socket buffers, fail-closed `system()`, selected
  fd/socket delegation to WASIX libc, and single-process SysV shared memory.

The source-spine guard checks for removed spike smells: debug-only `#pragma`
markers, diagnostic `popen`, broad socket fake-success behavior, layout
mirroring, timezone rewrites, and generic stub logging.

## Validation Already Run

The following local gates passed before this consolidation:

```sh
cargo fmt --check
cargo check -p oliphaunt-wasix --all-targets
cargo check -p oliphaunt-wasix --no-default-features --all-targets
cargo run -p xtask -- assets check --strict-generated
cargo run -p xtask -- assets source-spine --check-patch-applies
cargo run -p xtask -- assets audit-upstream --strict
cargo run -p xtask -- package-size --enforce
cargo test --test client_compat
cargo test --test runtime_smoke
cargo test --test extensions_smoke
```

The public `pg_dump` round-trip tests and asset/AOT hash-mismatch tests also
passed locally.

## Cold-Start Performance Work

Implemented:

- internal phase timing via `capture_phase_timings`;
- `cargo run -p oliphaunt-perf -- cold` emits structured JSON with explicit
  `cacheStateBefore`, `processStateBefore`, `rootState`, `queryState`, and
  `workload` fields, so first-install bootstrap, process warmup, new-root first
  query, and client/server first query are no longer conflated;
- `cargo run -p oliphaunt-perf -- cold --reset-cache` removes the oliphaunt-wasix cache
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
  `OLIPHAUNT_WASM_AOT_VERIFY=full`;
- process-wide shared Tokio runtime, WASIX runtime, and `SharedCache`;
- side-module seeding is reused by artifact name, module hash, Wasmer version,
  Wasmer-WASIX version, and engine identity;
- phase timing now propagates into the server listener thread, so
  `OliphauntServer` cold runs report root preparation, listener bind/spawn,
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
- an eager PGDATA template overlay is implemented as the mainline template
  path: the cached initialized template is mounted as lower `/base`, the
  per-instance upper starts almost empty, and individual template files are
  copied into the upper only before mutating opens;
- the eager PGDATA overlay is passed as a runner-level WASIX mount. Nested
  mounts placed inside the supplied `WasiFsRoot` were not sufficient because
  `WasiRunner::prepare_webc_env` rebuilds the final mount tree from the root
  `/` filesystem plus runner-owned mounts;
- direct `Oliphaunt::open` no longer performs a separate session-setup round trip
  and no longer folds session defaults into array discovery SQL. The Rust WASIX
  host now calls the real C `ProcessStartupPacket` export from
  `backend_startup.c`; C `pgl_sendConnData()` applies the direct-session
  defaults before connection data is sent, so `BeginReportingGUCOptions`
  observes `TimeZone=UTC` and `search_path=public`;
- `OliphauntBuilder::postgres_config`, `OliphauntServerBuilder::postgres_config`,
  and `oliphaunt-wasix-proxy --postgres-config name=value` now pass user startup GUCs
  through PostgreSQL's normal `-c name=value` argv handling. User settings are
  appended after the default profile, so they override defaults without
  special-casing individual GUCs such as `synchronous_commit`;
- server-mode client startup `options=-c ...` is now applied on the C side after
  `ProcessStartupPacket` parses the packet and before `pgl_sendConnData()`
  emits `AuthenticationOk` and `ParameterStatus`, preserving PostgreSQL's
  startup-option timing for supported single-backend clients;
- extension-enabled PGDATA template caches include the startup-GUC entries in
  their manifest and cache key, so a template created under one backend config
  is not reused for another config;
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

Previous local debug `oliphaunt-perf cold` run after explicit preload:

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

Latest local debug `cargo run -p oliphaunt-perf -- cold` run after the shared
root-preparation work:

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

Latest local debug `cargo run -p oliphaunt-perf -- cold` run after the eager PGDATA
overlay and parsed-manifest cache:

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

The warm direct `oliphaunt.open` phase dropped to about 112ms. At that point the
remaining direct-open client-side cost was the array catalog scan, about 30ms
for the warm catalog query and less than 1ms for Rust-side parser/serializer
registration. Scalar paths no longer pay that scan after lazy/generated array
metadata.

Latest local release work:

- asset release builds now default to `release-o3`, which compiles WASIX C
  modules with `-O3 -g0 -flto=thin` and links with `-flto=thin`;
- release profiles run wasixcc's default Binaryen optimization plus
  `--converge`, `--strip-debug`, and `--strip-producers`;
- the current exact Oliphaunt speed-suite run favors `release-o3 + converge/strip`
  plus ThinLTO for SQL workload parity. The package-size gate still passes
  locally with the macOS arm64 AOT crate at about 7.2MiB compressed and the
  asset crate at about 5.6MiB compressed. Earlier startup-only runs favored
  `release-os` over `release-oz`, and adding a project `-msimd128` flag was
  redundant because the WASIX EH+PIC sysroot already invokes clang with SIMD,
  relaxed SIMD, and extended const enabled;
- Wasmer LLVM AOT codegen experiments selected the mainline serializer profile:
  nonvolatile memory operations plus a readonly funcref table. Nonvolatile
  memory operations improved the exact Oliphaunt server SQLx speed suite by about
  9% geomean and won all 18 cases, but Wasmer marks that optimization as not
  fully WebAssembly-spec compliant. Adding readonly funcref on top was about
  1.4% faster geomean than nonvolatile-only and improved indexed updates, but
  regressed CREATE INDEX and DROP TABLE cases. The risk is now explicit release
  profile surface and must be covered by the correctness matrix. The macOS
  arm64 packaged AOT artifacts were regenerated with this profile;
- exact Oliphaunt speed-suite comparison now has its own harness and diagnostic
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
- prepared indexed-update benchmarking now compares SQLx sequential prepared
  updates, tokio-postgres sequential prepared updates over TCP and Unix
  sockets, tokio-postgres pipelined prepared updates over TCP and Unix sockets,
  and native Postgres equivalents using the exact Oliphaunt Test 9/10 values.
  Deferring extended-protocol `Sync` flush only within bytes already read from
  one socket read reduced OliphauntServer TCP pipelined prepared updates from about
  `612.835ms -> 399.921ms` for numeric indexed updates and
  `640.691ms -> 416.837ms` for text indexed updates. Unix-socket OliphauntServer
  was faster again at about 374/397ms, so transport still matters for
  sequential prepared execution and modestly for pipelined execution. The exact
  simple-query server speed suite stayed in the same range after the change:
  Test 9 about 583ms and Test 10 about 740ms locally. A larger 256KiB proxy
  read buffer was tested and rejected because it regressed the same pipelined
  prepared workload to about 545/562ms;
- the native Postgres benchmark helper now attempts graceful termination before
  falling back to `Child::kill()`, because SIGKILL can leak SysV shared-memory
  IDs on macOS. `perf prepared-updates --skip-native` exists for Oliphaunt-only
  runs when local native Postgres IPC state is unhealthy;
- `perf prepared-updates --gate` now emits protocol counters and fails if
  ordinary prepared traffic activates the backend-owned streaming continuation
  or if pipelined prepared traffic stops batching. The timing thresholds are
  intentionally a local regression smoke gate until stable CI runner baselines
  exist;
- phase timing guards are hot-path no-ops when no recorder is active, so
  diagnostic spans do not call `Instant::now()` in normal runtime traffic;
- PostgreSQL spinlocks are enabled in the WASIX build. The earlier
  `--disable-spinlocks` fallback is gone, and the source-spine guard rejects it
  if it returns. This is a correctness/architecture baseline because wasixcc
  exposes the required atomic operations; local single-backend speed numbers are
  mixed enough that it should not be treated as a standalone benchmark win;
- the shared runtime overlay and eager PGDATA overlay are now mainline runtime
  behavior, with the old full-local runtime and full-template clone paths kept
  only as internal build/staging machinery where still required;
- local release `cargo run -p oliphaunt-perf -- cold` with no env overrides showed
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
- Wasmer AOT loading now uses the native mmapped-file deserializer as the only
  production path; the old file deserializer runtime switch was removed;
- after promoting the mainline AOT and filesystem paths, local release
  `cargo run --release -p oliphaunt-perf -- cold` showed primary visible latencies
  around 36ms for preload, 55ms for a new temporary direct first query, 45ms
  for a second new temporary direct first query, 47ms for server SQLx first
  query, and 57ms for server SQLx vector first query;
- the same mainline artifact profile measured exact Oliphaunt server speed-suite
  Test 9 at about 587ms, Test 10 at about 730ms, Test 11 at about 91ms, Test 14
  at about 71ms, and 18-test geomean around 76ms locally. Prepared-update
  server probes measured TCP pipelined prepared updates around 395/414ms and
  Unix pipelined prepared updates around 366/392ms for the numeric/text indexed
  workloads;
- after static built-in arrays and lazy runtime array discovery, local release
  `cargo run --release -p oliphaunt-perf -- cold` showed explicit preload about
  52ms, temporary first query about 88ms, warm temporary first query about 79ms,
  representative extension-backed first query about 131ms after extension
  preload, and server first query about 75ms. Scalar direct paths did not emit
  the `oliphaunt.array_type_catalog_query` phase;
- after server-thread timing and accept-loop cleanup, local release
  `cargo run --release -p oliphaunt-perf -- cold` showed explicit preload about
  19-22ms, temporary first query about 86-89ms, warm temporary first query about
  77ms, representative extension-backed first query about 132-140ms after
  extension preload, tokio-postgres server first query about 68ms, and SQLx
  server first query about 68-70ms. The server path now shows `server.start`
  around 52-54ms,
  `proxy.backend_open` around 44-46ms, `postgres.backend_start` around 35-37ms,
  tokio-postgres connect around 0.6ms/query around 5.5ms, and SQLx connect
  around 2.1ms/query around 6.0ms;
- `oliphaunt-perf cold` includes the extension-enabled SQLx server path, now named
  `process_warm_new_temp_server_sqlx_vector_first_query`, which starts
  `OliphauntServer` with a requested bundled extension and measures a first
  extension-backed SQLx query for a new temporary server root. This keeps
  server-mode extension install/load, `CREATE EXTENSION`, client connect, and
  first extension query visible as one product-shaped path. The first local
  release run measured about 175ms total, dominated by `proxy.extension_enable`
  around 107ms; SQLx connect and the
  first vector query were both sub-millisecond on that run;
- cold perf reporting now breaks out preload runtime cache setup, AOT install,
  mmap/file deserialization, WASIX runtime construction, instance creation,
  startup-packet/default-GUC work, client protocol round trips, extension side
  module seeding, and public `pg_dump` runner phases;
- instrumented WASIX runtime artifacts can export C-side backend startup timers
  via `pgl_backend_timing_elapsed_us`, and the Rust host records them as
  `postgres.backend.c.*` phases when the export is present. Production WASIX
  artifacts keep `OLIPHAUNT_WASM_WASIX_BACKEND_TIMING=0`, so the C timing macros
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
- direct `Oliphaunt` no longer calls host directory `sync_all` after every
  non-transaction query. PostgreSQL's WAL/fsync path owns durability, and the
  server path already avoided this extra host sync. In the local release run,
  direct visible latency dropped from about 68ms to about 53ms for the first
  new temporary root and to about 45ms for the second new temporary root;
- direct and server protocol timing now splits startup packet handling,
  protocol input/output, guest `PostgresMainLoopOnce`, direct parse/describe,
  direct execute, and direct result finish. The remaining first-query protocol
  cost is mostly PostgreSQL main-loop work for the parse/describe or prepared
  extended-query batch, not Rust parsing or buffer copies;
- `cargo run -p oliphaunt-perf -- warm` now measures true warm behavior separately
  from first-open work: repeated direct scalar queries, direct transaction
  batches, direct extension-backed queries, SQLx repeated queries over one
  connection, SQLx repeated connect-query-close cycles, SQLx extension-backed
  repeated queries, and tokio-postgres repeated queries. It reports total and
  per-iteration average phases while keeping open/shutdown phases as context;
- `cargo run --release -p oliphaunt-perf -- bench` now provides a product-style
  benchmark harness similar to Oliphaunt's published benchmark families. It runs
  trimmed-average CRUD round-trip benchmarks and a generated SQLite
  speedtest-style suite through both the direct Rust API and `OliphauntServer`
  with a long-lived SQLx connection. The speed suite is generated locally
  instead of vendoring Oliphaunt's multi-megabyte generated SQL files, and supports
  `--suite`, `--mode`, `--iterations`, and `--scale` for local and CI runs;
- May 1, 2026 local release parity/timing run after pinning
  `PG17 legacy lane@01792c31` recorded raw JSON under `target/perf/`:
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
  Postgres with `shared_buffers=400kB`, while `@electric/wasm@0.4.5`
  reports `shared_buffers=128MB`. The fix moved the intended buffer GUCs into
  the Rust startup arguments (`shared_buffers=128MB`, `wal_buffers=4MB`,
  `min_wal_size=80MB`). The exact Oliphaunt speed-source rerun now records local
  all-suite direct timings around 570ms for Test 9, 732ms for Test 10, 106ms for
  Test 11, and 86ms for Test 14; SQLx server timings were about 593ms, 726ms,
  102ms, and 83ms for the same tests.
  `perf diagnose-buffer-cache` verifies zero Postgres shared read blocks for the
  table-copy hotspots after setup, matching Oliphaunt's effective buffer behavior;
- `xtask assets check` now guards production WASIX inputs for mandatory
  WebAssembly exception and dynamic-linking flags and rejects Asyncify markers
  in production configure scripts;
- production profile scripts reject Asyncify flag injection by default; the
  explicit `OLIPHAUNT_WASM_ALLOW_ASYNCIFY_EXPERIMENT=1` override is reserved for
  local snapshot/journaling experiments;
- final package sizes stayed under crates.io's 10 MB compressed limit:
  `oliphaunt-wasix` about 7.15 MB, `liboliphaunt-wasix-portable` about 4.87 MB, and
  `liboliphaunt-wasix-aot-aarch64-apple-darwin` about 5.62 MB;
- `cargo test --release --workspace --all-targets`,
  `cargo check --workspace --no-default-features --all-targets`,
  `cargo run -p xtask -- assets check --strict-generated`, and
  `cargo run -p xtask -- package-size --limit 10000000` passed against the
  regenerated artifacts.

## CI/CD And Release Workflow

- CI now uses Moon as the source and task graph. The affected planner calls
  Moon queries and maps tagged tasks to stable GitHub `Checks` jobs; product
  jobs run `.github/scripts/run-moon-targets.sh`, which delegates execution to
  `moon run`;
- GitHub matrix is reserved for real target fan-out: native runtime targets,
  broker targets, Node direct targets, mobile build/E2E targets, and WASIX AOT
  targets. There is no separate CI jobs graph;
- release-please manifest mode owns version bumps, changelog updates, release
  PRs, and product tags. Product-local `release.toml` files own publish targets
  and artifact metadata, while Moon production/peer scopes provide release
  coupling;
- the manual Release workflow keeps protected `prepare-release-pr`,
  `publish-dry-run`, and `publish` operations with job-scoped permissions,
  trusted publishing, checksums, attestations, and product-native publish
  commands;
- native runtime, broker, Node direct, mobile, and WASIX AOT artifacts are
  selected by Moon affectedness and built through target metadata. Release jobs
  download those CI artifacts into `target/release-assets/`, validate package
  shape, and publish through the owning product release step;
- dependency invariant checks now block Wasmtime/static-WASI regressions and
  backend compiler crates such as LLVM/Cranelift/Singlepass from entering the
  normal user dependency tree;
- the public dependency graph now uses Cargo target-specific dependencies for
  AOT packs, so a normal `oliphaunt-wasix` install resolves the target-independent
  `liboliphaunt-wasix-portable` crate plus only the current platform's
  `liboliphaunt-wasix-aot-*` crate;
- source-only `tools/policy/check-rust-test-topology.sh` no longer runs broad
  Cargo product validation from the root policy lane. `pnpm moon run
  liboliphaunt-wasix:smoke` is now the hard runtime gate and requires portable
  assets plus the host AOT pack;
- `.github/scripts/download-wasix-runtime-build-artifacts.sh` is a thin wrapper
  over `xtask assets download`; exact-SHA, latest-compatible, host-target, and
  all-target WASIX runtime artifact downloads share one implementation;
- AOT serialization is now owned by a maintainer-only `xtask` feature. The
  normal runtime tree keeps headless Wasmer loading, while
  `xtask --features aot-serializer` is the only path that enables Wasmer LLVM;
- the WASIX runtime CI jobs now probe the LLVM AOT serializer before full AOT
  generation, validates generated portable assets before AOT work, smokes the
  target runtime before packaging/upload, and fails on empty/missing AOT
  manifests instead of uploading placeholder crates;
- `wasmer-wasix` is now explicitly feature-minimized for the runtime path
  (`sys-minimal`, `sys-poll`, `host-vnet`, and `time`). The root dependency gate
  rejects Wasmtime, backend compiler crates, Cranelift/Singlepass, LLVM, and
  broad HTTP/TLS stacks such as `reqwest`, `hyper`, and `rustls`;
- normal CI cache writes are limited to `main` while PRs still restore existing
  Rust caches. Release and AOT-heavy jobs opt into cache writes explicitly.

## Backlog Grooming Verification

The implementation backlog was reconciled against the repository state and the
following completed work was removed from `TODO.md`:

- current runtime-state notes for headless Wasmer AOT loading, pure MountFS
  runtime composition, eager PGDATA overlays, direct scalar no-`pg_type` array
  startup scans, no direct-query host `sync_all`, and shared
  `BackendSession`/root-preparation paths. These are already covered by the
  runtime, performance, and architecture sections above;
- CI/CD scaffolding that is present in the repo: Moon affected planning,
  tag-driven exact Moon target execution, native/WASIX target matrices, source-only AOT
  crate templates, staged release workspaces, exact-SHA artifact downloads,
  package-size gates, and Release workflow trusted-publishing permissions
  through `id-token: write`;
- public `pg_dump` functionality that is already implemented and tested:
  `PgDumpOptions`, direct and server `dump_sql`/`dump_bytes`, the `oliphaunt-wasix-dump`
  CLI, typed rejection of managed passthrough flags, no-clone/no-public-server
  direct dumps, stock libpq over virtual networking, indexes/views/sequences,
  `--schema-only`, `--quote-all-identifiers`, source-server reuse after dump,
  and vector dump/restore coverage;
- split WASIX `initdb` runtime support that is present locally: direct and
  server `fresh_temporary()`/`template_cache(false)` paths, split-initdb module
  execution, interrupted-PGDATA cleanup, initdb shim ABI/source-spine checks,
  and PGDATA template manifest checks. The remaining backlog tracks only full
  WASIX runtime CI proof, deterministic two-build comparison, and package-size
  impact;
- extension catalog/promotion infrastructure already in place: generated
  catalog/build plans, `src/extensions/catalog/extensions.promoted.toml`,
  `src/extensions/catalog/extensions.smoke.toml`, public constants for the 37 smoke-passed
  exact extensions, candidate/private smoke gates, generated native-module
  metadata, load-order metadata, and generated `wasix-dl` export lists;
- protocol and runtime guards already covered by tests or xtask checks:
  SSLRequest, CancelRequest, Parse/Bind/Execute recovery, SQLSTATE preservation,
  pipelined simple and extended query recovery, COPY streaming over TCP and Unix
  sockets, bridge allocation accounting, startup role/database ownership,
  export guards, longjmp boundary checks, broad-stub rejection, unsafe archive
  rejection, unsupported-target errors, and package-size checks;
- performance tooling already available locally: `oliphaunt-perf cold`,
  `oliphaunt-perf warm`, `oliphaunt-perf bench`,
  `oliphaunt-perf prepared-updates --skip-native --gate`, primary-latency phase
  reporting, production buffer-profile validation, warm server benchmarks, and
  product-style SQLx/native/Oliphaunt comparison outputs. The remaining backlog
  tracks turning these into stable GitHub-runner release gates.

## Native SDK API Surface Inventory

The native SDK parity track now has a no-build public surface inventory:

- `tools/policy/generate-sdk-api-surface.mjs --write` regenerates
  `src/docs/content/reference/sdk-api-surface.md` from the current Rust, Swift, Kotlin, and React
  Native SDK sources;
- `tools/policy/check-sdk-parity.sh` runs the generator in `--check` mode so
  accidental public symbol drift is visible in the fast parity gate;
- `docs/maintainers/sdk-parity-policy.md` links the inventory next to `docs/products/sdk-manifest.toml`, so
  ownership, supported platform shape, and public API review evidence stay
  together.

## SDK Parity Edge-Case Tests

Rust, Swift, Kotlin, and React Native now cover the edge cases that define the
current public SDK contract:

- escaped transaction handles are rejected after rollback or commit;
- transaction-owned streaming uses the pinned session boundary;
- closing during an active transaction closes the session and rejects pinned
  work instead of committing;
- PostgreSQL query cancellation remains a structured SQLSTATE `57014`
  ErrorResponse on typed query paths;
- `connectionString` is present only on server-capable sessions that advertise
  independent PostgreSQL client connections;
- startup `username` and `database` identity is first-class across Rust, Swift,
  Kotlin, and React Native. Rust now feeds the configured identity through
  direct, broker, and server startup paths, while mobile SDKs reject empty or
  NUL-containing values before crossing native/TurboModule boundaries;
- backend query parsers now use strict UTF-8 semantics across Rust, Swift,
  Kotlin, and React Native. Row-description C-strings and text accessors reject
  malformed backend bytes instead of silently replacement-decoding them;
- simple-query protocol builders now reject NUL-containing SQL across Rust,
  Swift, Kotlin, and React Native before constructing a frontend C-string frame;
- extended-query protocol builders now reject NUL-containing SQL and parameter
  lists above the PostgreSQL protocol `Int16` limit across Rust, Swift, Kotlin,
  and React Native before constructing frontend frames;
- typed query parsers now reject unexpected backend message tags across Rust,
  Swift, Kotlin, and React Native instead of silently ignoring them, while
  preserving known simple/extended-query control tags, validating async backend
  control-message framing, and validating the `ReadyForQuery`
  transaction-status byte;
- extension IDs are validated and normalized before public SDK open calls
  cross into the engine or TurboModule boundary.

## Native Mobile Exact-Extension Smoke Coverage

The SDK parity track now has explicit mobile packaging smoke evidence for
selected and unselected extension assets:

- Swift `OliphauntRuntimeResources` tests materialize a vector-selected resource
  package and assert `vector.control` / `vector--1.0.sql` are present while
  `hstore.control` stays absent;
- the Kotlin Android SDK check builds a synthetic runtime resources and verifies
  generated Android assets preserve the selected vector extension control file
  without leaking unselected hstore assets;
- the React Native Android SDK check performs the same assertion against the
  produced AAR, proving React Native inherits the Kotlin packaging boundary
  rather than carrying a private resource runtime.

## Native Extension Asset Shape Guards

The native extension release lane now rejects incomplete selected extension
asset sets before an app reaches `CREATE EXTENSION`:

- create-extension assets must include both the control file and at least one
  SQL install file when materializing runtime resources;
- loadable-module-only extensions such as `auto_explain` are still allowed to
  omit create-extension SQL/control files;
- cached native runtimes are invalidated when a selected extension has
  SQL/control assets but lacks the matching native module;
- cached native runtimes are also invalidated when a selected native-module
  extension has a control/module pair but no SQL install file;
- the gated native extension matrix already covers install/load, reopen,
  physical backup, restore, and restored reopen for direct, broker, and server
  modes when extension artifacts are available.

## Native Extension Dependency And Recovery Fixtures

The extension release lane now has explicit evidence for the remaining negative
fixtures:

- runtime materialization resolves extension dependencies before copying assets,
  so selecting `earthdistance` requires `cube` SQL/control/module assets and
  fails fast when the transitive dependency artifact set is incomplete;
- the gated native extension matrix reruns `CREATE EXTENSION <name>` after a
  successful install for every create-extension row, asserts PostgreSQL returns
  an `ErrorResponse` plus `ReadyForQuery`, and immediately proves the same
  session can run a follow-up query;
- loadable-module-only extensions such as `auto_explain` remain outside the
  repeated `CREATE EXTENSION` fixture because their product contract is `LOAD`.

## Native Extension Preload Startup Proof

Preload-required extensions now have fast source-level regression proof across
all native modes:

- direct mode builds `shared_preload_libraries=pg_search` into the C ABI
  `oliphaunt_init` startup argument vector before the embedded backend starts, and
  deduplicates repeated selections;
- broker mode forwards the resolved extension list, including `pg_search`, to
  the helper process before the helper opens its direct-mode backend;
- server mode builds the same preload setting into the `postgres -c ...`
  startup arguments before spawning the local PostgreSQL-compatible server;
- extensions that do not require preload hooks, such as `graph`, do not add a
  `shared_preload_libraries` setting.

## Native Extension Size Report

Rust SDK resource outputs now include selected-extension size evidence as part
of the portable Swift/Kotlin/React Native handoff:

- `package_native_resources(...)` writes `oliphaunt/package-size.tsv` and
  exposes `NativeRuntimeResources::size_report`;
- the report records runtime, template PGDATA, static-registry, package,
  de-duplicated selected-extension, and per-extension asset bytes;
- per-extension rows count the concrete resolved extension assets for each
  selected extension, including required dependencies, while the selected
  extension row is de-duplicated for total app-size impact;
- the `oliphaunt-resources` CLI prints `packageSizeReport=...`,
  `selectedExtensionBytes=...`, and `extensionBytes=<name>:<bytes>` so CI
  can diff package-size impact without custom filesystem walkers.
- Swift consumes the same TSV through
  `OliphauntRuntimeResources.packageSizeReport()` and tests both valid and
  malformed report parsing;
- Kotlin Android consumes it through `OliphauntAndroid.packageSizeReport(context)`
  with Android unit coverage for the parser;
- Kotlin and React Native Android packaging checks now preserve
  `assets/oliphaunt/package-size.tsv`, so mobile artifacts carry the Rust
  runtime-resource generator's extension byte evidence instead of forcing SDK-specific
  resource walkers.

## Native PostgreSQL Patch-Stack Review Gate

The native PostgreSQL 18 patch stack now has deterministic source-only release
evidence:

- `src/runtimes/liboliphaunt/native/tools/check-patch-stack.mjs --write` generates
  `docs/internal/OLIPHAUNT_PATCH_STACK.md` from `src/runtimes/liboliphaunt/native/postgres18/source.toml`
  and the maintained patch directory;
- `src/runtimes/liboliphaunt/native/tools/check-track.sh` runs the same script in `--check`
  mode before native Rust or SDK checks, so stale patch review evidence fails
  fast without rebuilding PostgreSQL;
- `source.toml` now lists every maintained patch, including the static extension
  loader patch, and the static loader patch has the same deterministic
  `Subject: [PATCH] liboliphaunt-native: ...` and `diff --git` metadata as the rest of
  the series;
- the generated review lists patch order, subject lines, changed upstream files,
  and patch-introduced `oliphaunt_*` symbols, while rejecting SDK/runtime/product
  terms that belong above PostgreSQL.
- the patch-stack review now assigns each audit requirement to its owning patch
  or patches and verifies the required evidence inside those patches, so host
  I/O, lifecycle, cleanup, cwd restore, runtime-path, static-extension, shell
  exclusion, Android shared-memory, and event-trigger changes stay independently
  reviewable;
- the checker now rejects unexpected upstream PostgreSQL touchpoints unless
  they are added to the expected touchpoint table with a rationale, preventing
  quiet patch-stack growth.

## Public C ABI Conformance Gate

`liboliphaunt` now has a consumer-style C ABI conformance check that compiles and
links against only `src/runtimes/liboliphaunt/native/include/oliphaunt.h`:

- `oliphaunt/smoke/liboliphaunt_abi_conformance.c` verifies ABI/version constants,
  capability bits, public struct field types, exported function prototypes, and
  safe global/no-handle calls without including PostgreSQL server headers;
- `src/runtimes/liboliphaunt/native/tools/run-host-c-smoke.mjs --abi-only`
  builds the conformance program with strict C11 warnings and links it to the
  current `liboliphaunt` shared library;
- `src/runtimes/liboliphaunt/native/tools/check-track.sh quick` now runs that
  conformance check before the heavier native happy-path smoke, so C ABI drift
  fails in the fast native lane before Rust, Swift, Kotlin, or React Native
  bindings trust the runtime.

## Direct Streaming Cancellation Regression

The Rust SDK now covers cancellation while a direct-mode streaming response is
active:

- `streaming_cancel_uses_out_of_band_cancel_and_releases_owner` proves the
  owner executor can cancel a large active stream without queueing cancellation
  behind the stream callback, then accepts follow-up raw protocol work on the
  same handle;
- the native `OliphauntRuntime` smoke path now runs a streaming
  `pg_sleep`/large-response query, cancels it through the opened handle, checks
  for PostgreSQL's query-canceled response, and verifies the backend can execute
  another query afterward.

## Broker And Server Cancellation Reuse Regression

Native runtime cancellation coverage now proves the process-isolated modes keep
their real PostgreSQL semantics after interruption:

- broker mode records `pg_backend_pid()` before repeated `Oliphaunt::cancel()`
  calls, runs cancellation and recovery through the helper process, then asserts
  the same helper/backend identity is still serving the handle afterward;
- server mode's external Tokio PostgreSQL client smoke starts independent
  clients, issues a PostgreSQL `CancelRequest` through the client cancel token
  after startup, asserts SQLSTATE `QUERY_CANCELED`, and then reuses that client
  for another query.

## Direct And Broker Transaction Failure Regressions

The Rust SDK now exercises serial-session transaction failure semantics across
both `NativeDirect` and `NativeBroker` modes:

- `with_transaction_commits_rolls_back_and_rejects_unpinned_interleaving` now
  runs for direct and broker mode configurations, proving body failure rolls
  back and releases the single physical session in both modes;
- `transaction_commit_and_rollback_failures_release_serial_session` uses a
  scripted runtime to force `COMMIT` and `ROLLBACK` failures, proving failed
  commit attempts trigger best-effort rollback and failed rollback attempts
  still release the session pin before subsequent work;
- dropped transactions and close-while-transaction-active coverage now run for
  both direct and broker mode configurations instead of only the default direct
  mode.

## Native Server Lifecycle Regressions

Server mode now has explicit lifecycle evidence for the connection string and
external clients:

- server smoke asserts the opened handle's `connection_string()` matches the
  advertised capability value and remains stable after protocol, streaming,
  cancellation, and backup work;
- the Tokio PostgreSQL external-client smoke asserts the connection string stays
  stable after independent clients use the server;
- SQLx pool coverage now closes the owned server while the pool is alive and
  verifies subsequent pool work is rejected;
- active external client coverage starts a long-running PostgreSQL query through
  `tokio-postgres`, closes the owned server, verifies the active query is
  interrupted, and verifies the external client cannot run more SQL afterward.

## Native Root Manifest Gate

Live native roots now carry a root-owned `manifest.properties` compatibility
record:

- root preparation adopts existing PostgreSQL 18 roots by writing the manifest
  under the native root lock;
- direct, broker-helper, and server paths reject roots whose manifest or
  `pgdata/PG_VERSION` targets a PostgreSQL major other than 18 before exposing
  the engine;
- initdb-style uninitialized roots are marked as pending and refreshed after
  direct/server initialization observes `PG_VERSION`;
- unit coverage validates adoption, uninitialized-to-initialized refresh, and
  incompatible PGDATA rejection, while broker smoke corrupts the manifest and
  verifies `existing_only()` fails during helper startup.

## Physical Archive Compatibility Metadata

Native physical backups now carry compatibility metadata instead of relying on
implicit PGDATA shape alone:

- Rust direct, broker, and server backup paths annotate physical archives with
  the root `manifest.properties` plus `.oliphaunt/backup-manifest.properties`;
- the backup manifest records PostgreSQL major/version number, PGDATA version,
  server encoding, locale, data-checksum state, active
  `shared_preload_libraries`, required preload libraries, selected extensions,
  and installed PostgreSQL extensions;
- restore validates root and backup manifests before publishing a target root,
  while still accepting legacy archives that only contain `pgdata/**`;
- legacy restores adopt a current root manifest during staging, so restored
  roots satisfy the same open-time root gate as newly bootstrapped roots;
- C archive restore now accepts the same root-level metadata paths, keeping the
  archive shape compatible with the C ABI boundary.

## React Native Package-Size Report Parity

React Native now exposes the same package-size evidence as the platform SDKs
instead of merely preserving the TSV inside app artifacts:

- the TypeScript SDK exposes `Oliphaunt.packageSizeReport(...)` with a typed
  `PackageSizeReport`/`ExtensionSizeReport` shape;
- RN Android delegates report lookup to `OliphauntAndroid.packageSizeReport(...)`,
  including a Kotlin SDK resource-root overload for local unpacked package
  smoke tests;
- RN iOS delegates report lookup to `OliphauntRuntimeResources.packageSizeReport()`
  through the existing Swift adapter;
- SDK parity checks, RN unit tests, Android boundary tests, and generated API
  surface docs now guard the public report API and platform delegation.

## Native Extended-Protocol Recovery Regression

The native SQL regression now exercises raw extended protocol error recovery
across every mode that the env-gated test can open:

- a failing `Parse` request must return an `ErrorResponse` followed by
  `ReadyForQuery`, and the same session must accept a normal query afterward;
- a valid named prepared statement is kept alive across a failing `Bind` with an
  invalid integer parameter;
- the same prepared statement is then rebound and executed successfully,
  proving direct, broker, and server paths recover without losing the physical
  session or desynchronizing the PostgreSQL frontend/backend protocol.

## Native Privilege, Utility, And Lock Regression

The native SQL regression now also covers more PostgreSQL behavior that has to
work identically through direct, broker, and server modes:

- role creation, `SET ROLE`, schema/table grants, and structured `42501`
  privilege errors for disallowed writes;
- SQL-language functions over composite table rows;
- post-error session reuse after a privilege failure;
- standalone `VACUUM` and `ANALYZE` utility commands;
- transactional table locks plus session advisory lock/unlock behavior.

## Native Broker Root Metadata Recovery

Broker-mode root metadata now has explicit PGDATA-version recovery coverage:

- a broker-opened persistent root records `pgdataVersion=18` in
  `manifest.properties`;
- corrupting that manifest to claim `pgdataVersion=17` is rejected before the
  helper reopens the root;
- restoring the valid manifest lets the same broker path reopen the root and
  read previously committed data, proving failed metadata validation does not
  leave the root unusable.

## Native Performance Evidence Classification

The native benchmark matrix now classifies benchmark plans before running
expensive work:

- default direct/broker/server and rtt/speed/streaming/prepared runs are marked
  `releaseEvidence=1` only when they meet the release minimums: 100 RTT samples,
  10 RTT repeats, 25,000 prepared-update rows, 10 prepared repeats, and 20 speed
  repeats;
- quick all-mode runs are marked as diagnostic but not partial, so maintainers
  can use them for plumbing checks without mistaking them for release evidence;
- focused runs are marked `partialReport=1` and `diagnosticRun=1`;
- the no-build perf harness verifies these classifications through
  `--plan-only`, so the evidence contract is checked without rebuilding or
  running the full matrix.

## Native Performance Report Release Gate

The native perf report validator now rejects weak evidence by default:

- `tools/perf/check-native-perf-report.sh` passes
  `--require-release-evidence` to the provenance verifier;
- release verification requires `releaseEvidence=true`, `partialReport=false`,
  `diagnosticRun=false`, all native engines, all benchmark suites, SQLite and
  prepared-update controls, and counts at or above the recorded release
  minimums;
- focused diagnostic reports can still verify source/artifact provenance with
  `OLIPHAUNT_PERF_ALLOW_DIAGNOSTIC=1`, but that path is explicitly not
  release evidence;
- the no-build perf harness creates temporary release and diagnostic provenance
  fixtures and proves the strict verifier accepts only the release fixture.

## Kotlin Native-Direct Owner Thread Tightening

Kotlin direct runtimes now route every handle-bound native call through the
dedicated owner thread:

- Kotlin/Native capabilities are serialized through the same owner dispatcher
  and execution mutex as raw protocol, streaming, backup, and close;
- Android JNI opens the backend on the session's single-thread dispatcher
  instead of opening on the caller coroutine and only moving later work;
- Android capability reads also run on that dispatcher, leaving only
  out-of-band cancellation outside the owner queue;
- Android native-direct session backup now rejects unsupported formats before
  crossing JNI, matching Kotlin/Native's defensive session boundary.

## React Native Exact-Extension Bridge Validation

React Native native adapters now preserve extension validation instead of
silently dropping malformed bridge values:

- iOS rejects non-array or non-string `extensions` before opening through
  `Oliphaunt`;
- Android rejects non-array or non-string `extensions` before opening
  through `OliphauntAndroid`;
- the SDK parity guard rejects the previous lossy `compactMap`/nullable
  `getString` patterns.

## React Native Startup Identity Bridge Validation

React Native native adapters now validate startup identity before platform SDK
open calls:

- iOS preserves empty `username`/`database` values instead of converting them to
  `nil` and falling back to `postgres`;
- iOS and Android reject blank or NUL-containing startup identity at the native
  adapter boundary before opening through Swift or Kotlin;
- the SDK parity guard checks that the native adapters keep those bridge
  validations in place.

## React Native Scalar Config Bridge Validation

React Native native adapters now reject malformed scalar config values instead
of treating them as omitted:

- iOS no longer uses a lossy optional string cast for open/runtime resource
  fields;
- iOS rejects blank `resourceRoot`/`iosResourceRoot` before falling back to
  bundled resources;
- Android rejects non-string scalar values with an explicit bridge error before
  opening through `OliphauntAndroid`;
- the SDK parity guard rejects the previous lossy Swift cast pattern and checks
  scalar validation in both native adapters.

## React Native Native Override Path Validation

React Native now rejects malformed native override paths before they can suppress
default native resolution:

- TypeScript rejects blank or NUL-containing `libraryPath`, `runtimeDirectory`,
  and open-time `resourceRoot` before crossing the TurboModule boundary;
- restore validates `libraryPath` before forwarding the C ABI override;
- iOS and Android adapters repeat the same blank/NUL checks at the native bridge
  boundary so direct native calls cannot bypass the JS guard.

## SDK Root Path NUL Validation

Rust, Swift, Kotlin, and React Native now reject NUL-containing database roots
before filesystem work, platform engine calls, TurboModule calls, or C ABI
conversion:

- Rust validates persistent open roots before native runtime selection and
  restore target roots before physical archive unpack;
- Swift validates file URL roots for `OliphauntDatabase` and the native direct
  engine before open/restore work reaches the C bridge;
- Kotlin validates common open/restore roots and repeats the guard in native and
  Android direct engines;
- React Native validates open/restore roots in TypeScript and Android native
  adapter code, while the iOS adapter routes path values through the same
  NUL-aware helper used for native override paths.

## Rust SDK Direct Session And Extension Manifest Guardrails

The Rust SDK now rejects two malformed native-product inputs before they reach
runtime, filesystem, or extension packaging work:

- `NativeDirect` and `NativeBroker` accept exactly one logical client session;
  requesting zero sessions now fails at `OpenConfig::validate`, and requesting
  more than one still returns the explicit unsupported-session error;
- Rust SDK-owned `initdb`, broker helper, and server executable paths reject
  empty or NUL-containing values before process startup;
- static and signed-dynamic extension manifest paths reject embedded NUL
  bytes during config validation, and direct manifest loading rejects the same
  malformed paths before attempting any filesystem read.

## React Native JSI Transport Selection

React Native now has a real TypeScript-side fast-path selector for raw protocol
bytes:

- the public `execProtocolRaw` API probes the versioned
  `globalThis.__oliphauntReactNativeJsi` host transport and sends `Uint8Array`
  requests without base64 when it is installed;
- capability normalization reports `rawProtocolTransport = "jsi-array-buffer"`
  for opened handles and supported-mode discovery when that host transport is
  available;
- the Codegen TurboModule no longer exposes base64 binary methods; protocol,
  backup, and restore bytes require the JSI transport, and tests reject missing
  or non-binary host transports before native sessions are used;
- the iOS adapter exposes an `NSData` raw-protocol handoff into `Oliphaunt`,
  and the Android adapter exposes a `ByteArray` handoff into the Kotlin SDK
  session, so the native JSI installer can avoid base64 without creating a
  private React Native database runtime.

## React Native Native JSI Installers

React Native New Architecture builds now install the high-throughput
`jsi-array-buffer` transport on both native platforms:

- iOS implements `RCTTurboModuleWithJSIBindings`, installs
  `globalThis.__oliphauntReactNativeJsi`, accepts ArrayBuffer/typed-array
  requests, and resolves promises with ArrayBuffer responses from the Swift
  `Oliphaunt` adapter;
- Android implements `TurboModuleWithJSIBindings`, builds a small
  ReactAndroid Prefab C++/JNI library, accepts ArrayBuffer/typed-array
  requests, and resolves promises through the Kotlin SDK
  `OliphauntDatabase.execProtocolRaw` byte-array hook;
- the React Native package check generates the real iOS Codegen header and
  syntax-checks the `RCT_NEW_ARCH_ENABLED` Objective-C++ path, builds the
  Android C++ JSI installer through the selected debug ABI matrix, and still
  rejects any duplicate React Native Android native database runtime.

## React Native Binary Transport Guard

React Native now treats Codegen as lifecycle/control glue only and enforces the
JSI binary path in validation:

- `src/sdks/react-native/tools/check-sdk.sh` fails if `execProtocolRaw`,
  streaming, backup, or restore byte methods are added to the TurboModule
  Codegen spec;
- the same check rejects base64, `atob`/`btoa`, or Node `Buffer` binary
  conversion in React Native runtime source;
- PostgreSQL protocol, backup, and restore traffic therefore remain on the
  versioned JSI `ArrayBuffer` transport while `open`, `close`, `cancel`,
  `capabilities`, mode discovery, and package-size reporting keep the official
  TurboModule Codegen surface.

## SDK Package Artifact Checks

Every native SDK lane now has a fast package-surface check before broader
release publishing:

- Rust records and verifies `cargo package -p oliphaunt --list`, requiring
  the public SDK sources/tests and rejecting product-external generated trees;
- Swift archives a sanitized SwiftPM source package from a scratch copy,
  verifies `Package.swift`, podspecs, C bridge, Swift sources, and tests are
  present, and rejects generated `.build`/`.swiftpm` content;
- Kotlin assembles the Multiplatform metadata/source jars, JVM jar, Android
  release AAR, and macOS/native source jar, then verifies common/platform API
  files, metadata linkdata, JVM unavailable-runtime classes, selected Android
  JNI adapter ABIs, and absence of bundled PostgreSQL runtime binaries by
  default;
- React Native already inspects `npm pack --dry-run --json`, so the SDK parity
  gate now requires all four package artifact checks to remain in place.

## SDK README Example Coverage

The SDK parity gate now mechanically links public README code examples to
compiled or tested SDK coverage:

- Rust, Swift, Kotlin, and React Native README code blocks carry
  `liboliphaunt-doc-example:<id>` markers;
- `tools/policy/check-sdk-doc-examples.mjs` rejects unmarked Rust/Swift/Kotlin/
  TypeScript README examples, duplicate IDs, stale coverage markers, and
  examples without SDK test/source coverage;
- the current coverage set includes Rust backup/restore and typed-query
  examples, Swift open/raw/streaming/typed/parameterized examples, Kotlin
  Android-open/streaming/typed/parameterized examples, and React Native
  open/query plus parameterized query examples.

## Android Fast ABI Validation

Android SDK validation now supports a shared Gradle ABI filter for the Kotlin
SDK, React Native adapter, and delegated Kotlin runtime:

- `src/sdks/react-native/tools/check-sdk.sh` defaults Android Gradle/CMake work
  to one ABI selected from the host CPU for fast local iteration;
- `src/sdks/kotlin/tools/check-sdk.sh` uses the same default for Kotlin Android
  validation;
- `OLIPHAUNT_REACT_NATIVE_ANDROID_ABI_FILTERS=all` or
  `OLIPHAUNT_KOTLIN_ANDROID_ABI_FILTERS=all` restores full ABI coverage;
- comma-separated subsets are forwarded as
  `-PoliphauntAndroidAbiFilters=...`, and both
  `src/sdks/react-native/android` and `src/sdks/kotlin/oliphaunt` validate the
  same supported ABI set.

## React Native JSI Argument Hardening

The React Native New Architecture transport now validates numeric JSI arguments
before crossing into Swift or Kotlin:

- iOS and Android reject non-finite, fractional, negative, or unsafe database
  handles before native handle casts;
- typed-array `byteOffset` and `byteLength` values are checked as
  non-negative integers before copying protocol, backup, or restore bytes;
- the React Native SDK check guards both native JSI installers for these
  validations, and the Android boundary test asserts the same invariant for the
  Kotlin-backed adapter.

## React Native Installed-App Smoke Entrypoint

React Native now ships a reusable app/device smoke runner instead of leaving
each app to invent its own native-boundary test:

- `runInstalledOliphauntReactNativeSmoke(...)` uses the installed package singleton,
  so it proves the app's TurboModule/JSI installation path rather than a mock
  client;
- the smoke opens a delegated Swift/Kotlin SDK session, checks the expected
  engine and `jsi-array-buffer` transport, runs `SELECT 1`, runs a parameterized
  query, optionally requires packaged resource-size evidence, records JS timer
  progress, and always closes the database;
- the pure `runOliphauntReactNativeSmoke(client, ...)` form is covered by the
  React Native TypeScript tests, while the remaining release gap is wiring that
  installed-app runner into iOS simulator/device and Android emulator/device CI
  jobs with real packaged `liboliphaunt` runtime resources.

## Native Direct Reopen Capability

The SDKs now publish reopenability as an explicit capability instead of letting
apps infer it from process isolation:

- Rust `EngineCapabilities`, Swift `OliphauntCapabilities`, Kotlin
  `EngineCapabilities`, and React Native `EngineCapabilities` all expose
  `reopenable`;
- `NativeDirect` reports `false` because the embedded PostgreSQL backend is a
  process-lifetime direct session, while `NativeBroker` and `NativeServer`
  report `true`;
- a local C-core experiment removed the process-spent guard and crashed on the
  second same-process direct open in PostgreSQL relation/storage startup, which
  shows this is not an fd-table-only reset problem. Broker/server remain the
  robust close/reopen paths.

## Expo Android Installed-App Smoke Harness

React Native now has a repeatable real-app Android validation path instead of
only package-level checks:

- `src/sdks/react-native/examples/expo` is an Expo SDK 56 development-build
  app pinned to React Native 0.85 and the local packed
  `@oliphaunt/react-native` SDK, and its app smoke now calls the installed
  package runner directly before attaching the example's CRUD/perf workload via
  the same live NativeDirect session;
- `src/sdks/react-native/tools/expo-android-runner.sh` packs the RN SDK when
  sources changed, installs the tarball into the example, packages Android
  `liboliphaunt.so` plus runtime/template PGDATA assets, builds the dev-client
  APK, launches it through the Expo development-client deep link, waits for
  `OLIPHAUNT_EXPO_SMOKE_PASS`, and prints APK/package size plus Android
  PSS/RSS;
- the smoke generates the ignored Expo `android/` project on demand, so a clean
  checkout does not need committed native project output before app-level
  validation can run;
- `pnpm --dir src/sdks/react-native/examples/expo run smoke:android` exposes the same
  installed-app gate as a named validation lane, and SDK parity checks require
  the harness, docs, example command, and machine-readable pass signal to stay
  present;
- the installed app has validated the New Architecture JSI `ArrayBuffer`
  transport, delegated Kotlin runtime path, `SELECT 1`, parameterized query,
  100-row transaction insert, select p90, package-size reporting, and JS timer
  liveness on an Android emulator.

## Expo iOS And MCP Smoke Harness

React Native now has the matching iOS app-level validation scaffold and local
Expo MCP tool path:

- `src/sdks/react-native/tools/expo-ios-runner.sh` packages the RN SDK with an
  iOS `oliphaunt/` resource bundle, accepts only an iOS
  XCFramework/framework or an iOS/iOS-simulator dylib, and rejects macOS
  `liboliphaunt.dylib` artifacts before CocoaPods/Xcode work starts;
- the iOS harness patches only the ignored generated Expo `ios/Podfile` to use
  local `COliphaunt` and `Oliphaunt` pods, runs `pod install`, builds the
  dev-client app, and can launch a booted simulator to wait for
  `OLIPHAUNT_EXPO_SMOKE_PASS`;
- `OLIPHAUNT_EXPO_IOS_BUILD_ONLY=1` keeps the harness useful on machines where
  CoreSimulator is unavailable, while still validating generated-spec,
  CocoaPods, Swift SDK, resource bundle, and Xcode integration;
- the React Native iOS Swift adapter now discovers bundled `liboliphaunt` from the
  packaged resource root or app frameworks when `libraryPath` is not supplied,
  so app developers do not need host-environment library overrides for normal
  packaged builds;
- `src/sdks/react-native/examples/expo` installs `expo-mcp` and exposes
  `npm run mcp:start`, which runs
  `EXPO_UNSTABLE_MCP_SERVER=1 expo start --dev-client` for Codex/MCP-driven
  local logs, DevTools, screenshots, and automation.

## Apple Mobile Template-Only Bootstrap Guard

The C layer now enforces the mobile bootstrap model before the full iOS
PostgreSQL artifact lane exists:

- `src/runtimes/liboliphaunt/native/src/liboliphaunt_bootstrap.c` compiles out the `fork`/`exec` initdb
  path on Apple mobile platforms and returns an actionable error when PGDATA has
  no `PG_VERSION`;
- macOS keeps the direct `initdb` tooling fallback, so desktop smoke and local
  native iteration continue to work from an empty PGDATA root;
- `src/runtimes/liboliphaunt/native/tools/run-host-c-smoke.mjs --abi-only` now
  performs a fast iOS simulator syntax check over the liboliphaunt C shim files,
  catching forbidden mobile C APIs without rebuilding PostgreSQL for iOS.

## React Native Chunked JSI Streaming

React Native no longer advertises streaming based on the raw owned-response
transport alone:

- the TypeScript transport reports `protocolStream=true` only when the installed
  versioned JSI transport exposes `execProtocolStream`;
- iOS installs an `execProtocolStream` host function that delegates to
  `OliphauntCore.execProtocolStream` and calls the JS chunk callback for each
  native chunk;
- Android installs the same host function through JNI, delegates to
  `OliphauntDatabase.execProtocolStream`, and keeps stream completion separate from
  chunk emission;
- package tests cover native chunk use, malformed chunks, and JS chunk callback
  failures, while Android boundary tests keep the Kotlin and C++ JSI stream
  hooks present.

## Native Regression Coverage Expansion

The native regression backlog now has concrete coverage instead of a product
placeholder:

- `src/sdks/rust/tests/native_sql_regression.rs` runs a broader curated
  PostgreSQL suite across `NativeDirect`, `NativeBroker`, and `NativeServer`
  when native artifacts are available, covering domains, enums, generated
  columns, deferrable uniqueness, foreign keys, JSONB, range types, recursive
  CTEs, window functions, lateral joins, partial expression indexes, `MERGE`,
  privileges, utility commands, table locks, advisory locks, COPY success,
  COPY input errors, COPY fail recovery, streaming `COPY TO STDOUT`, extended
  protocol parse/bind error recovery, and post-error session reuse;
- `src/sdks/rust/tests/protocol_parser_fuzz.rs` adds deterministic
  fuzz-style corpora for backend query response parsing, mutated valid backend
  frames, and frontend simple-query request construction, proving parser paths
  return structured errors instead of panicking on malformed bytes;
- `src/sdks/rust/tests/sdk_shape.rs` now has optional native-server
  compatibility smokes for `tokio-postgres` prepared/pipelined clients and
  `pg_dump`, alongside the existing SQLx pool and `psql` checks. These tests
  skip cleanly when the native artifact or matching PostgreSQL tools are absent.

## Runtime Footprint Profiles And Startup GUC Overrides

Rust, Swift, Kotlin, and React Native now expose the same startup-tuning shape:

- Rust adds `RuntimeFootprintProfile`, `PostgresStartupGuc`, builder
  `runtime_footprint(...)`, and builder `startup_guc(...)`/`startup_gucs(...)`;
- direct and broker pass profile/durability/explicit GUCs through the existing
  C ABI startup-arg vector, while broker forwards them to helper restarts and
  server mode preserves its `max_client_sessions` contract as `max_connections`;
- Swift, Kotlin, and React Native expose matching profile and startup-GUC
  configuration, validate names/values before native open, and default mobile
  SDK opens to `balanced` durability with the `balancedMobile` footprint;
- docs now describe the throughput, balanced-mobile, and small-mobile profiles
  plus the override precedence for benchmark matrices.

The native perf harness now accepts the same tuning shape:

- `oliphaunt-perf native-liboliphaunt` and `oliphaunt-perf native-postgres` accept
  `--runtime-footprint` and repeatable `--startup-guc name=value`;
- native benchmark JSON includes `nativeTuning` with profile, explicit
  overrides, SDK startup assignments, and native-PostgreSQL control assignments;
- the release matrix script records profile/GUCs in its plan, provenance, and
  markdown summary, and forwards the tuning to direct, broker, server, prepared,
  streaming, and native-PostgreSQL control runs;
- Expo Android/iOS smoke and benchmark harnesses forward durability, runtime
  footprint, and startup GUCs through Metro env and dev-client links;
- `tools/perf/matrix/run_mobile_footprint_matrix.sh` enumerates the requested
  Android/iOS shared-buffer, WAL-buffer, WAL-minimum, and Safe/Balanced device
  sweep. It skips `min_wal_size=8MB/16MB` by default because the current PG18
  artifact uses 16MB WAL segments and PostgreSQL rejects those GUC-only minima.

## Explicit Lifecycle Capability Vocabulary

The SDK contract no longer relies on a single ambiguous `reopenable` boolean:

- Rust `EngineCapabilities` now exposes `same_root_logical_reopen`,
  `root_switchable`, and `crash_restartable`;
- Swift, Kotlin, and React Native expose matching camelCase fields in their
  capability structs/dictionaries;
- native direct reports same-root resident logical reopen only, with
  `rootSwitchable=false` and `crashRestartable=false`;
- broker reports process isolation, root-switchability, and helper
  crash-restartability; server reports root-switchability but no in-place
  crash restart for the current SDK-owned server handle;
- SDK tests and docs assert these semantics so mobile callers do not infer crash
  isolation from direct-mode logical close/reopen.

## Exact Extension Packaging Recipes

Public extension and SDK docs now describe exact-extension packaging without a
pack/group concept:

- `src/docs/content/reference/extensions.md` documents Rust runtime-resource generation,
  prebuilt third-party artifacts, mobile static registry generation, package
  size reports, and exact selected extension manifests;
- the Swift README documents `COliphaunt`/`Oliphaunt` CocoaPods resource
  packaging, selected iOS extension XCFramework placement, and link-time
  failure for missing selected modules;
- the Kotlin README documents Android runtime resources, `jniLibs`, selected
  extension archives, and `liboliphaunt_extensions.so` generation;
- the React Native README documents that RN delegates extension packaging to
  Swift/Kotlin, does not ship native runtime or extension assets implicitly,
  and uses the same exact SQL extension names as the platform SDKs.
