# Done (Maintainers)

This is the single status document for implementation work already completed.
It is maintainer-facing and intentionally separate from the end-user docs.

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

- root `pglite-oxide` crate remains the public crate;
- `pglite-oxide-assets` is the published runtime asset crate skeleton;
- source-only target AOT crate templates exist under `crates/aot/*`;
- `xtask` owns source checks, build orchestration, packaging, manifest checks,
  package sizing, upstream audits, and source-spine validation;
- upstream checkouts are no longer tracked; maintainers fetch pinned sources on
  demand into ignored `assets/checkouts`;
- source pins live in `assets/sources.toml`;
- root packages exclude upstream checkouts from published crates.
- `xtask assets verify-committed` validates source-controlled asset inputs,
  source pins, package metadata, AOT crate templates, and generated extension
  coherence when generated manifests are installed, without local upstream
  checkouts;

Generated release asset set:

- portable PGlite WASIX runtime archive;
- `pg_dump.wasix.wasm`;
- deterministic `.tar.zst` archives for the 37 requested extension build
  candidates. All 37 packaged extensions are stable public constants after
  direct, server, restart, and lifecycle materialization gates;
- prepopulated PGDATA template archive;
- native Wasmer LLVM AOT artifacts.

These artifacts are generated locally under `target/pglite-oxide/**` or by the
Assets workflow and are consumed by release staging without being committed to
git.

## Source And Build Spine

Implemented:

- active source baseline switched to `electric-sql/postgres-pglite`
  `REL_17_5-pglite` at `01792c31a62b7045eb22e93d7dad022bb64b1184`, matching
  the audited `@electric-sql/pglite` 0.4.5 source/artifact pair;
- `pglite-build` `portable` is pinned as build-script provenance;
- maintained WASIX build files live under `assets/wasix-build`;
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
  embedded-backend `pgl_initdb` path was removed; explicit fresh-initdb paths
  now use the bundled split WASIX `initdb` command and remain outside the
  default fast path;
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
  pglite-oxide uses the same C exports. Server connections now open the
  embedded backend against the startup packet database, apply client startup
  options on the C side, and apply non-`postgres` users through PostgreSQL
  `SET ROLE` semantics, matching PGlite's single-process identity model;
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
  are accepted as legal protocol output; split WASIX `initdb` is now the owned
  template-generation path instead of resurrecting the old builder wrapper.

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

- `PgliteBuilder::extension`;
- `PgliteBuilder::extensions`;
- `PgliteBuilder::username`;
- `PgliteBuilder::database`;
- `PgliteBuilder::debug_level`;
- `PgliteBuilder::relaxed_durability`;
- `PgliteBuilder::startup_arg`;
- `PgliteBuilder::startup_args`;
- `PgliteBuilder::load_data_dir_archive`;
- `Pglite::enable_extension`;
- `Pglite::preload`;
- `Pglite::preload_extensions`;
- `Pglite::dump_data_dir`;
- `Pglite::dump_data_dir_with_format`;
- `Pglite::try_clone`;
- physical PGDATA archives now apply Wasmer overlay whiteouts, so files deleted
  from the lower template are not resurrected by dump/load/clone;
- physical PGDATA archives are written from a materialized effective PGDATA view
  instead of directly mixing lower-template and upper-overlay entries in the tar
  writer;
- physical PGDATA archive/clone now checkpoints, quiesces the backend,
  materializes the archive, and restarts the same backend session; docs state
  this is a same-runtime/same-version physical import/export path, not a
  cross-version backup protocol;
- `Pglite::exec_protocol_raw`;
- `Pglite::exec_protocol_raw_stream`;
- `Pglite::dump_sql`;
- `Pglite::dump_bytes`;
- `PgliteServerBuilder::extension`;
- `PgliteServerBuilder::extensions`;
- `PgliteServerBuilder::username`;
- `PgliteServerBuilder::database`;
- `PgliteServerBuilder::debug_level`;
- `PgliteServerBuilder::relaxed_durability`;
- `PgliteServerBuilder::startup_arg`;
- `PgliteServerBuilder::startup_args`;
- `PgliteServer::database_url`;
- `PgliteServer::dump_sql`;
- `PgliteServer::dump_bytes`;
- `PgDumpOptions`;
- 37 public extension constants plus `extensions::ALL`, covering the smoke-gated
  packaged PGlite/Postgres catalog: `amcheck`, `auto_explain`, `bloom`,
  `age`, `btree_gin`, `btree_gist`, `citext`, `cube`, `dict_int`, `dict_xsyn`,
  `earthdistance`, `file_fdw`, `fuzzystrmatch`, `hstore`, `intarray`, `isn`,
  `lo`, `ltree`, `pageinspect`, `pg_buffercache`, `pg_freespacemap`,
  `pg_hashids`, `pg_ivm`, `pg_surgery`, `pg_textsearch`, `pg_trgm`,
  `pg_uuidv7`, `pg_visibility`, `pg_walinspect`, SQL-only `pgtap`, `seg`,
  `tablefunc`, `tcn`, `tsm_system_rows`, `tsm_system_time`, `unaccent`, and
  `vector`.

`pglite-dump` no longer exposes the old archive-unpack behavior. It is now a
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
- a larger PostgreSQL regression subset now ports the relevant PGlite test
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
  `PGLITE_OXIDE_AOT_VERIFY=full` while default loading uses metadata receipts
  and mmap/native deserialization;
- PGDATA physical archive/clone materializes the effective overlay view with
  whiteouts, quiesces/restarts the backend, and is documented as
  same-runtime/same-version physical transfer rather than a WAL-aware backup;
- public API parity additions were reviewed: `fresh_temporary()` stayed out,
  raw protocol streaming is real, physical clone/export has honest semantics,
  startup args remain advanced, and listener channel names are identifier
  quoted.

Residual work from this review is intentionally not P0 architecture debt:
target-matrix CI, broader extension generation, additional PostgreSQL
regression subsets, release performance gates, and future split-WASIX `initdb`
support remain tracked in `TODO.md`.

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
- `hstore` direct API, persistence/reopen, and SQLx server smoke coverage;
- PGlite extension tests were ported into a generic promotion gate for direct
  API, server API, restart, and lifecycle materialization. The gate now covers
  every packaged candidate. AGE now uses its upstream 32-bit `SIZEOF_DATUM=4`
  SQL generation path, passes direct/server/restart/lifecycle gates, and is
  exposed as `extensions::AGE`;
- extension discovery now merges PGlite docs/REPL exports, PGlite package
  exports, PostgreSQL contrib metadata, `postgres-pglite` `other_extensions`
  pins, PGlite tests, and the packaged asset manifest into
  `assets/generated/extensions.catalog.json`;
- `xtask assets fetch` now clones/fetches every pinned source from
  `assets/sources.toml` into ignored `assets/checkouts/**` directories,
  including the external extension sources for pgtap, pg_ivm, pg_uuidv7,
  pg_hashids, AGE, PostGIS, and pg_textsearch;
- extension build intent now lives in `assets/extensions.promoted.toml` instead
  of being inferred from already-packaged artifacts. The generated catalog
  separates requested, packaged, stable, and publicly promoted state;
- extension smoke evidence now lives in `assets/extensions.smoke.toml`;
  generated public constants require requested + packaged + stable + direct,
  server, and restart smoke status recorded as passed;
- `xtask extensions build-plan --write` generates
  `assets/generated/extensions.build-plan.json`,
  `assets/generated/contrib-build.tsv`, and
  `assets/generated/pgxs-build.tsv`; `xtask assets check --strict-generated`
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
  and packaged all requested extension archives into `pglite-oxide-assets`;
- contrib packaging now carries extension-owned tsearch rule files into
  `share/postgresql/tsearch_data`, matching PGlite behavior for `dict_xsyn` and
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
  `PgliteServer`, dumps plain SQL, restores into fresh `Pglite`, and verifies
  schema/data;
- direct `Pglite::dump_sql` no longer uses a temporary physical clone, public
  `PgliteServer`, or OS loopback TCP; it runs the standalone WASIX `pg_dump`
  against an in-process Wasmer virtual TCP connection whose host side is routed
  through the same direct raw-protocol backend;
- direct `Pglite::dump_sql` rejects database/user options that would imply a
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

The public `pg_dump` round-trip tests and asset/AOT hash-mismatch tests also
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
- side-module seeding is reused by artifact name, module hash, Wasmer version,
  Wasmer-WASIX version, and engine identity;
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
- an eager PGDATA template overlay is implemented as the mainline template
  path: the cached initialized template is mounted as lower `/base`, the
  per-instance upper starts almost empty, and individual template files are
  copied into the upper only before mutating opens;
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
- `PgliteBuilder::postgres_config`, `PgliteServerBuilder::postgres_config`,
  and `pglite-proxy --postgres-config name=value` now pass user startup GUCs
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

Latest local debug `cargo run -p xtask -- perf cold` run after the shared
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

Latest local debug `cargo run -p xtask -- perf cold` run after the eager PGDATA
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
- Wasmer LLVM AOT codegen experiments selected the mainline serializer profile:
  nonvolatile memory operations plus a readonly funcref table. Nonvolatile
  memory operations improved the exact PGlite server SQLx speed suite by about
  9% geomean and won all 18 cases, but Wasmer marks that optimization as not
  fully WebAssembly-spec compliant. Adding readonly funcref on top was about
  1.4% faster geomean than nonvolatile-only and improved indexed updates, but
  regressed CREATE INDEX and DROP TABLE cases. The risk is now explicit release
  profile surface and must be covered by the correctness matrix. The macOS
  arm64 packaged AOT artifacts were regenerated with this profile;
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
- prepared indexed-update benchmarking now compares SQLx sequential prepared
  updates, tokio-postgres sequential prepared updates over TCP and Unix
  sockets, tokio-postgres pipelined prepared updates over TCP and Unix sockets,
  and native Postgres equivalents using the exact PGlite Test 9/10 values.
  Deferring extended-protocol `Sync` flush only within bytes already read from
  one socket read reduced PgliteServer TCP pipelined prepared updates from about
  `612.835ms -> 399.921ms` for numeric indexed updates and
  `640.691ms -> 416.837ms` for text indexed updates. Unix-socket PgliteServer
  was faster again at about 374/397ms, so transport still matters for
  sequential prepared execution and modestly for pipelined execution. The exact
  simple-query server speed suite stayed in the same range after the change:
  Test 9 about 583ms and Test 10 about 740ms locally. A larger 256KiB proxy
  read buffer was tested and rejected because it regressed the same pipelined
  prepared workload to about 545/562ms;
- the native Postgres benchmark helper now attempts graceful termination before
  falling back to `Child::kill()`, because SIGKILL can leak SysV shared-memory
  IDs on macOS. `perf prepared-updates --skip-native` exists for Pglite-only
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
- Wasmer AOT loading now uses the native mmapped-file deserializer as the only
  production path; the old file deserializer runtime switch was removed;
- after promoting the mainline AOT and filesystem paths, local release
  `cargo run --release -p xtask -- perf cold` showed primary visible latencies
  around 36ms for preload, 55ms for a new temporary direct first query, 45ms
  for a second new temporary direct first query, 47ms for server SQLx first
  query, and 57ms for server SQLx vector first query;
- the same mainline artifact profile measured exact PGlite server speed-suite
  Test 9 at about 587ms, Test 10 at about 730ms, Test 11 at about 91ms, Test 14
  at about 71ms, and 18-test geomean around 76ms locally. Prepared-update
  server probes measured TCP pipelined prepared updates around 395/414ms and
  Unix pipelined prepared updates around 366/392ms for the numeric/text indexed
  workloads;
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
  module seeding, and public `pg_dump` runner phases;
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

## CI/CD And Release Workflow

- validation now uses a DRY `scripts/validate.sh` entrypoint with explicit
  modes for repository hygiene, linting, tests, examples, package checks, and
  release dry-runs;
- CI classifies changed paths through `scripts/ci-scope.sh` so docs-only,
  CI-only, test-only, package-affecting, and asset-affecting PRs can run the
  right checks without forcing every maintainer change through release work;
- release intent checks now focus on published package surfaces
  (`Cargo.toml`, `build.rs`, `src/**`, and `crates/**`) instead of forcing
  docs, tests, examples, xtask-only, or source-build-script maintenance to use
  release-producing PR titles;
- the manual Release workflow keeps the three maintainer operations:
  `prepare-release-pr`, `publish-dry-run`, and `publish`, with job-scoped
  permissions and Trusted Publishing through `id-token: write`;
- release-plz remains the release owner with one root changelog, one version
  group, exact internal dependency versions, internal asset/AOT changes folded
  into the root release notes, and bare SemVer tags for the user-facing root
  release;
- the Assets workflow now uses production build inputs under
  `assets/wasix-build`, the `release-o3` profile, one Linux/Docker portable
  WASIX build job, and native AOT matrix jobs for macOS, Linux, and Windows;
- the portable WASIX build in the Assets workflow is now the artifact producer:
  it builds generated runtime assets under `target/pglite-oxide/assets`, uploads
  them with provenance, and feeds native AOT matrix jobs;
- normal CI now has a Rust-only native AOT runtime matrix that downloads the
  latest compatible Assets workflow bundle, verifies the asset-input
  fingerprint, installs generated artifacts into ignored paths, and runs the
  runtime test suite on macOS arm/x64, Linux arm/x64, and Windows x64;
- asset and AOT crates are source-only in git; release jobs download generated
  portable and AOT workflow artifacts for the exact SHA, stage them into crate
  skeletons, package-check that generated workspace, and publish with
  release-plz dirty-publish support;
- dependency invariant checks now block Wasmtime/static-WASI regressions and
  backend compiler crates such as LLVM/Cranelift/Singlepass from entering the
  normal user dependency tree;
- the public dependency graph now uses Cargo target-specific dependencies for
  AOT packs, so a normal `pglite-oxide` install resolves the target-independent
  `pglite-oxide-assets` crate plus only the current platform's
  `pglite-oxide-aot-*` crate;
- source-only `scripts/validate.sh test` no longer pretends runtime coverage
  happened when AOT artifacts are absent. `scripts/validate.sh runtime` is now
  the hard runtime gate and requires portable assets plus the host AOT pack;
- `.github/scripts/download-aot-artifacts.sh` is a thin wrapper over
  `xtask assets download`; exact-SHA, latest-compatible, host-target, and
  all-target artifact downloads share one implementation;
- AOT serialization is now owned by a maintainer-only `xtask` feature. The
  normal runtime tree keeps headless Wasmer loading, while
  `xtask --features aot-serializer` is the only path that enables Wasmer LLVM;
- the Assets workflow now probes the LLVM AOT serializer before full AOT
  generation, validates generated portable assets before AOT work, smokes the
  target runtime before packaging/upload, and fails on empty/missing AOT
  manifests instead of uploading placeholder crates;
- `wasmer-wasix` is now explicitly feature-minimized for the runtime path
  (`sys-minimal`, `sys-poll`, `host-vnet`, and `time`). The root dependency gate
  rejects Wasmtime, backend compiler crates, Cranelift/Singlepass, LLVM, and
  broad HTTP/TLS stacks such as `reqwest`, `hyper`, and `rustls`;
- normal CI cache writes are limited to `main` while PRs still restore existing
  Rust caches. Release and AOT-heavy jobs opt into cache writes explicitly.
