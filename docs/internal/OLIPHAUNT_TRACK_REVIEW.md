# liboliphaunt Track Review

Date: 2026-05-16

## Executive Summary

The native track is directionally correct: `liboliphaunt` is the C boundary over
PostgreSQL 18, `oliphaunt` is the canonical Rust SDK, and the existing
WASIX `oliphaunt-wasix` lane is no longer shaping native architecture decisions.
That separation is the right foundation if the goal is an embedded PostgreSQL
product that can credibly compete with SQLite for application developers.

The current implementation is still not complete enough to market as that
product. The biggest remaining gaps are not API naming or package polish. They
are:

- lifecycle: direct mode is one active embedded PostgreSQL backend per process;
- streaming: native direct has a chunked C ABI, broker forwards chunks over IPC,
  and server forwards PostgreSQL wire messages per frame; large results and
  `COPY TO STDOUT` now have native matrix rows plus a native SQL regression
  proving post-COPY session reuse across direct, broker, and server. The
  source-current full matrix has been refreshed after the latest harness
  changes;
- coverage: we have smoke and selected SQL regression coverage, not a
  PostgreSQL-grade regression matrix;
- benchmarking: direct, broker, server, native PostgreSQL, and SQLite embedded
  are now measured from one reproducible harness with p50/p90/p95, CPU, RSS,
  footprint, artifact-size rows, and source/artifact provenance. The latest
  full source-current matrix passes provenance verification; the remaining
  discipline is to refresh that run after every benchmark harness or runtime
  input change and reject stale reports;
- mobile packaging: Swift and Kotlin/Native now have concrete native-direct
  C ABI runtime paths; React Native has the typed New Architecture package
  shape, and Android now has a content-keyed runtime/template asset lane, but
  final platform artifacts and device distribution are not wired end to end;
- extensions: extensions are opt-in in the Rust model, and the packaged
  PG18 extension matrix now passes install/load, restart, physical backup, and
  physical restore checks across broker/direct-C-ABI and server paths; pgGraph
  and ParadeDB external smokes now also cover core functional queries across
  direct, broker, and server; the C ABI static registry exists and is smoke
  tested, while generated platform registry sources/device packaging and signed
  manifests remain release blockers.

This track pass addressed concrete gaps:

- C `initdb` bootstrap no longer uses `system(3)` or shell quoting. It now
  forks and execs `initdb` directly, preserves stderr for diagnosis, suppresses
  stdout, reports exec/status/signal failures, and avoids command-injection
  classes of bugs.
- Direct native streaming now exists at the C ABI through
  `oliphaunt_exec_protocol_stream`. It drains backend writes into a bounded chunk
  queue with producer backpressure, scans protocol frames incrementally for
  `ReadyForQuery`, and invokes the sink from the caller thread instead of the
  backend thread.
- Broker streaming now uses dedicated IPC stream request/chunk/end frames
  instead of materializing the whole response in the client process.
- Broker IPC now uses Unix-domain sockets by default on Unix platforms, keeping
  the helper-process path off localhost TCP while preserving an explicit TCP
  fallback for portability and debugging.
- Broker IPC now requires a per-session authentication frame before any protocol
  or control request. The SDK generates the token and passes it to the helper
  through the child environment rather than argv.
- Broker startup now propagates the parent bootstrap policy to the helper,
  including `ExistingOnly` and the explicit `initdb` tooling fallback, so the
  helper cannot silently hydrate a root the caller intended to treat as
  pre-existing. Broker shutdown also waits briefly for graceful helper exit
  before falling back to kill.
- Broker capabilities now stay honest: direct mode remains one process-global
  backend, while broker mode supervises one isolated helper per active root.
  A shared broker runtime enforces `.broker_max_roots(n)`, rejects duplicate
  active roots, and reports multi-root capability only when the configured root
  budget is greater than one.
- Broker sessions now retain their helper launch plan and relaunch a fresh
  helper against the same root when the previous helper exits between
  operations. The SDK deliberately does not replay an in-flight request after a
  crash because the request's commit state may be unknown; a caller observes
  that failure and later operations can recover through PostgreSQL WAL recovery.
- The native root/runtime module is split by responsibility: process plus
  filesystem root locking and PGDATA path preparation stay in
  `oliphaunt/root.rs`; runtime-cache discovery
  and materialization are split across `oliphaunt/root/runtime.rs`,
  `oliphaunt/root/runtime/locate.rs`, `oliphaunt/root/runtime/install.rs`, and
  `oliphaunt/root/runtime/cache_key.rs`; deterministic filesystem copying lives
  in `oliphaunt/root/files.rs`; runtime/template cache fingerprinting lives in
  `oliphaunt/root/fingerprint.rs`; and packaged-template PGDATA cache
  construction lives in `oliphaunt/root/template.rs`.
- Selected extension asset materialization now lives in
  `oliphaunt/root/extensions.rs`, including SQL/control file selection, data
  files, module-file sets, and the filters that hide unselected extension
  assets from materialized runtime trees.
- Server mode now streams PostgreSQL wire messages frame-by-frame and returns
  SQL `ErrorResponse` frames as raw protocol bytes instead of converting normal
  SQL errors into Rust execution failures.
- Server mode now separates short connection-attempt timeouts from longer query
  I/O timeouts, so normal work such as `CREATE EXTENSION` is not constrained by
  the retry loop's 250 ms connection probe.
- Server mode now retries auto-assigned localhost ports only when PostgreSQL
  reports a bind conflict during startup. This removes parallel-test and local
  process races without hiding fixed-port failures or unrelated server startup
  errors.
- Server mode now uses a short SDK-owned Unix-domain socket on Unix for
  internal protocol traffic while keeping the public TCP connection string for
  external clients. The raw-wire client also reads backend frames through a
  reusable buffered reader instead of issuing header/body reads and allocating
  body/frame buffers per message.
- The Rust owner executor now uses `crossbeam-channel` for the per-session
  command queue instead of `std::sync::mpsc`, preserving the serialized owner
  thread while reducing direct-mode RTT handoff overhead.
- `liboliphaunt` now exposes `oliphaunt_exec_simple_query` and
  `OLIPHAUNT_CAP_SIMPLE_QUERY` so SDK simple-query calls do not need to build and
  revalidate frontend protocol frames outside the engine. The Rust direct
  engine loads this symbol opportunistically, while broker mode forwards a
  first-class simple-query IPC frame to the helper and lets the helper call the
  same engine hook.
- The C ABI no longer imposes a hard-coded default execution timeout while
  waiting for `ReadyForQuery`. Startup readiness still has a bounded wait, but
  normal owned-response and streaming protocol calls run until PostgreSQL
  completes, exits, closes, or is explicitly canceled. The C smoke harness sets
  the legacy wait-timeout env after startup and proves a `pg_sleep` query still
  succeeds, preventing accidental reintroduction of a synthetic query cap.
- The native performance harness now measures `NativeDirect`, `NativeBroker`,
  and `NativeServer` as distinct SDK modes instead of reporting broker as
  unavailable or using native PostgreSQL control numbers as a substitute.
- Native benchmark matrix runs now write `provenance.json` with SHA-256s for
  benchmark harness sources, `liboliphaunt`/PostgreSQL patch inputs, Rust SDK
  sources, `xtask`, and native artifacts. Product-local perf checks verify a
  retained run directory against the current checkout so stale reports are not
  accidentally treated as current release evidence.
- The native benchmark matrix now records prepared-update rows for
  `NativeDirect`, `NativeBroker`, and `NativeServer`. Each row uses PostgreSQL's
  extended protocol with one named prepared statement and covers both
  sequential Bind/Execute/Sync traffic and a pipelined Bind/Execute batch inside
  one transaction.
- The gated native extension matrix now creates or loads every currently
  release-ready exact extension through broker/direct-C-ABI and server paths, reopens the
  root, takes a physical backup, restores it into a new root, and verifies the
  extension remains visible after restore. The manifest also distinguishes
  SQL-only extensions such as `pgtap` from extensions that require a native
  module.
- The native PostgreSQL build harness now fingerprints extension source trees,
  compiler selection, PostgreSQL patch/build inputs, and `liboliphaunt` C ABI
  sources before rebuilding extension artifacts. Gated extension validation can
  reuse existing normal and embedded module artifacts unless those inputs
  change, with `OLIPHAUNT_FORCE_EXTENSION_REBUILD=1` as the explicit escape
  hatch.
- Repeated native C validation no longer relinks `liboliphaunt.dylib` when the
  edited C ABI sources and PostgreSQL embedded object/archive inputs are
  unchanged. The build harness writes a separate dylib input stamp, verifies
  required exported C ABI symbols before reuse, and exposes
  `OLIPHAUNT_FORCE_RELINK=1` for deliberate relink diagnostics.
- The Rust SDK now exposes `NATIVE_EXTENSION_MANIFEST` as the product manifest
  for supported PG18 extensions. It records each extension's SQL/control asset
  class, native module requirement, dependencies, runtime data files, smoke SQL
  strategy, gated direct-C-ABI/broker/server coverage, and mobile static-link
  status. The gated native extension matrix iterates this manifest directly.
- The C smoke harness now covers ABI version/capability reporting, invalid init
  and invalid exec/stream arguments, malformed frontend frame rejection and
  recovery, normal protocol success, SQL error recovery, large owned responses,
  stream callback delivery, stream callback failure recovery, response cleanup,
  active-query cancellation and recovery, direct C ABI backup/restore,
  malicious archive-entry rejection, symlinked PGDATA backup rejection, caller
  `PGDATA` environment restoration after close, explicit same-process direct
  reopen rejection, and process-bound reopen through a second harness process.
- `liboliphaunt` now exposes out-of-band direct query cancellation through
  `oliphaunt_cancel` and `OLIPHAUNT_CAP_QUERY_CANCEL`. The Rust SDK surfaces this as
  `Oliphaunt::cancel()` backed by an `EngineCancel` handle that bypasses the owner
  queue, so a long-running direct query can be interrupted without waiting
  behind itself.
- Broker and server now preserve that same out-of-band cancellation contract at
  their natural transport layer. Broker mode creates a separate authenticated
  cancel IPC endpoint so cancellation never competes with the busy query stream.
  Server mode captures PostgreSQL startup `BackendKeyData` and sends the native
  CancelRequest packet over a fresh connection to cancel the SDK-owned backend.
- `Oliphaunt::close()` now treats close as a lifecycle boundary rather than a
  cancellation primitive. Once close begins, the executor rejects queued
  non-close work with `EngineStopped`, waits for active work to finish, then
  lets the owner thread close or detach the runtime. Query interruption remains
  explicit through `Oliphaunt::cancel()`.
- The native runtime now has a profile-aware content-keyed runtime cache.
  Direct/broker use liboliphaunt-linked extension modules; server mode uses
  standalone PostgreSQL modules. This fixes the previous server-mode crash caused
  by loading embedded modules into a standalone server while preserving
  opt-in extension isolation.
- Direct liboliphaunt and managed server startup now provide `PGDATA` in the
  backend environment. PostgreSQL itself receives `-D`, but some existing
  extension code, including pgGraph persistence, reads `PGDATA` directly; the
  native runtime now supplies that root and restores the caller's environment
  after the embedded backend exits.
- `liboliphaunt` now exposes `oliphaunt_register_static_extensions` and
  `OLIPHAUNT_CAP_STATIC_EXTENSIONS`. The PostgreSQL `dfmgr` patch resolves
  registered in-binary extension modules through the normal dynamic-loader path,
  validates PostgreSQL magic, calls the registered init hook once, and resolves
  exported SQL-callable C symbols without requiring a module file. The C smoke
  harness registers a fixture extension before `oliphaunt_init` and proves
  `CREATE FUNCTION ... AS 'module', 'symbol' LANGUAGE C` executes through that
  registry.
- The Rust runtime resourcesr now emits a static-registry package alongside
  runtime/template resources. Mobile-ready packages contain
  `static-registry/oliphaunt_static_registry.c`, generated from selected
  extension SQL assets, plus a manifest that records module stems, symbol
  prefixes, and SQL-callable symbols. The generated source exports
  `liboliphaunt_selected_static_extensions`; Swift and Kotlin native bridges look
  up that optional process symbol and register the rows through the loaded
  `oliphaunt_register_static_extensions` symbol before `oliphaunt_init`.
- Extension configuration now fails during `OpenConfig` validation for
  duplicate extension names, empty or non-portable IDs, unsupported extension
  source/loading combinations, and source/loading mismatches.
  This keeps extension packaging mistakes out of runtime materialization.
- `BootstrapStrategy::PackagedTemplate` now materializes a content-keyed base
  PGDATA template and hydrates new roots before entering the engine. Template
  hydration now defaults to physical byte-copy because paired local evidence
  showed better p90 stability than APFS copy-on-write cloning; clone mode
  remains available as an explicit diagnostic setting.
- The speed-case diagnostic harness now supports native liboliphaunt direct for a
  single case per process and native PostgreSQL controls for matched case-level
  diagnosis. The native PostgreSQL control connects to `template1`, matching
  liboliphaunt's current session target, so per-case comparisons no longer mix
  different database targets. Diagnostic output now records the process model
  and key PostgreSQL GUCs, and ad hoc native PostgreSQL diagnostics default to
  the repo's pinned `target/liboliphaunt-pg18/install/bin` tools when present
  instead of accidentally using a different `postgres` on `PATH`.
- The native benchmark matrix has a source-current PostgreSQL 18.4 full local
  run at `target/perf/native-liboliphaunt-20260524T090412Z/report.md` with
  matched `safe` durability for native liboliphaunt, native PostgreSQL, and
  SQLite controls plus strict verified `provenance.json` for that recorded
  source/artifact set. Later backup ABI and tar-writer changes require a new
  full matrix before using the report as current-checkout release evidence.
  Native direct passes
  repeated RTT, open, and RSS gates against the native PostgreSQL control in
  that run; RTT gate p90 is `107 us` versus `112 us` for native PostgreSQL
  tokio, and open p90 is `440.28 ms` versus `576.4 ms`. Native direct still
  misses speed-suite p90 (`2.668 s` versus `2.419 s`), speed tail throughput
  (`0.907x` native PostgreSQL), and physical backup/restore (`0.558 s` versus
  `0.344 s`) against the native PostgreSQL physical-archive control. The matrix uses 10
  fresh-process RTT repeats, 20 fresh-process speed repeats, 10 prepared
  repeats, and 10 backup/restore repeats before classifying evidence as
  release-grade. Direct, broker, server, native PostgreSQL tokio, and SQLite are
  `stable` on that host run. Per-case speed misses in the complete matrix are
  `1`, `2`, `2.1`, `3`, `3.1`, `4`, `5`, `10`, and `13`; isolated repeated
  diagnostics reproduce `1`, `2.1`, `3`, `4`, `10`, and `13`. A focused
  current-source backup diagnostic at
  `target/perf/native-liboliphaunt-20260524Tbackup-final-direct/report.md`
  verifies `oliphaunt_backup_ex` and the current C tar writer, improving direct
  physical backup/restore p90 to `0.534 s` while still missing native
  PostgreSQL physical p90 at `0.324 s`. Against SQLite, direct wins total
  speed-suite p90 but still loses open p90 and RSS by large margins. The streaming section
  includes large row results and `COPY TO STDOUT`, and prepared-update rows
  cover sequential and pipelined extended-protocol traffic across direct,
  broker, server, and native PostgreSQL controls.
- The first source-current full-matrix attempt exposed a server-mode raw
  protocol bug where a large pipelined frontend batch could fill the PostgreSQL
  server's output socket while the SDK was still writing the request.
  `PostgresWireClient` now switches large raw requests to duplex read/write,
  and the full rerun passes with server pipelined prepared p90 at `0.239 s`
  numeric and `0.265 s` text versus native PostgreSQL tokio at `0.288 s` and
  `0.291 s`.
- Direct/server physical backup now uses PostgreSQL's low-level online backup
  API (`pg_backup_start` and `pg_backup_stop`) and writes the generated
  `backup_label`/`tablespace_map` into the physical archive. The implementation
  collects `pg_wal` after backup stop, and the native server smoke restores the
  archive into a new root and reads user data from it. Broker mode forwards the
  same direct physical backup through the helper process. Physical archives are
  explicitly single-root concrete archives: backup fails on non-regular PGDATA
  entries, and restore accepts only regular files and directories under
  `pgdata`. Restore also rejects malformed framing, missing terminators,
  trailing non-zero data, unsupported tar header formats, invalid tar numeric
  and fixed-width string fields, duplicate canonical paths, unexpected link
  metadata, and directory entries with payload bytes. Restore extracts through
  the validated canonical archive path rather than delegating destination
  interpretation to the tar reader, and validates archive tree shape before
  writing staging files in both the Rust SDK and C ABI restore paths. Symlinks,
  hardlinks, FIFOs, sockets, device nodes, sparse/special tar records, external
  tablespaces, and linked WAL directories are rejected. Server mode also
  exposes logical SQL backup through packaged `pg_dump`.
- Restore/import is now a first-class Rust SDK operation through
  `Oliphaunt::restore(RestoreRequest::physical_archive(...))`. It stages restore
  output, rejects archive traversal and unsupported archive entry types,
  validates required recovery files, rejects symlink targets, protects
  existing roots by default, and supports explicit locked replacement. Swift,
  Kotlin, and React Native API shapes mirror the same root-level restore model.
- The native benchmark matrix now includes a file-backed SQLite control via
  rusqlite plus artifact-size rows for `liboliphaunt`, embedded modules, and the
  PostgreSQL install tree.
- Native liboliphaunt benchmark runs now sample child-process RSS for broker and
  server modes from the xtask process tree. RTT, speed, and streaming reports no
  longer have to infer helper/server memory solely from `/usr/bin/time` on the
  parent benchmark process.
- The xtask RSS/process-tree sampler has been extracted to
  `tools/xtask/src/process_rss.rs` with focused unit coverage for descendant
  aggregation and cycle/double-count protection. This keeps benchmark resource
  accounting separate from command orchestration.
- The Swift SDK now includes `OliphauntNativeDirectEngine`, backed by a small
  C bridge that dynamically loads `liboliphaunt` or resolves already-linked C ABI
  symbols. Env-backed Swift tests open a temporary native-direct root, execute
  raw protocol bytes, cancel an active `pg_sleep`, and close through the C ABI.
- The Kotlin SDK now includes a Kotlin/Native `NativeDirectEngine`, backed by a
  small static cinterop bridge that dynamically loads `liboliphaunt`, keeps the
  public API suspend-first, defaults `OliphauntDatabase.open` to native direct on
  Kotlin/Native, runs blocking protocol work off the caller coroutine, exposes
  cancellation outside the serialized execution queue, makes `close()` wait for
  the execution lane before detaching, and recursively cleans temporary roots
  with symlink-safe POSIX tree removal.
- The React Native TurboModule surface now exposes `cancel(handle)` and the
  TypeScript `OliphauntDatabase.close()` path delegates wait-and-detach close to
  the platform SDK, matching the Rust/Swift/Kotlin lifecycle contract at the
  public API layer.
- React Native iOS now delegates its TurboModule implementation to `Oliphaunt`
  through an Objective-C-visible Swift adapter. The Objective-C++ file keeps
  only React Native handle/promise plumbing and New Architecture registration;
  Swift owns open, protocol execution, backup, restore, cancellation, close,
  resource materialization, template hydration, and extension checks.
- React Native Android now delegates its TurboModule implementation through the
  Kotlin SDK `OliphauntAndroid` facade and stores the returned `OliphauntDatabase`
  handle. The package Gradle build includes the local `:oliphaunt`
  project in this repo, falls back to the published Kotlin SDK coordinate for
  packaged app builds, generates the official Codegen TurboModule base class,
  compiles Kotlin, verifies the Kotlin SDK JNI bridge, and exercises synthetic
  runtime/template asset packaging in the verifier. Runtime materialization,
  template hydration, JNI loading, and extension manifest checks are owned
  by the Kotlin SDK instead of duplicated in the RN package. Device validation
  remains blocked on packaged Android `liboliphaunt.so` and real runtime/template
  artifacts.
- Server compatibility coverage now includes real `psql`, `tokio-postgres`
  independent-client, `sqlx` pool, packaged `pg_dump` through SQL backup, and
  persistent close/reopen smoke. Broker coverage now includes `ExistingOnly`
  rejection for empty roots plus persistent close/reopen smoke.
- The Rust SDK now exposes `Oliphaunt::query(sql)` over the native simple-query
  path. The parser keeps the C ABI raw, but gives Rust callers field metadata,
  rows, command tags, null handling, and PostgreSQL `ErrorResponse` propagation
  without asking applications to decode backend protocol frames for ordinary
  one-result-set queries. Multi-result-set and COPY traffic stay on the raw or
  streaming protocol APIs.
- Swift, Kotlin, and React Native now expose the same typed result concept for
  simple SQL and PostgreSQL extended-protocol parameters. Their parsers and
  frontend message builders live in the SDK language layer, not in the C ABI,
  and cover field metadata, rows, command tags, nulls, and SQL errors while
  keeping multi-result-set and COPY traffic on raw protocol APIs.
- The same query layer now exposes `query_params(sql, params)` using
  PostgreSQL's extended protocol. Parameters are encoded into `Parse`/`Bind`/
  `Describe`/`Execute`/`Sync` frames in Rust and then sent through the same raw
  protocol engine path, so the low-level C ABI remains stable while the Rust DX
  gets a safe non-interpolating query API.
- Dropping an unfinished `Transaction` now queues a best-effort `ROLLBACK` on
  the owner executor before releasing the physical-session pin. This prevents a
  Rust lifetime mistake from leaving the single direct/broker backend session
  inside an open SQL transaction and blocking unrelated follow-up work.
- Native SQL regression coverage now lives in `oliphaunt` itself instead
  of depending on the legacy WASIX crate's regression tests. The new
  `native_sql_regression` test runs the same compact PostgreSQL behavior suite
  through direct, broker, and server modes: parameterized inserts, numeric/bool/
  JSONB/bytea/array values, trigger side effects, views, constraint errors,
  savepoint recovery, committed transactions, index-plan checks, and SQL error
  recovery.

## Product Architecture Judgment

The ultimate product should remain Rust-first for now:

- `liboliphaunt` owns the embeddable PostgreSQL C ABI and upstream patch stack.
- `oliphaunt` owns Rust configuration, root management, extensions,
  async execution semantics, broker/server selection, tests, and benchmarks.
- Swift, Kotlin, and React Native should follow the Rust SDK semantics instead
  of defining parallel product behavior.

This is the right split because the hardest correctness decisions are
PostgreSQL lifecycle, storage roots, extension loading, backup/restore,
concurrency, and performance. Rust is the best place in this repo to encode
those decisions once and make other SDKs thinner.

The three-mode model is also correct:

- `NativeDirect` is the lowest-latency embedded path. It must stay honest: one
  physical backend session, no fake pools, no fake independent connections.
- `NativeBroker` is the robust app mode. It should become the default desktop
  recommendation when developers need multiple roots, crash isolation, upgrade
  orchestration, or long-running app behavior.
- `NativeServer` is the compatibility mode. It must be a real PostgreSQL server
  process for `psql`, `pg_dump`, ORMs, pools, and independent sessions.

The mode split is how this competes with SQLite without pretending PostgreSQL
has SQLite's process model. SQLite wins by having a small, direct, single-file
engine. Native Oliphaunt can compete only if it is honest about where PostgreSQL is
stronger: SQL compatibility, extensions, types, query planner, ecosystem, and
server compatibility. Direct mode should win on embedded latency where possible;
broker/server modes should win on robustness and compatibility where direct mode
cannot.

## C ABI And PostgreSQL Patch Stack

The current C ABI is deliberately small:

- `oliphaunt_init`
- `oliphaunt_exec_protocol`
- `oliphaunt_exec_simple_query`
- `oliphaunt_exec_protocol_stream`
- `oliphaunt_cancel`
- `oliphaunt_close`
- `oliphaunt_last_error`
- `oliphaunt_version`
- `oliphaunt_capabilities`
- `oliphaunt_free_response`

That is a good first boundary. It keeps query semantics on PostgreSQL's native
wire protocol and avoids inventing a second SQL API at the C layer.

The PostgreSQL 18 patch stack is mostly defensible:

- host I/O hooks are added below backend libpq communication;
- a dedicated embedded backend entrypoint is used instead of single-user mode;
- embedded shutdown runs PostgreSQL cleanup without exiting the host process;
- current-working-directory restoration is explicit.

The patches should remain generic and upstreamable. They must not learn about
Rust, React Native, iOS, Kotlin, extension manifests, or product policy.
The upstream shape should be "PostgreSQL can run one backend session with
host-provided read/write callbacks and explicit lifecycle."

Open patch-stack risks:

- simultaneous direct instances are rejected; repeated direct lifetimes in one
  process remain a release-gated lifecycle area because PostgreSQL process
  globals are not designed as a normal library lifecycle;
- embedded lifecycle still touches `postgres.c` enough that every PostgreSQL
  minor bump needs careful review;
- no upstream-style test target exists inside the patched PostgreSQL tree for
  the embedded entrypoint;
- cancellation now has mode-specific implementations for direct, broker, and
  server, and close now waits for active SDK-owned work before shutdown/detach.
  Rust SDK smoke now covers repeated cancellation/recovery for direct, broker,
  and server plus PostgreSQL CancelRequest behavior from an external
  `tokio-postgres` server-mode client;
- COPY now has direct/broker/server/native-PostgreSQL rows in the
  source-current native matrix and env-gated Rust regression coverage for both
  client-driven `COPY FROM STDIN` and streamed `COPY TO STDOUT`. The regression
  sends frontend CopyData/CopyDone frames, validates the `CopyInResponse`,
  inserted payloads, and post-COPY reuse, then drives invalid COPY input and
  frontend `CopyFail` to verify `ErrorResponse`, `ReadyForQuery`, zero committed
  rows, and post-error session reuse. It then streams `COPY TO STDOUT`,
  validates the backend protocol frames and payload size, and proves the
  session can execute a normal query afterward. The remaining release
  discipline is to refresh those measurements whenever the harness, runtime
  inputs, or protocol paths change.

## Rust SDK Review

Strengths:

- `oliphaunt-wasix` and `oliphaunt` are separate packages.
- `EngineMode` separates direct, broker, and server instead of mixing WASIX and
  native selection.
- direct mode is cloneable at the Rust handle level but serialized through an
  owner executor.
- transaction/session pinning prevents unpinned work from interleaving with a
  physical-session-sensitive transaction.
- extension selection is explicit by exact PostgreSQL extension name.
- root locking treats live storage as a directory and now combines a
  same-process canonical root registry with the `.oliphaunt.lock` filesystem
  marker plus a stable sibling filesystem lease keyed by the canonical root
  path. The stable lease is used across direct, broker-helper, server, backup,
  and restore paths, so root replacement stays locked while the old directory is
  moved aside and the restored directory is published. Restore/import reserves
  missing and empty target paths with the stable lease without creating an
  in-root marker before publish.
- plain C ABI callers now also get default root ownership at `oliphaunt_init`
  through a stable sibling filesystem lease keyed to `<parent-of-pgdata>`, with
  `<parent-of-pgdata>/.oliphaunt.lock` kept as the visible root marker.
  C `oliphaunt_restore` takes the same stable lease before staging or publishing,
  so it cannot replace a live direct-C-ABI root. The stable filename now uses
  the same SHA-256 prefix algorithm as the Rust SDK rather than a C-only hash,
  so cross-SDK missing-target restore reservations contend on one root
  identity. SDKs may opt out only with `OLIPHAUNT_CONFIG_EXTERNAL_ROOT_LOCK`; the
  Rust SDK sets that flag because it already owns the broader
  direct/broker/server/backup/restore coordinator.

Gaps:

- `NativeDirect` now uses the chunked `liboliphaunt` streaming ABI. `NativeBroker`
  forwards those chunks over broker IPC. `NativeServer` streams complete
  PostgreSQL wire frames as they are read from the local server connection.
- `NativeBroker` is a supervised worker-per-root architecture using
  authenticated Unix-domain socket IPC on Unix. That is the correct shape while
  the direct C ABI is process-global: one worker can crash without taking down
  the application or other broker roots, and the SDK can bound root fan-out.
  Helper relaunch after an observed crash is now covered; durable request
  replay, richer crash policy, and upgrade orchestration remain
  broker-supervisor release gates.
- `NativeServer` is a real server process with release-gate smoke for `psql`,
  packaged `pg_dump`, `tokio-postgres`, `tokio-postgres` external cancellation,
  `sqlx` pools, restart, and concurrent sessions. It still needs broader
  ORM-specific coverage beyond SQLx.
- direct and broker expose same-version physical backup; server additionally
  exposes logical SQL backup through `pg_dump`. Physical restore/import is now
  a first-class Rust SDK API with safe staging and locked replacement, and the
  server restore smoke proves the archive can recover user data.
- root/runtime/template materialization is no longer carrying the low-level
  filesystem copy, fingerprinting, selected-extension asset policy,
  runtime-cache orchestration, runtime asset installation, runtime cache
  key/validation, or packaged-template bootstrap policy in the same file.
  Focused cache-key tests now prove selected extension SQL/module changes
  invalidate runtime caches, unselected extension assets remain invisible, and
  selected extensions are required during cache validation.

## Extension Architecture

The correct extension model is manifest-gated and opt-in:

- no default "everything" bundle;
- `CREATE EXTENSION` succeeds only when the selected exact extension provides
  SQL/control files and the linked or packaged module;
- mobile uses static registries and resource bundles;
- desktop may additionally support signed dynamic extension artifacts;
- Rust defines the exact-extension resource contract first, other SDKs mirror it.

The current Rust surface supports explicit extension selection, and the root
materializer copies selected extension assets. Native smoke coverage verifies
that an unselected extension fails and the selected `vector` extension works
through direct, broker, and server. The external pgrx lane also builds pgGraph
`graph` and ParadeDB `pg_search` as opt-in extension candidates, and an
env-gated external matrix now
proves install/load, extension-specific behavior, restart, physical backup, and
physical restore for both external modules across direct, broker, and server.
The pgGraph smoke builds and traverses a tiny graph, then verifies root-scoped
persisted mmap auto-load, exact search, and shortest path after reopen/restore.
The ParadeDB smoke creates a real BM25 index and exercises `@@@`,
`paradedb.all`, `pdb.score`, and tokenizer stopword behavior after
reopen/restore.
`NATIVE_EXTENSION_MANIFEST` now records, per extension:

- PostgreSQL 18 support status;
- SQL/control asset class;
- shared module requirement;
- transitive data files;
- smoke SQL strategy;
- restart and backup/restore coverage status;
- direct-C-ABI/broker/server coverage status;
- mobile static-link status.

The remaining extension release blocker is now real platform extension-object
builds and device evidence, not the low-level loader or generated registry
source. Runtime resources record `mobileStaticRegistryState`,
`mobileStaticRegistryPending`, `nativeModuleStems`, and
`mobileStaticRegistrySource`, and the runtime-resource generator has a
`--require-mobile-static-registry` release gate. Kotlin and React Native
Android split-resource builds now stay pending for module-backed extensions
instead of accepting a static-module declaration without generated registry
source; mobile-complete Android/iOS selected-extension artifacts must consume Rust
runtime-resource generator output that includes `static-registry/oliphaunt_static_registry.c`.
pgGraph `graph` and ParadeDB `pg_search` are represented as internal external
PG18 candidates, not release-ready first-party selections, so they cannot
silently enter mobile or desktop bundles. Generated runtime resources now
record exact selected extensions, dependency-expanded runtime manifests,
static-registry state, and per-extension size evidence. Module-backed
extensions still need generated, linked, and device-tested platform extension
objects with the expected static symbol names before iOS/Android release, and
signed dynamic desktop extension artifacts still need a real signature and
loader policy before they can be accepted.

Extensions without official PostgreSQL 18 support should stay out of the first
native release lane.

## Swift, Kotlin, And React Native DX

The SDK direction is sound:

- Swift now exposes actor/async APIs and a native-direct C ABI engine. It still
  needs platform-native XCFramework/resource packaging for release.
- Kotlin now exposes suspend APIs, a Kotlin/Native native-direct C ABI engine,
  and an Android JNI-backed native-direct engine behind the same common API.
  Android hides JNI/threading and runtime materialization behind that SDK shape
  rather than introducing a second product boundary.
- React Native should use New Architecture TurboModules and a typed TypeScript
  API. The current TypeScript/TurboModule shape now includes `cancel()` and
  wait-and-detach close. iOS delegates to `Oliphaunt`; Android delegates to the
  Kotlin SDK. Both still need full app/device smoke coverage with packaged
  `liboliphaunt` and real runtime artifacts.

The React Native package now keeps Codegen for typed lifecycle/control calls
and requires a versioned New Architecture JSI direct-buffer transport for
protocol, backup, and restore bytes. That is the right performance stance for
this product: apps fail early if the JSI installer is missing instead of
silently accepting a serialized binary fallback. The remaining React Native gap is
full app/device smoke coverage with packaged `liboliphaunt` and real runtime
artifacts.

The mobile SDKs are not production-complete until they package and load the
real runtime resources and pass device/simulator tests that open, query, cancel,
close, restart, and load selected extensions.

## Testing Strategy

PostgreSQL's own testing model should be the north star. The official
PostgreSQL 18 docs describe regression tests as a comprehensive SQL test suite
covering standard SQL and PostgreSQL extensions. PostgreSQL also documents TAP
tests for executable/client behavior and temporary test servers.

liboliphaunt should adopt that shape:

1. C ABI tests:
   - covered by the C smoke: init/shutdown, first bootstrap, process-bound
     reopen, protocol success, protocol error recovery, invalid init and
     invalid exec/stream arguments, malformed frontend frame rejection and
     recovery, large owned responses, stream callback success/failure, close
     after error, active-query cancellation and recovery, capabilities, and
     version.

2. SQL regression:
   - run a curated PostgreSQL regression subset through direct mode;
   - run the same SQL through broker and server;
   - compare against a native PostgreSQL control where output is stable;
   - classify expected differences explicitly.

3. Client/server compatibility:
   - `psql`;
   - `pg_dump` and restore;
   - `sqlx`;
   - `tokio-postgres`;
   - connection pools;
   - concurrent sessions in server mode.

4. Concurrency:
   - many async Rust tasks sharing one direct handle;
   - fair queueing;
   - transaction pinning;
   - cancellation and close during active SDK-owned work;
   - queued work rejection once close begins;
   - broker crash/reconnect.

   Broker crash/reconnect now has an env-gated native smoke that kills the
   helper, waits for PostgreSQL crash recovery on relaunch, and reads data
   through the same Rust handle.

5. Extensions:
   - absent extension fails;
   - selected extension succeeds;
   - unselected extension fails;
   - each PG18-supported extension has direct/broker/server/restart/dump smoke.

6. Mobile and RN:
   - Swift XCTest on macOS and iOS simulator/device;
   - Kotlin/JNI Android instrumentation;
   - React Native iOS/Android sample with Codegen and nonblocking JS thread;
   - large payload test using the future direct-buffer transport.

## Benchmark Strategy

The product gate should be native PostgreSQL parity. The native path calls the
same database engine and should not add material latency, CPU, or memory
overhead beyond its chosen embedding mode.

Required benchmark dimensions:

- simple-query RTT p50/p90/p95/p99;
- extended protocol prepare/bind/execute;
- typed query overhead;
- transaction throughput;
- batched insert/update/delete;
- indexed update workloads;
- COPY in/out;
- large result streaming;
- cold open and warm open;
- close/reopen across process;
- backup/restore;
- RSS, peak footprint, and CPU seconds;
- artifact size and resource bundle size;
- native PostgreSQL control;
- SQLite control;
- native direct/broker/server modes.

The matrix script now measures the three native SDK modes separately:

```sh
tools/perf/matrix/run_native_oliphaunt_matrix.sh
```

For fast local checks, run:

```sh
target/debug/oliphaunt-perf native-liboliphaunt --engine direct --suite rtt --iterations 10
target/debug/oliphaunt-perf native-liboliphaunt --engine broker --suite rtt --iterations 10
target/debug/oliphaunt-perf native-liboliphaunt --engine server --suite rtt --iterations 10
```

Release claims should come only from serial matrix runs on an idle machine, with
the run directory and exact binary versions retained. The native matrix writes
`provenance.json`; verify retained evidence with:

```sh
OLIPHAUNT_PERF_RUN_DIR="$PWD/target/perf/native-liboliphaunt-<run-id>" \
tools/perf/check-native-perf-report.sh
```

## Code Organization Review

Good boundaries:

- `oliphaunt/` owns the native C and PostgreSQL patch stack.
- `src/sdks/rust/` owns the Rust SDK.
- `src/bindings/wasix-rust/crates/oliphaunt-wasix/` remains WASIX-focused.
- `src/sdks/swift`, `src/sdks/kotlin`, and `src/sdks/react-native` own language/platform packages.
- `tools/` owns repo automation.

Files to split next:

- `src/runtimes/liboliphaunt/native/src/liboliphaunt_native.c`: backup/restore archive handling has been
  split into `src/runtimes/liboliphaunt/native/src/liboliphaunt_archive.c`; bootstrap, runtime-tool
  discovery, process-global instance guarding, protocol tracing, filesystem
  helpers, ustar archive read/write, raw protocol execution, streaming
  backpressure, readiness scanning, embedded backend read/write callbacks, and
  backend argv/default-GUC construction now live in dedicated C translation
  units behind `src/runtimes/liboliphaunt/native/src/liboliphaunt_internal.h`. The remaining native
  lifecycle file is small enough to keep focused on backend ownership and
  public non-query ABI orchestration.
- `src/runtimes/liboliphaunt/native/src/liboliphaunt_archive.c`: physical archive lifecycle is now
  separated from tar mechanics. If the archive format grows beyond same-version
  physical tar, introduce a format dispatcher instead of adding branches to
  the tar module.
- `tools/xtask/src/main.rs`: extension cataloging, process RSS sampling, and
  perf command orchestration now live in dedicated modules. The remaining split
  is asset/release orchestration; benchmark result/report models can move again
  if `perf.rs` keeps growing.

## Release Blockers

Native direct should not be the default until these are true:

- no native direct benchmark gate regresses beyond the accepted tolerance
  against native PostgreSQL control;
- direct/broker/server each have real performance rows, including
  prepared-update rows measured beside the native PostgreSQL prepared-update
  control;
- selected extensions pass direct/broker/server tests;
- large response streaming is native, benchmarked, and covered for direct mode;
- direct, broker, and server streaming are benchmarked against native
  PostgreSQL controls;
- lifecycle policy is documented and enforced;
- restore/import coverage includes direct, broker, and server backup/restore
  smokes with selected extensions;
- mobile packaging can open/query/restart with selected extensions;
- React Native has a direct-buffer path for large results. The TurboModule
  Codegen surface is lifecycle/control-only; protocol, backup, and restore
  bytes require the versioned JSI `ArrayBuffer` transport, and validation
  rejects base64 or Codegen binary regressions.

## References

- PostgreSQL 18 regression testing documentation:
  https://www.postgresql.org/docs/current/regress.html
- PostgreSQL TAP testing documentation:
  https://www.postgresql.org/docs/current/regress-tap.html
- React Native Turbo Native Modules:
  https://reactnative.dev/docs/turbo-native-modules-introduction
- React Native Codegen type appendix:
  https://reactnative.dev/docs/appendix
