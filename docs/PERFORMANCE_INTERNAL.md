# Performance Internals

This page is maintainer documentation for performance tuning, measurement
harnesses, and release profiling. Public benchmark results now live in
`docs/PERFORMANCE.md`.

`pglite-oxide` is optimized for test setup and local-app startup. The runtime
avoids user-side compilation: supported targets load packaged Wasmer AOT
artifacts and reuse cached runtime files.

## Fast Startup Practices

For test suites:

- use `Pglite::temporary()` or `PgliteServer::temporary_tcp()`;
- reuse the process when possible so the template and module caches stay warm;
- keep Postgres client pools at one connection;
- call `Pglite::preload()` once before a visible UI path or a large test group;
- call `Pglite::preload_extensions([...])` when extension setup is on the hot
  path.

Example:

```rust,no_run
use pglite_oxide::{extensions, Pglite};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    Pglite::preload_extensions([extensions::VECTOR])?;

    let mut db = Pglite::builder()
        .temporary()
        .extension(extensions::VECTOR)
        .open()?;

    db.exec("CREATE TABLE items (embedding vector(3))", None)?;
    Ok(())
}
```

## Cache Layers

The runtime uses several cache layers:

- a process cache for loaded modules;
- a persistent AOT artifact cache;
- a runtime asset cache for immutable files;
- an extension asset cache;
- a template PGDATA cache for roots that use template initialization;
- an eager PGDATA template overlay that avoids cloning the whole initialized
  template before first query.

The older full-local path hardlinks immutable files into database roots when
the filesystem supports it, then falls back to copying when linking is
unavailable. The default path avoids that per-root immutable-file population.

## Default Filesystem Fast Path

By default, database roots use Wasmer filesystem composition. Fresh roots use a
pure mount-composition layout: immutable runtime files are served from the
shared cached lower runtime, while the per-root upper layer contains only
mutable state, device/tmp files, and the extension assets explicitly requested
for that root. The same prepared layout is used by direct databases, persistent
paths, app-id paths, fresh and cached temporary databases, proxy roots, and
local server mode.

The eager PGDATA template overlay is also enabled by default. It mounts the
cached initialized template as the lower `/base` filesystem and starts each
database with a tiny per-instance upper directory. When PostgreSQL opens a
template-backed file for mutation, the runtime copies that one file into the
upper directory before opening it.

This is intentionally not a pre-provisioned pool: each database root is still
created on demand and owns its mutable files. In local release runs, runtime
composition is now about 0.6-0.9ms, down from roughly 7ms for the previous
per-root asset population. PGDATA setup is under 1ms. The remaining direct
first-query costs are mostly PostgreSQL backend startup, Wasmer instance
creation, and the protocol roundtrip for the query itself.

Direct `Pglite::open` no longer runs a separate session-setup query. Direct
session defaults are applied during startup before connection data is sent, not
through SQL. The regenerated WASIX runtime owns this as a required
`pgl_apply_default_gucs` bridge helper.

Direct `Pglite` no longer forces a host directory `sync_all` after every
non-transaction query. PostgreSQL's own WAL/fsync behavior owns durability; the
extra Rust-side directory sync was expensive and weaker than file-level database
fsyncs. This matches the server path, which did not pay that cost.

Direct `Pglite` also no longer scans `pg_type` on scalar open/query paths.
Built-in PostgreSQL array OIDs are registered statically in the Rust direct
client. Runtime-created enum/domain/composite arrays are discovered lazily when
they appear in direct API parameters or result metadata, or explicitly through
`Pglite::refresh_array_types()`.

The WASIX startup arguments explicitly preserve PGlite's effective buffer
profile: `shared_buffers=128MB`, `wal_buffers=4MB`, and `min_wal_size=80MB`.
This matters for PGlite benchmark parity. Without those GUCs, single-user
startup fell back to a tiny `shared_buffers=400kB`, causing table-copy and
indexed-update workloads to reread relation pages from the host filesystem.

Detailed C-side backend startup timers are an instrumented-build diagnostic, not
production runtime surface. Build WASIX assets with
`PGLITE_OXIDE_WASIX_BACKEND_TIMING=1` when investigating `shared_memory`,
`InitPostgres`, or relcache work. Production WASIX artifacts leave that flag off,
so timing macros compile away and the `pgl_backend_timing_elapsed_us` export is
absent.

Nested child mounts inside a supplied `WasiFsRoot` were tested first. They were
rejected because Wasmer's `WasiRunner::prepare_webc_env` rebuilds the final
mount tree from the supplied `/` filesystem plus runner-owned mounts, so child
mounts must be passed as runner mounts or represented inside the root
filesystem itself.

## Release Asset Profile

The default asset release profile is `release-o3`: WASIX C modules are compiled
with `-O3 -g0 -flto=thin`, linked with `-flto=thin`, then Binaryen runs with the
wasixcc default optimization level plus `--converge`, `--strip-debug`, and
`--strip-producers`. This is the current SQL-workload profile: local PGlite
benchmark parity runs showed broad speed wins over non-LTO O3 and `release-os`,
and package-size checks still stayed comfortably under crates.io limits.

Available profile knobs:

- `PGLITE_OXIDE_BUILD_PROFILE=release-o3` is the default release asset profile;
- `release`, `release-o3`, `release-os`, and `release-oz` remain available for
  comparison builds. `release-o3` is the performance profile and includes
  ThinLTO by default;
- set `PGLITE_OXIDE_WASM_OPT_FLAGS=none` to disable the release-profile
  Binaryen converge/strip extras for local build iteration;
- set `PGLITE_OXIDE_WASM_OPT_FLAGS='<colon-separated flags>'` to override the
  release-profile Binaryen extras.

The WASIX toolchain already enables the relevant Wasm feature baseline for this
EH+PIC sysroot, including SIMD, relaxed SIMD, and extended const. Adding an
extra `-msimd128` did not change the generated AOT artifact sizes in the local
release experiment, so it is not carried as a project-specific flag.

Wasmer LLVM AOT is generated with the selected mainline codegen profile:
nonvolatile memory operations and a readonly funcref table. Local exact PGlite
speed-suite measurements showed nonvolatile memory operations improving the
server SQLx suite by about 9% geomean. Adding the readonly funcref table on top
was about 1.4% faster geomean than nonvolatile-only and improved the indexed
update cases (`557.152ms -> 534.737ms` and `695.663ms -> 681.778ms`), while
regressing CREATE INDEX and DROP TABLE cases. Wasmer documents nonvolatile
memory operations as faster but not fully WebAssembly-spec compliant; this is a
conscious mainline runtime-profile decision for the packaged single-process
Postgres runtime and must stay covered by the correctness matrix.

WebAssembly exceptions are mandatory for production artifacts. The Postgres
runtime depends on exception/longjmp recovery across the main module and side
modules, so there is no supported non-EH fallback and no opt-out flag. Asyncify
is not part of production builds; it may only be used in an isolated
snapshot/journaling experiment if a specific restore design proves it needs
that control-flow model. The build scripts reject Asyncify flags by default;
`PGLITE_OXIDE_ALLOW_ASYNCIFY_EXPERIMENT=1` is reserved for local experiment
branches only.

WASIX dynamic linking is also mandatory. The main module is built as a
dynamic-main module, extension/tool modules are PIC side modules, and all
runtime, extension, and `pg_dump` artifacts must come from the same configured
source tree.

## Native Deserialization

The runtime loads Wasmer AOT artifacts through Wasmer's native mmapped-file
deserializer. This keeps the startup path off the old read-the-whole-native-
artifact path and does not reintroduce full artifact hashing. There is no
runtime opt-out for the older file deserializer.

## Strict Verification

By default, startup avoids content-hashing bundled assets. Cached Wasmer AOT
artifacts use fast receipt verification: the runtime checks the cache receipt
and file metadata, then lets Wasmer deserialize the cached native artifact. If
deserialization fails, the cache entry is deleted, rebuilt once from the bundled
artifact, and retried.

Set `PGLITE_OXIDE_AOT_VERIFY=full` to force full SHA-256 verification of cached
AOT files, bundled runtime archives, bundled extension archives, PGDATA template
archives, and runtime/template module matches. This is useful for debugging
cache corruption or CI integrity checks, but it adds cold-start latency and is
not the default.

## Snapshot And Journal Work

Wasmer 7.2 exposes WASIX journal/process snapshot APIs, and `StoreSnapshot`
captures store globals. That is not enough by itself to ship an instant restore
path for Postgres: a promoted design must prove correctness for PGDATA state,
mount state, file descriptors, direct protocol state, server mode, extensions,
and `pg_dump`. This remains a first-class performance track, but it must beat
the current template/overlay path while passing the same runtime and extension
suite before it becomes default.

## Measuring Locally

The smoke benchmark prints preload and open timings:

```sh
cargo test --test performance_smoke -- --nocapture
```

To measure the current cold-start path:

```sh
cargo run -p xtask -- perf cold
```

This runs operations sequentially in one process. Each operation reports
`cacheStateBefore`, `processStateBefore`, `rootState`, `queryState`, and
`workload`, so a "first query" is explicitly the first query for that
operation's newly opened root/server, not necessarily a cold cache or cold
process. Each operation also reports `primaryLatencyPhase` and
`primaryLatencyMicros`; this is the user-visible latency target for that
operation and excludes cleanup/teardown where appropriate.

To include first-install cache bootstrap costs in the first measured preload:

```sh
cargo run -p xtask -- perf cold --reset-cache
```

To measure true warm behavior after startup, use the warm harness:

```sh
cargo run -p xtask -- perf warm
```

It keeps databases/servers alive and measures repeated direct queries,
transactions, SQLx/tokio-postgres queries, repeated SQLx connections, and
extension-backed queries separately from open and shutdown phases. Use
`--iterations N` and `--connections N` for shorter local probes.

To run product-style SQL benchmarks similar to PGlite's published benchmark
families:

```sh
cargo run --release -p xtask -- perf bench
```

This emits JSON with two benchmark suites:

- `rtt`: PGlite-style CRUD round-trip microbenchmarks. Each query runs many
  times, the lowest and highest 10% are discarded when enough samples exist,
  and the trimmed average is reported.
- `speed`: a generated SQLite speedtest-style SQL suite with large insert,
  select, update, index, delete, and drop workloads.

The RTT suite can run through the direct Rust API, through `PgliteServer` with a
single long-lived SQLx connection, and through `PgliteServer` with a raw
`tokio-postgres` simple-query-protocol connection. The raw `tokio-postgres`
mode is there to separate proxy/wire overhead from SQLx client overhead:

```sh
cargo run --release -p xtask -- perf bench --suite rtt --mode server-sqlx
cargo run --release -p xtask -- perf bench --suite rtt --mode server-tokio-postgres-simple
cargo run --release -p xtask -- perf bench --suite speed --mode direct --scale 0.05
cargo run --release -p xtask -- perf bench --suite speed --speed-source pglite
```

The speed suite is generated locally instead of vendoring PGlite's generated
multi-megabyte SQL files. Use `--scale` for quick local probes and `--scale 1`
for the full default shape. Use `--speed-source pglite` when you need exact
parity with the SQL files checked out under
`assets/checkouts/pglite/packages/benchmark/src`; this mode requires
`--scale 1`.

To compare simple-query indexed updates against parameterized prepared updates
and client pipelining:

```sh
cargo run --release -p xtask -- perf prepared-updates
cargo run --release -p xtask -- perf prepared-updates --skip-native
cargo run --release -p xtask -- perf prepared-updates --skip-native --gate
```

This parses the exact update values from PGlite benchmark Tests 9 and 10, uses
the same indexed-table setup, and measures SQLx sequential prepared execution,
tokio-postgres sequential prepared execution, tokio-postgres pipelined prepared
execution over TCP and Unix sockets, and the same tokio-postgres modes against
native Postgres. Use `--skip-native` when local native Postgres IPC state is not
healthy or when only PgliteServer modes are needed. This is a server/protocol
benchmark; it does not replace the exact PGlite simple-query suite.

`--gate` is a local regression smoke gate, not a final CI performance oracle.
It checks the transport shape that caused the COPY/prepared-update regression:
non-COPY prepared traffic must not activate the backend-owned streaming
continuation, pipelined prepared traffic must remain batched, SQLx and
sequential tokio-postgres must stay below 5s per 25k updates, and pipelined
tokio-postgres must stay below 1.5s per 25k updates. The command emits per-run
protocol counters so failures show whether the problem is batching, protocol
pump activation, or backend execution.

For focused investigation of indexed update hotspots, run:

```sh
cargo run --release -p xtask -- perf diagnose-indexed-update
cargo run --release -p xtask -- perf diagnose-buffer-cache
```

This opens fresh temporary databases, runs setup outside the measured section,
then compares exact PGlite Test 9/10 SQL against controlled variants: lookup
index only, unlogged table, text update after numeric update, vacuumed variants,
and one set-based update. The buffer-cache diagnostic runs
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for the remaining table-copy hotspots
and reports the effective Postgres memory GUCs plus host filesystem trace data.

Treat these numbers as machine-local diagnostics. CI performance gates and
release targets depend on the runner, host filesystem, and cache state.
