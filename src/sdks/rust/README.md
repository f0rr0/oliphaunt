# Oliphaunt Rust SDK

`oliphaunt` embeds PostgreSQL 18 through the native `liboliphaunt` runtime. The
public API is intentionally small and PostgreSQL-shaped: open, execute, query,
exec, describe, transaction, cancel, physical backup, restore, and
close.

## Installation

Add `oliphaunt` and use `oliphaunt-build` from the build script so the matching
native runtime, tools, and selected extension artifacts are staged for the
target platform.

<!-- liboliphaunt-doc-example:rust-build-script -->
```rust
fn main() {
    oliphaunt_build::configure();
}
```

## Direct and broker databases

Direct mode is the default. It runs the embedded backend in the application
process. Broker mode uses the same database API while placing that backend in a
helper process.

The root API is asynchronous in every topology. Open constructs PostgreSQL on
the SDK's permanent owner thread; query, backup, restore, cancellation, and
close therefore do not perform their blocking native or transport work on the
thread polling the returned future. There is deliberately no public native
blocking facade yet: a distinct caller-thread implementation remains gated on
repeatable benchmarks showing a material benefit.

<!-- liboliphaunt-doc-example:rust-basic-query -->
```rust
use oliphaunt::{Oliphaunt, QueryParam};

# async fn example() -> oliphaunt::Result<()> {
let db = Oliphaunt::builder()
    .directory(".oliphaunt")
    .startup_guc("application_name", "my-app")
    .open()
    .await?;

db.execute_with_params(
    "INSERT INTO events(value) VALUES ($1)",
    [QueryParam::from("ready")],
).await?;
let result = db.query("SELECT value FROM events").await?;
assert_eq!(result.get_text(0, "value")?, Some("ready"));
db.close().await?;
# Ok(())
# }
```

Select broker mode with `.broker()`. An explicit
`.broker_executable(path)` is normally only needed by development and packaging
harnesses; installed packages resolve their helper artifact automatically.
Topology-specific options are terminal-checked: `broker_executable` requires
`broker().open()`, while `listen` and `server_executable` require
`open_server()`. Mismatched options return `InvalidConfig` instead of being
silently ignored.

`execute` and `execute_with_params` assert one command with no rows. `query` and
`query_with_params` accept a command-only or row-producing statement and return
ordered raw cells, complete field metadata, command metadata, notices, and
typed access through `FromSql`. `exec` returns ordered command-or-rows results
for simple-query SQL, while `describe` resolves parameter OIDs and optional
result fields without executing. Call `db.describe(sql)` for an unparameterized
statement, or `db.sql(sql).bind(...).describe()` when PostgreSQL needs explicit
parameter values or type OIDs.

`Parameter` carries an optional `TypeOid`, `ValueFormat`, and nullable owned
bytes. `IntoParameter` covers common host values and typed nulls; use explicit
text/binary parameters with a custom OID for extension types. Typed getters
validate OID and format, reject ambiguous duplicate names, and preserve raw
access as the lossless fallback. SQL errors are structured `PostgresError`
values with operation notices.

`is_closed()` reports that the database handle is terminally retired. It becomes
true after successful teardown and after teardown starts but fails; it remains
false for a pre-teardown `TransactionActive` validation error. `transaction`
pins the one physical session and mirrors query, execute, exec, and describe.
One-shot `rollback()` closes the transaction and lets its callback return
without committing. A failed rollback or uncertain COMMIT poisons the database
and does not issue a misleading second control command.

`close().await` is an ordered queue boundary: operations admitted first drain,
including an already-admitted `BEGIN`, and later application work is rejected.
If that earlier work leaves a transaction active, close returns
`Error::TransactionActive` without discarding the session; finish the
transaction and retry close. Required `COMMIT` or `ROLLBACK` for a `BEGIN`
admitted before the cutoff remains admissible in the same FIFO while close is
pending. Concurrent close calls share the same attempt. Once runtime teardown
starts, the handle is terminal even if teardown reports an error; repeated
close calls return the same stored result and all other work is rejected.

For COPY or another protocol flow that the structured helpers cannot represent,
use `exec_protocol_raw` for one owned response or
`exec_protocol_raw_stream` to consume backend protocol chunks as they arrive.
The stream is the raw PostgreSQL protocol; the SDK does not publish a second
parser or a separate COPY-specific abstraction. Stream callbacks execute
synchronously and serially on the owner thread, and their borrowed chunk is
valid only until the callback returns. A slow callback applies backpressure.
Returning an error or panicking stops delivery after the runtime drains back to
`ReadyForQuery`; the database remains usable. Do not wait on another operation
on the same database from the callback—reentrant owner work is rejected.

`cancel().await` sends cancellation out of band. It does not wait behind the
query queue and it does not replace awaiting the query future, which reports
PostgreSQL's final result. Starting close cuts off new SQL but cancellation
remains accepted while earlier SQL drains; it is rejected only when destructive
teardown begins or the handle is terminal. Dropping a query future only
abandons its reply: work which has not started is skipped, while work already
executing runs to its normal readiness boundary.

## Physical backup and restore

Direct and broker databases expose one physical backup format as bytes. Restore
is a static operation into an absent or empty destination. It never overwrites
an existing managed database.

<!-- liboliphaunt-doc-example:rust-backup-restore -->
```rust
use oliphaunt::Oliphaunt;

# async fn example() -> oliphaunt::Result<()> {
let source = Oliphaunt::builder()
    .directory(".oliphaunt-source")
    .open()
    .await?;
let backup = source.backup().await?;
source.close().await?;

Oliphaunt::restore(".oliphaunt-restored", backup).await?;
# Ok(())
# }
```

The archive is a PostgreSQL physical initialization payload. It contains
PGDATA and its backup metadata, not the outer managed-root descriptor. Restore
creates and validates the receiving root and publishes `.oliphaunt.json` only
after complete PGDATA exists. Restore copies its input, then performs native and
filesystem work on a dedicated blocking thread.

## Local server

`open_server()` returns `OliphauntServer`, including a nonoptional libpq
connection string for standard PostgreSQL clients. Its SDK-owned connection has
the same execute, query, transaction, cancellation, raw protocol,
and close vocabulary as an embedded database.

The default listener is IPv4 loopback with an automatically assigned port.
Select a fixed loopback port or, on Unix hosts, a PostgreSQL socket directory:

<!-- liboliphaunt-doc-example:rust-open-server -->
```rust,no_run
use oliphaunt::{Oliphaunt, ServerListen};

# async fn open() -> oliphaunt::Result<()> {
let server = Oliphaunt::builder()
    .listen(ServerListen::tcp_port(15432))
    .open_server()
    .await?;
println!("{}", server.connection_string());
server.close().await?;
# Ok(())
# }
```

Call `open_server()` without `.direct()` or `.broker()`. Embedded topology
selectors and broker-only options are rejected at this terminal, just as
server-only options are rejected by `open()`.

The server handle deliberately has no SDK backup method. Use `pg_basebackup`
for a standard server physical backup. The optional `oliphaunt-tools` crate
provides endpoint-oriented plain `pg_dump` and non-interactive `psql` runners;
the core `oliphaunt` crate does not depend on or install client tools.

<!-- liboliphaunt-doc-example:rust-native-pg-dump -->
```rust,no_run
use oliphaunt_tools::{PgDumpOptions, pg_dump};

# fn dump(connection_string: &str) -> Result<String, oliphaunt_tools::PostgresToolError> {
pg_dump(connection_string, PgDumpOptions::new().arg("--schema-only"))
# }
```

Pass `server.connection_string()` to the standard tool and keep PostgreSQL's
streamed-WAL behavior explicit:

```sh
pg_basebackup --dbname "$CONNECTION_STRING" --pgdata ./server-backup --wal-method=stream
```

## Storage ownership

A persistent database is a managed root:

```text
.oliphaunt.json
pgdata/
```

The descriptor has one exact five-field schema: schema name, engine family,
PGDATA directory name, PostgreSQL major, and physical format. It describes the
root layout; it is not a lock file and it does not encode an SDK or host
language. Native and WASIX descriptors are both valid when family and format
form one of the two defined pairs.

Opening validates before mutating. Existing roots must have PostgreSQL 18
`PG_VERSION`, a real `global` directory with nonempty `global/pg_control`, and a
real `pg_wal` directory. Symlink roots and symlink structural directories are
rejected. The descriptor is written last during initialization.

The SDK prevents two supported owners from opening the same managed root at the
same time by using a sibling admission lock. It does not add a public cross-SDK
coordination protocol, and concurrent mutation by unrelated runtimes remains
application error.

## Extensions and platform support

Choose extensions with `.extension(Extension::...)` or `.extensions(...)`.
Selection uses exact PostgreSQL SQL names and the generated PostgreSQL 18
catalog. Build and release tooling owns artifact resolution; the runtime API does
not expose package manifests, size reports, capability profiles, or packaging
internals.

Supported native products and targets are declared by the repository SDK
manifest and release packages. WASIX is a separate binding family and is not a
fallback mode of this crate.
