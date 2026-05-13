# Implementation Backlog (Maintainers)

This is the single implementation backlog for `pglite-oxide`. It should contain
only unfinished architecture, implementation, release, validation, and research
work. Completed work belongs in [DONE.md](DONE.md).

Backlog priorities:

- `P0`: blocks calling the WASIX/Wasmer runtime production ready.
- `P1`: hardening needed for a durable, low-maintenance product.
- `P2`: experiments, future targets, and optional architecture bets.

When finishing an item, move the durable summary to [DONE.md](DONE.md) and leave
only genuine follow-up work here.

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

## P0 Release Backlog

### P0-02: Enforce Release Performance Gates In CI

Outcome: performance is a release gate on representative GitHub runners.

Remaining work:

- Collect stable release-mode GitHub-runner baselines for:
  - `xtask perf cold`;
  - `xtask perf warm`;
  - the product-style speed/bench suite;
  - `xtask perf prepared-updates --skip-native --gate`;
  - public `pg_dump` startup and warm dump paths.
- Add CI checks for the release gates below.
- Publish structured timing artifacts with cold/warm cache state, process state,
  root state, query state, workload, primary latency phase, and primary latency
  micros.
- Update [PERFORMANCE.md](PERFORMANCE.md) only from reproducible benchmark
  output.

Release gates on GitHub Ubuntu:

- temporary database first `SELECT 1` under 500 ms;
- persistent database first `SELECT 1` under 500 ms;
- `PgliteServer` start plus first SQLx query under 500 ms;
- temporary database with requested extensions plus first extension-backed query
  under 500 ms;
- public `pg_dump` startup plus first dump row under 500 ms;
- warm temporary direct first query under 100 ms;
- warm temporary server plus first SQLx query under 100 ms;
- warm temporary server plus first extension-backed SQLx query under 125 ms;
- no more than 15% regression after stable baselines are recorded.

### P0-03: Promote Remaining Blocked Extensions

Outcome: `pgcrypto`, `uuid-ossp`, and PostGIS are either promoted or still
blocked with current, concrete WASIX dependency evidence.

Remaining work:

1. Add a pinned WASIX OpenSSL/libcrypto sysroot and promote `pgcrypto`.
2. Add a pinned WASIX OSSP UUID/libuuid sysroot and promote `uuid-ossp`.
3. Add a pinned WASIX geospatial dependency stack and install-delta packaging
   for PostGIS.
4. Add direct, server, restart, lifecycle materialization, load-order, and
   missing-native-dependency tests for each newly promoted extension.
5. Reuse upstream `pack_extension.py` concepts where helpful, without adopting
   nondeterministic archive writing.
6. Replace any remaining PGXS build assumptions needed by these extensions with
   extension-specific metadata for extra flags, generated headers, install
   hooks, generated SQL, or multiple side modules.

Acceptance:

- `assets/extensions.promoted.toml`, `assets/extensions.smoke.toml`, generated
  catalogs, and generated build plans agree.
- Public constants are generated only after the current asset set passes direct,
  server, restart, and lifecycle smoke gates.
- `extensions::ALL` includes only extensions that pass for the current asset
  set.

### P0-04: Add Cross-Target `pg_dump` Release Gates

Outcome: logical dump APIs and `pglite-dump` are release-qualified across the
supported target matrix.

Remaining work:

- Add release-mode performance and cross-platform CI for:
  - `PgDumpOptions`;
  - `Pglite::dump_sql`;
  - `Pglite::dump_bytes`;
  - `PgliteServer::dump_sql`;
  - `PgliteServer::dump_bytes`;
  - the real `pglite-dump` CLI.
- Measure `pg_dump` startup separately from dump volume.
- Include `pg_dump` performance output in P0-02's release-gate artifacts.

Acceptance:

- Direct and server dump APIs pass on every first-class generated AOT target.
- `pglite-dump` is exercised against the packaged WASIX `pg_dump` module, not a
  host `pg_dump` binary.


### P0-06: Validate Split `initdb` In The Full Asset Flow

Outcome: split WASIX `initdb` is proven as an end-to-end asset-production path,
not just a local runtime implementation.

Remaining work:

- Record a successful Assets workflow run that generates the architecture-
  independent PGDATA template from the split WASIX `initdb` module.
- Add or record deterministic two-build comparison evidence for identical
  source pins and split-initdb template output.
- Measure package-size impact for the split `initdb` artifact and PGDATA
  template in the release artifact set.

Acceptance:

- The generated template manifest binds to the runtime module hash and the
  split-initdb module hash.
- Fresh-initdb functionality remains covered by runtime tests, but TODO tracks
  only the full workflow and reproducibility proof.

## P1 Product Hardening Backlog

### P1-01: Reduce Remaining Cold Path And Preload Cost

Outcome: remaining cold-start time is measured, attributable, and reduced
without weakening artifact verification or startup correctness.

Remaining work:

- Profile explicit `Pglite::preload()` latency: runtime cache setup,
  mmap/native deserialization, and Wasmer native artifact loading.
- Evaluate catalog/syscache warmup during template creation:
  - `SELECT 1`;
  - representative prepared/extended query;
  - extension type I/O/query smoke;
  - SQLx/`tokio-postgres` startup flow;
  - representative extension setup.
- Run temporary durability experiments (`fsync=off`, `synchronous_commit=off`,
  reduced WAL work) for temporary roots only. Persistent databases stay
  conservative unless separately proven safe.
- Add Linux perf/perfmap support for symbolized AOT profiling.
- Validate ThinLTO build time, package-size budget, and performance on every
  supported CI target.
- Validate the current Wasmer LLVM codegen profile across the full target and
  correctness matrix: nonvolatile memory operations plus readonly funcref table.
- Benchmark pgvector insert/query/distance workloads, including SIMD and
  relaxed-SIMD behavior.
- Inspect tail calls, extended const expressions, and wide arithmetic use so
  feature usage is consistent across target artifacts.

Acceptance:

- Cold-path reports attribute remaining time to Postgres startup, Wasmer
  instance/module work, filesystem/mount work, protocol round trips, or
  extension setup.
- Optimizations preserve source/runtime invariants and cross-target correctness.

### P1-02: Improve Warm And Steady-State Runtime Behavior

Outcome: long-lived direct and server paths remain fast, protocol-correct, and
state-isolated.

Remaining work:

- Reduce PostgreSQL backend startup without changing semantics, especially
  `shared_memory`, `InitPostgres`, `relcache_phase3`, database/session setup,
  and PGlite-specific startup work.
- Evaluate safe relcache/catcache/syscache warmup only if it is normal
  Postgres-compatible state and cannot cache broken process-global state.
- Test whether supported Wasmer engine/runtime reuse can reduce instance
  creation without leaking Store, WASI env, fd, mount, protocol, or database
  state.
- Extend extended-protocol batching only through protocol-correct reductions in
  host/backend crossings and buffer copies. Do not add sleep-based coalescing.
- Add direct warm benchmarks for prepared query reuse and first unknown runtime
  array type discovery.
- Evaluate context switching, experimental async APIs, CPU idle/backoff, and
  opt-in backend pools only if correctness and state reset semantics are
  stronger than user expectations.
- Defer threaded/multi-backend execution until the single-backend path is stable
  and atomics/shared memory do not break dynamic linking or Postgres
  process-global assumptions.

### P1-03: Finish Direct-Client Type Edge Coverage

Outcome: lazy/generated type metadata remains correct beyond the already-covered
scalar and common runtime array paths.

Remaining work:

- Add focused tests for enum, domain, and composite arrays across transactions.
- Add row-mode result coverage for runtime-created array types.
- Add caller-supplied parser/serializer override coverage for runtime-created
  arrays.
- Add a warm benchmark for first unknown runtime array type discovery.

### P1-04: Strengthen Reproducibility And Source Provenance

Outcome: every runtime artifact is traceable to pinned inputs, and equivalent
input builds produce auditably equivalent outputs.

Remaining work:

- Audit, cherry-pick, or explicitly reject remaining upstream/runtime items:
  background-worker disable semantics, artifact cache fixes,
  data-directory-locking deltas, upstream `postgresConfig` parity beyond the
  Rust startup-GUC API, and `pgoutput` symbol exports.
- Decide whether future config changes flow through the Rust startup-GUC API, a
  pinned upstream `postgresConfig` surface, or a documented initdb-time config
  model.
- Record Wasmer crate version, Wasmer CLI/tool version, wasixcc/toolchain
  version, WASIX libc/EH-PIC sysroot identity, LLVM version,
  `postgres-pglite` commit, `pglite-build` commit, extension repository
  commits, Docker image digest, and build profile everywhere release artifacts
  need provenance and cache invalidation.
- Use Wasmer reproducible-build controls such as `WASMER_REPRODUCIBLE_BUILD=1`
  where applicable.
- Add deterministic two-build comparisons for identical source pins.
- Make asset and AOT crate hashes stable enough for audit and cache
  invalidation.

### P1-05: Expand Runtime Correctness And Protocol Coverage

Outcome: the protocol and runtime boundary stays PostgreSQL-owned where
PostgreSQL can speak, with broader coverage for less common behavior.

Remaining work:

- Continue expanding PostgreSQL regression coverage beyond the current PGlite
  parity subset into less common planner, catalog, lock, utility-command, and
  wait/socket behavior.
- Add broader raw wire-protocol and fuzz coverage around extended query
  sequencing.
- Decide whether proxy/frontend startup should eventually stop fabricating
  startup responses in Rust and converge further toward upstream
  `interactive_one`/`ProcessStartupPacket` lifecycle for every client
  connection.
- Harden backend-side COPY error coverage beyond the current suite.
- Investigate returning from COPY streaming continuation to buffered mode after
  COPY if it can be proven correct for SQLx, `tokio-postgres`, raw TCP, Unix
  sockets, `CopyFail`, and post-COPY reuse.
- If a future Wasmer version resumes the C `sigsetjmp` boundary directly,
  remove or demote the explicit recovery export only after tests prove the
  fallback is unnecessary.

### P1-06: Harden Extension Failure Modes

Outcome: extension behavior fails early and clearly when dependencies, load
order, startup configuration, or runtime identity are wrong.

Remaining work:

- Add negative fixtures proving wrong-core side modules and unresolved imports
  fail during validation before runtime startup.
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
- Add automation that updates `assets/extensions.smoke.toml` from reviewed
  smoke-suite output instead of requiring maintainers to edit it by hand.
- Add a Rust-native live-query API before exposing PGlite `live`; until then,
  leave it unpublished.

### P1-07: Build Missing Ecosystem Examples And Tests

Outcome: advertised non-SQLx client compatibility is backed by runnable examples
and CI.

Remaining work:

- Add examples and CI for rstest, Diesel, SeaORM, pgvector local RAG,
  Python/psycopg, Go/pgx, and Node `pg`.
- Add Python, Go, and Node proxy examples that verify SQLSTATE preservation and
  recovery behavior through ordinary client libraries.
- Ensure every first-screen client/library claim in README has a smoke test,
  example, or tracked gap.

### P1-08: Split Runtime And Extension Payloads By Feature

Outcome: users receive only the payload classes implied by selected features.

Remaining work:

- Split packaged runtime payloads from extension payloads after the `bundled`
  feature model lands.
- Make `bundled` runtime-only at download/package-size level.
- Move extension archives and extension AOT artifacts behind `extensions`.
- Preserve exact internal dependency versions and package-size gates during the
  split.

## P2 Experiments And Future Tracks

Experiments are real work. Each must report timing, correctness, state
isolation, artifact size impact, and implementation risk before promotion.

Decision states:

- `promoted`: implementation is on the production path;
- `blocked`: evidence and blocker are documented;
- `rejected`: reason and alternative are documented.

Do not leave runtime-affecting experiments as loose notes.

### P2-01: Snapshot/Journaling Restore

Evaluate WASIX journaling, Wasmer `StoreSnapshot`, or InstaBoot-style restore
only with a small upstream repro or a fixed journal layer. The last local spike
passed `SELECT 1` from an instance-created restore but did not skip Postgres
startup; backend-ready/protocol-ready snapshots were too slow and failed fd
seek replay.

Promotion requires proof for PGDATA state, file descriptors, protocol state,
extensions, error recovery, `pg_dump`, restart, and package-size impact.

### P2-02: Alternative Wasm Engines

Evaluate Cranelift with direct `SELECT 1`, SQL error recovery, representative
extension create/query, server SQLx smoke, compile speed, and cross-platform
exception/dynamic-linking behavior.

Evaluate Singlepass only after the same longjmp/error and extension suite
passes.

### P2-03: Mobile And Alternate Hosts

Evaluate Asyncify only if a specific snapshot or journaling path proves a need
on an experiment branch.

Evaluate V8, JavaScriptCore, or other engines only for mobile or special
embedded targets, checking WASIX, dynamic linking, filesystem, exceptions, and
headless/AOT implications.

Experimental targets:

- Linux musl;
- Android;
- iOS through V8/JSC/interpreter paths if feasible;
- RISC-V after Wasmer target support matures.

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
