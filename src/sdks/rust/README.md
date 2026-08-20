# Oliphaunt Rust SDK

`oliphaunt` embeds PostgreSQL 18 through the native `liboliphaunt` runtime. The
public API is intentionally small and PostgreSQL-shaped: open, execute, query,
transaction, checkpoint, cancel, physical backup, restore, and close.

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

`execute` and `execute_with_params` return `CommandResult`. `query` and
`query_with_params` return `QueryResult`. Both expose the PostgreSQL command tag
and row count reported by PostgreSQL. Query results additionally expose field
metadata and rows. SQL errors are returned as structured `PostgresError` values.

`transaction` pins the one SDK-owned physical session while its callback runs.
It commits on success and rolls back a callback failure. A transport failure at
COMMIT is treated as an uncertain outcome: the SDK does not issue a misleading
ROLLBACK and the handle must be closed. PostgreSQL's known `COMMIT` → `ROLLBACK`
response remains a recoverable, idle-session error.

For COPY, multi-result responses, or another protocol flow that the typed
helpers cannot represent, use the buffered `exec_protocol_raw` escape hatch.
The SDK deliberately does not publish a second parser or streaming abstraction.

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

Oliphaunt::restore(".oliphaunt-restored", backup)?;
# Ok(())
# }
```

The archive is a PostgreSQL physical initialization payload. It contains
PGDATA and its backup metadata, not the outer managed-root descriptor. Restore
creates and validates the receiving root and publishes `.oliphaunt.json` only
after complete PGDATA exists.

## Local server

`open_server()` returns `OliphauntServer`, including a nonoptional libpq
connection string for standard PostgreSQL clients. Its SDK-owned connection has
the same execute, query, transaction, checkpoint, cancellation, raw protocol,
and close vocabulary as an embedded database.

The server handle deliberately has no SDK backup method. Use standard PostgreSQL
tools: packaged `pg_basebackup` for physical backups, and `pg_dump`, `pg_restore`,
or `psql` for logical workflows.

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
