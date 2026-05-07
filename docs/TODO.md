# To Do (Maintainers)

This is the single implementation backlog for `pglite-oxide`. It is
maintainer-facing and intentionally separate from the user-facing docs.

This file should contain only unfinished architecture, implementation, release,
and research work.

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
2. Enforce cold-start and warm-path release gates in CI after collecting
   release-mode baselines on GitHub-hosted runners.
3. Finish the remaining extension dependency stacks: pinned WASIX
   OpenSSL/libcrypto for `pgcrypto`, pinned WASIX OSSP UUID/libuuid for
   `uuid-ossp`, and the pinned PostGIS geospatial stack.
4. Harden public `pg_dump` API/CLI across target platforms and add release-mode
   performance gates.
5. Harden CI, release-plz, package-size gates, Trusted Publishing, and
   dependency invariants for all internal asset and AOT crates.
6. Validate the split WASIX `initdb` artifact end to end in the Assets workflow:
   generated template determinism, fresh direct/server temporary roots,
   interrupted-initdb cleanup, and package-size impact.

## Bucket 1: Performance And Runtime Architecture

Performance work is product work, not optional research. If a work item affects
both cold and warm behavior, track it under cold.

### Current State

- Default runtime uses headless Wasmer and packaged AOT artifacts.
- Runtime assets use pure mount composition; immutable runtime files stay in the
  shared cache and per-root upper layers contain mutable state and requested
  extension assets.
- PGDATA uses the eager template overlay; local PGDATA setup is under 1ms.
- Direct scalar paths no longer scan `pg_type` for arrays on open/query.
- Direct query paths no longer force Rust-side directory `sync_all`.
- Direct API, server API, proxy CLI, raw protocol, and `pg_dump` share
  `BackendSession`.
- Current local release runs show visible first-query paths mostly in the
  tens-of-ms range, dominated by PostgreSQL backend startup, Wasmer instance
  creation, and first protocol round trips. The latest public benchmark
  snapshot lives in [PERFORMANCE.md](PERFORMANCE.md). Maintainer tuning details
  live in [PERFORMANCE_INTERNAL.md](PERFORMANCE_INTERNAL.md); historical
  rollout notes stay in [DONE.md](DONE.md).

### Release Gates

- temporary database first `SELECT 1` under 500ms on GitHub Ubuntu;
- persistent database first `SELECT 1` under 500ms on GitHub Ubuntu;
- `PgliteServer` start plus first SQLx query under 500ms on GitHub Ubuntu;
- temporary database with requested extensions plus first extension-backed
  query under 500ms on GitHub Ubuntu;
- public `pg_dump` startup plus first dump row under 500ms on GitHub Ubuntu;
- warm temporary direct first query under 100ms on GitHub Ubuntu;
- warm temporary server plus first SQLx query under 100ms on GitHub Ubuntu;
- warm temporary server plus first extension-backed SQLx query under 125ms on
  GitHub Ubuntu;
- no more than 15% regression after stable baselines.

### Cold Path Work

- Turn the local `xtask perf cold`, `perf warm`, speed-suite, and prepared
  update baselines into CI checks on representative runners.
- Keep the source/runtime invariants in the performance matrix:
  `postgres-pglite` `REL_17_5-pglite` at
  `01792c31a62b7045eb22e93d7dad022bb64b1184`, Wasmer/WebAssembly exceptions,
  WASIX dynamic linking, spinlock-enabled WASIX build, and PGlite buffer
  profile (`shared_buffers=128MB`, `wal_buffers=4MB`, `min_wal_size=80MB`).
- Reduce explicit `Pglite::preload()` latency further by profiling runtime
  cache setup, mmap/native deserialization, and Wasmer native artifact loading.
- Keep Wasmer native mmap deserialization as the only production AOT loading
  path. Do not reintroduce full content hashing on default startup.
- Cross-platform validate the default pure mount composition and eager PGDATA
  overlay across direct, persistent, app-id, temporary, proxy, and server roots.
- Validate lazy/generated direct-client array metadata across built-in arrays,
  enum arrays, domain arrays, composite arrays, explicit
  `refresh_array_types`, transactions, row-mode results, and caller-supplied
  parser/serializer overrides.
- Deepen C-side timers inside remaining backend-open costs:
  shared-memory initialization, relcache/catcache work, database lookup,
  `CheckMyDatabase`, and session initialization. Keep these timers gated out of
  production artifacts unless explicitly enabled.
- Keep an explicit regression guard so extension-template opens do not fall
  back into slow `StartupXLOG` recovery.
- Extend server perf visibility to proxy CLI runs, TCP, Unix sockets,
  tokio-postgres, SQLx, scalar roots, and extension-enabled roots.
- Remove or mount-compose the remaining per-root requested-extension asset
  materialization cost. This must stay generic by requested extension set, not
  special-cased to vector.
- Add an init-profile dimension to extension-set PGDATA template cache keys
  once init options become configurable.
- Evaluate catalog/syscache warmup during template creation: `SELECT 1`,
  representative prepared/extended query, extension type I/O/query smoke,
  SQLx/tokio-postgres startup flow, and representative extension setup.
- Run temporary durability experiments (`fsync=off`, `synchronous_commit=off`,
  reduced WAL work) for temporary roots only. Persistent databases stay
  conservative unless separately proven safe.
- Ensure side-module AOT artifact identity is tied to main runtime identity.
- Add Linux perf/perfmap support for symbolized AOT profiling so remaining time
  can be attributed to executor, btree, heap, WAL, memory, or Wasmer-generated
  code.
- Validate ThinLTO build time, package-size budget, and performance on every
  supported CI target.
- Validate the current Wasmer LLVM codegen profile across the full target and
  correctness matrix: nonvolatile memory operations plus readonly funcref table.
- Benchmark pgvector insert/query/distance workloads with the default WASIX
  toolchain feature baseline, including SIMD/relaxed-SIMD behavior.
- Inspect tail calls, extended const expressions, and wide arithmetic use so
  feature usage is consistent across target artifacts.

### Warm/Steady-State Work

- Reduce PostgreSQL backend startup without changing semantics, especially
  `shared_memory`, `InitPostgres`, `relcache_phase3`, database/session setup,
  and PGlite-specific startup work.
- Evaluate safe relcache/catcache/syscache warmup only if it is normal
  Postgres-compatible state and cannot cache broken process-global state.
- Keep warm opens free of AOT decompression, full hashing, and asset extraction.
- Test whether any supported Wasmer engine/runtime reuse can reduce instance
  creation without leaking Store, WASI env, fd, mount, protocol, or database
  state.
- Use `perf warm` for long-lived `PgliteServer` baselines: repeated
  connections, repeated SQLx/tokio-postgres prepared queries, transaction
  batches, extension-backed queries, reconnect after client disconnect, and
  idle-to-next-query latency.
- Keep `perf prepared-updates --skip-native --gate` in the local regression
  path while CI baselines settle.
- Extend extended-protocol batching only through protocol-correct reductions in
  host/backend crossings and buffer copies. Do not add sleep-based coalescing.
- Add direct warm benchmarks for prepared query reuse and first unknown runtime
  array type discovery.
- Add warm public `pg_dump` benchmarks that measure startup separately from
  dump volume.
- Evaluate context switching, experimental async APIs, CPU idle/backoff, and
  opt-in backend pools only if correctness and state reset semantics are
  stronger than user expectations.
- Defer threaded/multi-backend execution until the single-backend path is stable
  and atomics/shared memory do not break dynamic linking or Postgres
  process-global assumptions.

### Runtime Experiments

Experiments are real work. Each must report timing, correctness, state
isolation, artifact size impact, and implementation risk.

- WASIX journaling, Wasmer `StoreSnapshot`, or InstaBoot-style restore:
  re-enter only with a small upstream repro or a fixed journal layer. The last
  local spike passed `SELECT 1` from an instance-created restore but did not
  skip Postgres startup; backend-ready/protocol-ready snapshots were too slow
  and failed fd seek replay.
- Cranelift: evaluate direct `SELECT 1`, SQL error recovery, representative
  extension create/query, server SQLx smoke, compile speed, and cross-platform
  exception/dynamic-linking behavior.
- Singlepass: evaluate only after the same longjmp/error and extension suite
  passes.
- Asyncify: keep out of production unless a specific snapshot or journaling path
  proves a need on an experiment branch.
- Alternative engines such as V8 or JavaScriptCore: evaluate only for mobile or
  special embedded targets, checking WASIX, dynamic linking, filesystem,
  exceptions, and headless/AOT implications.
- Native CPU tuning: evaluate only if artifacts remain portable or target packs
  are split intentionally.

## Bucket 2: CI, CD, Release, And Workspace Hygiene

### CI/CD Target Model

- Validate the source-controlled-inputs model on GitHub: normal CI must keep
  using only source templates plus downloaded compatible Assets workflow
  bundles, and asset-producing changes must remain the only PR path that
  fetches upstream sources or runs Docker.
- Harden `xtask release publish`: the local command should stage and validate
  exactly what the Release workflow publishes, then either invoke release-plz in
  a Trusted Publishing environment or fail before any partial publish is
  possible.
- Keep `xtask release stage` and `scripts/validate.sh release` as the only
  packaging path for generated portable/AOT crate contents. Any future release
  check must run against the staged workspace, not ad hoc copied artifacts.
- Split packaged runtime payloads from extension payloads after the `bundled`
  feature model lands. Today `bundled` gives users an embedded-runtime install
  mode without the public extension API, but the single `pglite-oxide-assets`
  crate still carries extension archives and the target AOT pack can carry
  extension AOT artifacts. A future crate split should make `bundled`
  runtime-only at download/package-size level and keep extension archives plus
  extension AOT artifacts behind `extensions`.
- Keep the local development split into three modes: fast assetless contributor
  checks, host-platform artifact-backed runtime work, and downloaded CI
  artifact testing. Developers validate their host platform locally; CI remains
  responsible for the full target matrix.
- Ensure new asset-producing inputs update the committed asset-input
  fingerprint and are covered by source-free `assets verify-committed`,
  generated-asset validation, package-size checks, and runtime smoke tests.
- Release CI must publish only artifacts generated and tested for the exact
  release SHA, with package checks performed against the same staged crate
  contents that are published.

### Target Matrix

First-class targets:

- `aarch64-apple-darwin`;
- `x86_64-unknown-linux-gnu`;
- `aarch64-unknown-linux-gnu`;
- `x86_64-pc-windows-msvc`.

Experimental targets:

- Linux musl;
- Android;
- iOS through V8/JSC/interpreter paths if feasible;
- RISC-V after Wasmer target support matures.

### Asset And AOT CI

- Validate the first full `Assets` workflow run after the portable-WASIX plus
  native-AOT CI split lands.
- Keep dynamic-link closure checks, manifest validation, package-size checks,
  and smoke tests coupled to asset release orchestration.
- Package strategy order:
  1. raw AOT artifact if the crate stays under crates.io's compressed limit;
  2. `.zst` compressed artifact with one-time expansion into the persistent
     cache;
  3. deterministic split AOT/asset packs if compression is still too large.

### Workspace Hygiene

- Keep root `pglite-oxide` as the public crate.
- Keep asset/AOT crates internal implementation details with exact internal
  dependency versions.
- Keep the source-free asset workflow honest as new asset-producing inputs are
  added: every new input must be covered by `assets verify-committed`, the
  input fingerprint, or an explicit asset CI gate.
- Keep one active source root: configured `postgres-pglite`
  `REL_17_5-pglite` pinned to the audited commit.
- Keep user-facing docs free of implementation backlog/status notes.
- Keep [DONE.md](DONE.md) as the only completed-work/status document and this
  file as the only implementation backlog.

### Normal CI

- Validate the first path-aware CI run for docs-only, CI-only, test-only, and
  package-affecting PRs.
- Validate the first Rust-only native-AOT runtime matrix run across macOS
  arm/x64, Linux arm/x64, and Windows x64.
- Keep doctests, no-default-features checks, feature powerset, dependency
  invariants, package checks, supply-chain
  checks, and example checks routed through the DRY validation script.
- keep the minimal `wasmer` and `wasmer-wasix` feature sets while retaining
  filesystem mounts, WASIX env/args, networking required by `pg_dump`, and
  dynamic linking;
- macOS multi-module LLVM exception gate: main module plus at least two side
  modules, SQL error recovery after each load, and normal parallel test
  scheduling on macOS arm64 and x64;
- keep actionlint, cargo-deny, and GitHub Actions security audit green.

### Release And Publishing

- Configure Trusted Publishing for every published crate.
- Complete first-publish/bootstrap verification for internal asset/AOT crates on
  crates.io.
- Validate that release-plz publishes internal asset/AOT crates before the root
  crate when exact internal dependency versions require that order.
- Keep release PRs using a GitHub App or bot token if maintainers want normal PR
  CI to run automatically on release-plz branches.

### Reproducibility

- Record Wasmer crate version, Wasmer CLI/tool version, wasixcc/toolchain
  version, WASIX libc/EH-PIC sysroot identity, LLVM version, postgres-pglite
  commit, pglite-build commit, extension repository commits, Docker image
  digest, and build profile in manifests.
- Use Wasmer reproducible-build controls such as `WASMER_REPRODUCIBLE_BUILD=1`
  where applicable.
- Add deterministic two-build comparisons for identical source pins.
- Make asset and AOT crate hashes stable enough for audit and cache
  invalidation.

## Bucket 3: Source, Build Spine, And Asset Provenance

The active source baseline is `electric-sql/postgres-pglite`
`REL_17_5-pglite` at `01792c31a62b7045eb22e93d7dad022bb64b1184`, matching the
`@electric-sql/pglite` 0.4.5 source/artifact pair. The historical
`REL_17_5_WASM-pglite-builder` branch remains reference material for extension
and `pg_dump` packaging ideas, not the production source spine.
`electric-sql/pglite-build` `portable` remains pinned as build-script
provenance, not as a second runtime source root.

### Source-Spine Work

- Keep stable branch lifecycle/protocol exports:
  `_start`/single-user startup, `pgl_setPGliteActive`, `pgl_startPGlite`,
  `ProcessStartupPacket`, `PostgresMainLoopOnce`, and `PostgresMainLongJmp`.
- Critique and document each PGlite adaptation before copying it. Keep only host
  ABI adaptations still necessary under Wasmer/WASIX.
- Keep `pglite-build` and the builder branch as reference inputs for extension
  symbol discovery and packaging, without reintroducing the old `pglite-wasm/*`
  wrapper as production runtime code.
- Keep the generated `wasix-dl` export list wired to side-module import
  discovery and extend negative tests as more extension packs are added.
- Replace catalog-driven extension packaging with install-delta packaging before
  promoting extensions that scatter files outside the standard `.so`,
  `.control`, and extension SQL layout. Reuse upstream `pack_extension.py`
  concepts without using non-deterministic archive writing.
- Keep manifest fields for extension imports and core exports current so
  dynamic-link failures are diagnosed before startup.
- Add negative fixtures proving wrong-core side modules and unresolved imports
  fail during validation, before runtime startup.
- Verify `vector`, at least one contrib extension, one PGXS extension, and
  `pg_dump` are always built from the same configured tree before release.

### Upstream Audit

- Keep `xtask assets audit-upstream --strict` as the source of truth for newer
  upstream `postgres-pglite` fixes, marking each item as included, replaced by
  WASIX architecture, optional, or pending.
- Keep the WASIX longjmp bridge intentionally narrower than upstream
  Emscripten's `jmp_buf` content comparison: pointer identity against exported
  top-level `postgresmain_sigjmp_buf`.
- Keep active-portal abort cleanup in PostgreSQL-owned code for
  `PGLITE_WASIX_DL`; do not reintroduce Rust-side synthetic `Sync` or portal
  cleanup without a failing upstream regression test.
- Keep startup identity/database handling owned by PostgreSQL startup code; Rust
  should synthesize only runtime/host failures that occur before PostgreSQL can
  emit wire output.
- Audit, cherry-pick, or explicitly reject remaining upstream/runtime items:
  background-worker disable semantics, artifact cache fixes, data-directory
  locking deltas, upstream `postgresConfig` parity beyond the Rust startup-GUC
  API, and `pgoutput` symbol exports.
- Decide whether proxy/frontend startup should eventually stop fabricating
  startup responses in Rust and converge further toward upstream
  `interactive_one`/`ProcessStartupPacket` lifecycle for every client
  connection.
- Keep future config changes flowing through the Rust startup-GUC API, a pinned
  upstream `postgresConfig` surface, or a documented initdb-time config model.

### Canonical Assets

- Keep timezone data generated by `zic` inside the pinned build image from
  PostgreSQL `tzdata.zi`, never from a maintainer host.
- Generate PGDATA with the desired timezone instead of patching extracted config
  text.
- Keep runtime prefix files packaged from the pinned configured tree, including
  timezone files, extension SQL/control files, and installed support libraries.
- Keep asset manifests tied to source commits, Docker image digest, Wasmer
  version, engine identity, source module hashes, import/export sets, archive
  hashes, and package sizes.

## Bucket 4: Runtime Correctness And Protocol

- Continue expanding PostgreSQL regression coverage beyond the current PGlite
  parity subset into less common planner, catalog, lock, utility-command, and
  wait/socket behavior.
- Add broader raw wire-protocol and fuzz coverage around extended query
  sequencing.
- Keep export guards requiring `PostgresMainLongJmp`,
  `PostgresSendReadyForQueryIfNecessary`, `pgl_pq_flush`, and WASIX
  input/output symbols.
- If a future Wasmer version resumes the C `sigsetjmp` boundary directly, keep
  the explicit recovery export as a tested no-op fallback until tests prove it
  can be removed.
- Keep the guard that treats missing `ParseComplete` as an error on successful
  Parse paths.
- Keep the production patch free of `pglite-wasm/*`; future frontend/initdb
  stubs must be justified by link-symbol analysis against the stable branch.
- Add a C/link audit for the split-initdb child-process shim and keep it
  fail-closed to locale discovery plus upstream initdb's `postgres` boot/check
  commands.
- Keep interrupted-PGDATA and root-locking tests as the owned coverage for
  failed opens. Do not add a fake child-process kill model unless the runtime
  grows a real child-process boundary.
- Harden backend-side COPY error coverage beyond the current suite.
- Investigate returning from COPY streaming continuation to buffered mode after
  COPY if it can be proven correct for SQLx, tokio-postgres, raw TCP, Unix
  sockets, `CopyFail`, and post-COPY reuse.
- Keep direct raw protocol streaming and direct `pg_dump` on the shared
  `BackendSession` path; do not reintroduce clone/server indirection.
- Reject asset mixing through negative tests: wrong runtime, wrong side module,
  wrong AOT identity, wrong extension archive, and stale manifest.

## Bucket 5: Extensions

Extension catalog generation discovers 40 SQL extensions from PGlite docs/REPL
exports, PostgreSQL contrib, `postgres-pglite/pglite/other_extensions`, pinned
external repositories, and the packaged asset manifest. The current build plan
requests and packages 37 extensions. All 37 packaged extensions have passed
direct, server, restart, and lifecycle materialization gates and are public
constants. `pgcrypto`, `uuid-ossp`, and PostGIS remain explicitly blocked until
their native dependency stacks are pinned and smoke-tested for WASIX.

### Remaining Promotion Order

1. Add pinned WASIX OpenSSL/libcrypto sysroot and promote `pgcrypto`.
2. Add pinned WASIX OSSP UUID/libuuid sysroot and promote `uuid-ossp`.
3. Add pinned WASIX geospatial dependency stack and install-delta packaging for
   PostGIS.

### Extension Rules And Hardening

- Generate public constants only after direct, server, restart, and lifecycle
  smoke gates pass for the current asset set.
- Keep PGlite `live` out of SQL extension constants until there is a
  Rust-native live-query API.
- Keep `extensions::ALL` limited to extensions passing for the current asset
  set.
- Keep every discovered SQL extension either build-requested or blocked with a
  concrete reason.
- Verify that manifest metadata remains sufficient for preload/config/shared
  memory/restart/dependency/load-order needs; add fields only where the current
  dependency, load-order, and lifecycle metadata are insufficient.
- Prove preload-required extensions such as `pg_stat_statements` apply
  `shared_preload_libraries` before backend startup before exposing them.
- Make extension dependency errors fail at manifest/build-plan generation time
  where possible.
- Add extension load-order and missing-native-dependency failure tests.
- Add preload/startup-config extension tests before exposing extensions that
  require postmaster-time configuration.
- Add lifecycle negative tests for missing side modules, wrong core runtime,
  missing SQL/control files, repeated enable, reopen after install, and missing
  requested archives.
- Keep generated native-module metadata authoritative: SQL extension names and
  native side-module names can differ, and some extensions are SQL-only.
- Replace remaining PGXS build assumptions with extension-specific build
  metadata where external modules require extra flags, generated headers,
  install hooks, generated SQL, or multiple side modules.
- Add automation that updates `assets/extensions.smoke.toml` from reviewed smoke
  suite output instead of requiring maintainers to edit it by hand.

## Bucket 6: `pg_dump`

- Keep public dump/restore tests for direct `Pglite`, `PgliteServer`, vector,
  indexes, views, sequences, `--schema-only`, and quoted identifiers.
- Keep direct `Pglite::dump_sql` no-clone, no-public-server, and no-OS-loopback:
  stock WASIX `pg_dump`/libpq should route through Wasmer virtual networking and
  host-side `exec_protocol_raw`.
- Do not add a pglite-oxide-specific `pg_dump` callback ABI unless stock libpq
  over virtual networking fails a concrete correctness or performance gate.
- Keep rejecting passthrough flags that conflict with the typed API's managed
  output file, output format, host, port, username, database, and job count.
- Add release-mode performance and cross-platform CI for `PgDumpOptions`,
  `Pglite::dump_sql`, `Pglite::dump_bytes`, `PgliteServer::dump_sql`,
  `PgliteServer::dump_bytes`, and the real `pglite-dump` CLI.

## Bucket 7: Examples, Docs, And Ecosystem Tests

- Add examples and CI for SQLx, `tokio-postgres`, rstest, Diesel, SeaORM,
  Tauri, pgvector local RAG, Python/psycopg, Go/pgx, and Node `pg`.
- Add Python, Go, and Node proxy examples that verify SQLSTATE preservation and
  recovery behavior through ordinary client libraries.
- Keep README first screen focused on embedded Postgres, tests, local apps,
  pgvector/common extensions, no Docker, and any Postgres client through local
  server mode.
- Keep user-facing docs free of internal status notes; implementation notes stay
  in this file or [DONE.md](DONE.md).

Required release test categories:

- direct `SELECT 1`, persistence, restart, temporary template cache, and root
  locks;
- SQLx and `tokio-postgres` server connections;
- SSLRequest, CancelRequest, Parse/Bind/Execute error recovery, and pipelined
  extended queries;
- vector create/insert/query/distance through direct API and server mode;
- generated extension smoke suite;
- unsafe archive rejection and canonical path validation;
- manifest SHA validation and AOT source-module identity verification;
- unsupported target errors;
- macOS multi-module exception recovery;
- public dump/restore;
- Python, Go, and Node proxy tests;
- package size checks and publish dry-runs.

## Experiment And Decision Policy

Every runtime-affecting experiment must end in one repo-visible state:

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
- `postgres-pglite` `REL_17_5-pglite` and historical
  `REL_17_5_WASM-pglite-builder` reference branch;
- `pglite-build` `portable`;
- PGlite data-directory locking, startup config, and `pgoutput` upstream PRs.
