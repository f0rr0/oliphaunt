# Native libpglite PG18 Path

The native product is split into two repo boundaries:

- `libpglite/` owns the C ABI, PostgreSQL 18 source pin, patch stack, build
  scripts, C smoke harness, and runtime header.
- `crates/libpglite-oxide/` owns the Rust SDK shape over that C ABI.

The existing `pglite-oxide` crate and WASIX release lane remain in place while
the native path is built out separately.

## Source And Patch Stack

The C lane is pinned in:

```text
libpglite/postgres18/source.toml
```

It currently targets PostgreSQL `18.3` and applies the patch stack in
`libpglite/patches/postgresql-18.3`.

The entrypoint does not use `postgres --single`. It adds a dedicated embedded
backend entrypoint, routes libpq backend reads/writes through host-owned I/O
callbacks, and runs PostgreSQL's normal exit callbacks without calling
`exit(3)`.

## Build

Build the macOS happy-path dylib with:

```sh
libpglite/bin/build-postgres18-macos.sh
```

The script emits:

```text
target/libpglite-pg18/out/libpglite.dylib
target/libpglite-pg18/install/bin/initdb
target/libpglite-pg18/install/bin/postgres
```

`ccache` is used automatically when available. Set `LIBPGLITE_CCACHE=off` to
disable it, or set `LIBPGLITE_CCACHE=/path/to/ccache` to force a specific
binary. The older `PGLITE_OXIDE_NATIVE_*` variables still work as migration
fallbacks.

## C ABI Contract

The canonical header is:

```text
libpglite/include/libpglite.h
```

The current ABI is intentionally small:

- `pglite_init`
- `pglite_exec_protocol`
- `pglite_close`
- `pglite_last_error`
- `pglite_version`
- `pglite_capabilities`
- `pglite_free_response`

`pglite_exec_protocol` accepts frontend PostgreSQL protocol frames after
`pglite_init` has initialized the embedded backend session. Responses are owned
by the native library until `pglite_free_response`.

Native v1 is one embedded PostgreSQL lifetime per process. A second same-process
`pglite_init` after close is rejected deliberately because PostgreSQL 18 leaves
process-global state that is not safely reusable without a deeper reset or
broker design.

## Rust SDK

Point the Rust SDK at the build outputs:

```sh
export LIBPGLITE_OXIDE_LIBPGLITE="$PWD/target/libpglite-pg18/out/libpglite.dylib"
export LIBPGLITE_OXIDE_INITDB="$PWD/target/libpglite-pg18/install/bin/initdb"
export LIBPGLITE_OXIDE_POSTGRES="$PWD/target/libpglite-pg18/install/bin/postgres"
```

```rust,no_run
use libpglite_oxide::{LibPgliteRuntime, Pglite, SqlParam, INT4_OID};

# async fn demo() -> libpglite_oxide::Result<()> {
let db = Pglite::builder()
    .path(".libpglite-oxide")
    .runtime(LibPgliteRuntime::from_env())
    .open()
    .await?;

let row = db.query_one("SELECT 1::int4 AS value").await?;
let value: i32 = row.get("value")?;
assert_eq!(value, 1);

let description = db
    .describe_typed("SELECT $1::int4 AS value", [INT4_OID])
    .await?;
assert!(description.returns_rows());
assert_eq!(description.parameters()[0].type_oid, INT4_OID);
assert_eq!(description.columns()[0].name, "value");

db.execute("CREATE TABLE demo(id int)").await?;
let outcome = db
    .execute_params("INSERT INTO demo VALUES ($1)", [SqlParam::from(1_i32)])
    .await?;
assert_eq!(outcome.rows_affected, 1);

db.listen("app_events").await?;
let notified = db.query("NOTIFY app_events, 'ready'").await?;
assert_eq!(notified.notifications()[0].payload, "ready");
db.unlisten("app_events").await?;

let by_id = db
    .prepare_typed("SELECT $1::int4 AS value", [INT4_OID])
    .await?;
let row = by_id.query_one_params([SqlParam::from(2_i32)]).await?;
let value: i32 = row.get("value")?;
assert_eq!(value, 2);
by_id.close().await?;

let tx = db.transaction().await?;
tx.execute_params("INSERT INTO demo VALUES ($1)", [SqlParam::from(2_i32)])
    .await?;
tx.commit().await?;

db.close().await?;
# Ok(())
# }
```

When the environment variables above are set, `Pglite::open(path).await` and
`Pglite::temporary().await` are concise shortcuts over the default builder.
Use `Pglite::open_metrics()` to inspect runtime-provided open-phase timings.
The native libpglite runtime reports root preparation, runtime materialization,
dynamic-library load, and `pglite_init` phases.
On Unix, fully accepted runtime share subtrees and PostgreSQL loadable modules
are materialized as symlinks with a copy fallback. Filtered directories such as
`extension` and selected `tsearch_data` files remain explicit per-file
materialization. `bin/postgres` and `bin/initdb` stay copied into the per-open
runtime tree so PostgreSQL derives `$sharedir` and `$libdir` from the expected
runtime-root-relative executable path.
The high-level Rust API rejects PostgreSQL COPY streaming frames and suspended
portal responses with typed `UnsupportedFeature` errors. Those states remain
available through `exec_protocol_raw(...)` or `exec_protocol_raw_stream(...)`
for callers that want to own raw protocol handling.

Without `LIBPGLITE_OXIDE_LIBPGLITE`, the native runtime returns a clear startup
error. The old `pglite-oxide` crate is still the WASIX-oriented release lane.

## Smoke Tests

Use the C smoke as the fastest C ABI harness:

```sh
libpglite/bin/smoke-macos-happy-path.sh
```

It compiles the tiny C harness, opens a database, sends raw protocol bytes for
`SELECT 1 AS value`, closes cleanly, then launches the harness again against the
same PGDATA root to verify persistence/reopen across process boundaries.

Use the Rust SDK shape test for the separate package:

```sh
LIBPGLITE_OXIDE_LIBPGLITE="$PWD/target/libpglite-pg18/out/libpglite.dylib" \
LIBPGLITE_OXIDE_INITDB="$PWD/target/libpglite-pg18/install/bin/initdb" \
LIBPGLITE_OXIDE_POSTGRES="$PWD/target/libpglite-pg18/install/bin/postgres" \
cargo test -p libpglite-oxide --test sdk_shape -- --nocapture
```

## Current Deliberate Gaps

- No same-process native reopen; use one native lifetime per process for now.
- Native direct mode is feasible and validated against the C ABI. It exposes
  parsed rows, typed getters, command outcomes, notices, notifications,
  backend session metadata, database errors, and a raw protocol escape hatch.
  Column metadata preserves PostgreSQL `RowDescription` table OIDs, table
  attribute numbers, type OIDs, type sizes, modifiers, and formats. Parsed
  session metadata includes `ParameterStatus`, `BackendKeyData`, and
  `ReadyForQuery` transaction status. Parameterized query helpers use
  PostgreSQL's extended protocol. `describe` and `describe_typed` use PostgreSQL
  `Parse` + `Describe` without `Execute`, returning parameter and result-column
  metadata. `listen`, `unlisten`, and `unlisten_all` safely quote notification
  channel identifiers. Direct mode does not run a background receiver or
  callback loop; PostgreSQL notifications are exposed on
  `QueryResult::notifications()` for responses that include
  `NotificationResponse` frames. Reusable prepared statements send named
  `Parse` once and then reuse the backend statement with `Bind`/`Execute`; they
  are scoped to the physical backend session and should be explicitly closed
  when no longer needed. Prepared statements can also be described without
  execution. `SessionPin` and `Transaction` expose the same high-level query,
  one-row, optional-row, describe, execute, and named-prepare helpers as the
  top-level handle where valid. Statements created through a `SessionPin` or
  `Transaction` return `Error::InvalidSessionPin` after that pin is released.
  Dropping an unclosed statement enqueues a best-effort cleanup request; pinned
  cleanup runs only while the pin is still active. Transactions pin the direct
  session, surface PostgreSQL `BEGIN`/`COMMIT`/`ROLLBACK` errors, and
  best-effort rollback on drop. `checkpoint` is supported. Backup request
  formats are modeled explicitly, but `LibPgliteRuntime` returns typed
  `UnsupportedFeature` errors for logical SQL, physical archive, and product
  archive backups today. Native direct v1 cannot safely quiesce, archive, and
  reopen the same embedded PostgreSQL process, and it has no pg_dump/server path
  for logical backups yet.
- Native server mode is not implemented and should not be faked by multiplexing
  direct mode. It needs true independent PostgreSQL sessions through a new C ABI
  or a helper/server process.
- Extension packs are materialized for selected PG18-supported extensions, but
  signed custom manifests and mobile static registries are not complete yet.
- No native broker implementation yet.
- No native server implementation yet.
- No Swift, Kotlin, or React Native package until the Rust SDK boundary settles.

## Benchmark Notes

The local benchmark harness supports `xtask perf native-libpglite` for direct
PG18 and `xtask perf native-postgres` for native PostgreSQL controls. Native
Postgres benchmark roots default to a short `/tmp/pglite-oxide-perf` path on
Unix so PostgreSQL's Unix-domain socket path limit does not invalidate local
comparisons from long checkout paths.

Use `xtask perf native-libpglite-sdk --iterations N` to measure the high-level
Rust SDK path directly. It compares `query_params` against reusable
`PreparedStatement` on one direct-mode PG18 backend session.

Use `xtask perf native-libpglite-open` and `xtask perf native-postgres-open`
to profile open/startup phases. The native matrix runner includes both profiles
and emits an `Open Phase Profile` section in its report.

For promotion comparisons, run the matrix with a stable pglite-oxide worktree:

```bash
tools/scripts/perf/run_native_libpglite_matrix.sh \
  --stable-worktree /path/to/stable/pglite-oxide
```

The stable lane runs that worktree's release `xtask` from that worktree's root,
then adds stable direct/server RTT, speed, and prepared-update rows to the same
report. This keeps PG18 native direct, native PostgreSQL, current WASIX, and
stable pglite-oxide measurements in one run directory with the same iteration
counts, SQL source, resource parser, and summary gates. The stable worktree must
be clean for production comparison runs; use `--allow-dirty-stable` only when
smoking the harness itself, and do not treat that output as a stable baseline.
When current-branch WASIX modes are enabled, the runner first checks the
current crate asset metadata, then preflights
`target/pglite-oxide/assets/manifest.json`, `pglite.wasix.tar.zst`, and the
host AOT manifest before starting native controls. It requires PostgreSQL major
`18` by default and rejects runtime/AOT module hash mismatches. Override the
expected major with `--wasix-postgres-major` only for non-PG18 experiments.
Explicit `PGLITE_OXIDE_RUNTIME_ARCHIVE` / `PGLITE_OXIDE_RUNTIME_TAR` values are
blocked for production matrix runs because they do not prove AOT/runtime
coherence; `PGLITE_OXIDE_PERF_ALLOW_EXTERNAL_RUNTIME=1` is smoke-only.
