# Oliphaunt Rust SDK

`oliphaunt` embeds PostgreSQL 18 through the native `liboliphaunt` runtime. The
public API is intentionally small and PostgreSQL-shaped: open, execute, query,
exec, describe, transaction, cancel, physical backup, restore, and
close. Dedicated server handles expose only endpoint and lifecycle state; use a
PostgreSQL driver or ORM through their connection string.

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

## Execution placement and database topology

Direct mode is the default. It runs the embedded backend in the application
process. Broker mode uses the same database API while placing that backend in a
helper process.

The root API is synchronous and caller owned. `open`, SQL, backup, restore, and
close block the calling thread until their result is available. They do not
cross an SDK owner queue, but that is not a promise that PostgreSQL itself runs
on the caller: native direct mode uses `liboliphaunt`'s internal backend thread,
while broker and server topologies own their documented process or server
boundaries. Synchronous database and server handles are exclusive,
`Send + !Sync`, so ownership may move between threads but the same owner cannot
be shared concurrently. This is the minimum-overhead path for CLIs, tests,
dedicated application threads, and callers which already control scheduling.

`Oliphaunt::open()` is the shortest default: it opens direct mode with an
SDK-owned temporary directory. `AsyncOliphaunt::open().await` does the same on
the async owner thread. Use the cloneable builders when configuration differs.

<!-- liboliphaunt-doc-example:rust-basic-query -->
```rust
use oliphaunt::{DatabaseStorage, Oliphaunt};

# fn example() -> oliphaunt::Result<()> {
let mut db = Oliphaunt::builder()
    .storage(DatabaseStorage::Directory(".oliphaunt".into()))
    .startup_guc("application_name", "my-app")
    .open()?;

db.execute_with_params(
    "INSERT INTO events(value) VALUES ($1)",
    ["ready"],
)?;
let result = db.query("SELECT value FROM events")?;
assert_eq!(result.get_text(0, "value")?, Some("ready"));
db.close()?;
# Ok(())
# }
```

Use the named asynchronous handle when the calling executor must remain
responsive:

<!-- liboliphaunt-doc-example:rust-async-basic -->
```rust
use oliphaunt::AsyncOliphaunt;

# async fn example() -> oliphaunt::Result<()> {
let db = AsyncOliphaunt::open().await?;
let rows = db.query("SELECT 42::int4 AS answer").await?;
assert_eq!(rows.get_text(0, "answer")?, Some("42"));
db.close().await?;
# Ok(())
# }
```

`AsyncOliphaunt` and `AsyncOliphauntServer` are cloneable and `Send + Sync`.
Open constructs the selected topology on a permanent SDK-owned thread. Ordinary
calls await fair, bounded admission before entering one owner FIFO; saturation
applies async backpressure instead of blocking the executor or returning a
queue-full error. Blocking runtime work occupies the owner, not the executor
thread polling the future. Rust futures do not imply a thread by themselves;
this placement is an explicit Oliphaunt guarantee. Dropping a pending future is
not query cancellation.

Select broker mode with `.broker()`. An explicit
`.broker_executable(path)` is normally only needed by development and packaging
harnesses; installed packages resolve their helper artifact automatically.
If the helper exits or IPC fails, the database handle permanently rejects later
work. Close it and explicitly open a new handle on the same persistent root for
PostgreSQL WAL recovery; the SDK never substitutes a fresh session or replays an
uncertain request under the old handle.
The database builder represents only direct and broker databases;
`broker_executable` requires `broker().open()`. Local servers have a dedicated
`OliphauntServer::builder()` / `AsyncOliphauntServer::builder()` ending in
`start()`, so server-only and database-only options cannot be mixed.

`execute` and `execute_with_params` assert one command with no rows. `query` and
`query_with_params` accept a command-only or row-producing statement and return
ordered raw cells, complete field metadata, command metadata, notices, and
typed access through `FromSql`. `exec` returns ordered command-or-rows results
for simple-query SQL, while `describe` resolves parameter OIDs and optional
result fields without executing. Call `db.describe(sql)` for an unparameterized
statement, or `db.sql(sql).bind(...).describe()` when PostgreSQL needs explicit
parameter values or type OIDs.

Natural Rust values passed to `bind` or the `*_with_params` methods use
`IntoParameter` and carry their PostgreSQL type OID and preferred encoding.
`Parameter` provides explicit `TypeOid`, `ValueFormat`, and nullable owned
bytes for typed nulls and extension types. Its `text`, `binary`, and `null`
constructors deliberately leave the OID unspecified for PostgreSQL to infer.
An absent OID is the single execution spelling for inference. `describe` also
accepts explicit OID 0 because it is PostgreSQL's wire-level inference sentinel.
Typed
getters validate OID and format, reject ambiguous duplicate names, and preserve
raw access as the lossless fallback. SQL errors are structured `PostgresError`
values with operation notices. The public `Error` is opaque and cloneable;
match its non-exhaustive `ErrorKind` through `kind()` and use typed accessors
for PostgreSQL and paired transaction failures instead of destructuring or
comparing implementation errors.

`is_closed()` reports that the database handle is terminally retired.
The synchronous `transaction` exclusively borrows its database; the async
variant pins its one physical session and rejects unrelated clone work. Both
transaction handles mirror query, execute, exec, and describe. One-shot
`rollback()` closes the transaction and lets its callback return without
committing. A failed rollback or uncertain COMMIT poisons the database and does
not issue a misleading second control command.

Transaction callbacks return ordinary `Result<T, E>` with `E: From<Error>`.
Database calls therefore use `?`, while a business rule can return its own
concrete error. The outer `TransactionResult<T, E>` reports `TransactionError`:
`CallbackAndRollback` means rollback was actually attempted and failed;
`CallbackAndDatabase` means an independent database, transport, or recovery
failure had already expired the transaction and no rollback was sent. SDK-only
callbacks keep the concise `oliphaunt::Result` call shape through `From`
conversions.

Managed transaction handles expose structured SQL, not raw protocol. Return an
error from the callback or call `Transaction::rollback()` instead of issuing
`BEGIN`, `COMMIT`, full `ROLLBACK`, or prepared-transaction control as SQL.
Savepoints and `ROLLBACK TO SAVEPOINT` remain valid. Manual lifecycle SQL,
including `AND CHAIN`, is unsupported; a protocol response that proves
ownership escaped makes the database close-only. Protocol adapters that own the
entire lifecycle can use the raw APIs on the root database handle.

Synchronous `close()` blocks through teardown and replays its first terminal
result. Asynchronous `close().await` is an ordered queue boundary: operations
already in the owner FIFO drain, including an admitted `BEGIN`, while capacity
waiters and later work are rejected.
Once either variant begins runtime teardown, the handle is terminal even if
teardown reports an error. Successful teardown releases the session and its
managed-root ownership. A failed teardown intentionally retains that ownership
until process exit so no implicit destructor can repeat an unproven destructive
cleanup.

For COPY or another protocol flow that the structured helpers cannot represent,
use `exec_protocol_raw` for one owned response or
`exec_protocol_raw_stream` to consume backend protocol chunks as they arrive.
The stream is the raw PostgreSQL protocol; the SDK does not publish a second
parser or a separate COPY-specific abstraction. Synchronous callbacks execute
inline and may borrow caller state. Asynchronous callbacks execute serially on
the owner thread and therefore require `Send + 'static`. In both cases the
borrowed chunk is valid only until the callback returns, slow callbacks apply
backpressure, and callback panics are contained before crossing the native ABI.
Return `()` for infallible delivery without type annotations, or
`Result<(), E>` for a typed parser/application stop. `RawStreamError::Callback`
is produced only after confirmed recovery.
The synchronous API resumes the original panic only after its adapter confirms
`ReadyForQuery`; the async API returns a recovered owner-thread panic as
`RawStreamError::CallbackPanicked` and leaves the session reusable. If transport
or runtime recovery fails independently, `RawStreamError::Database` takes
precedence and the session rejects further work until close.

`AsyncOliphaunt::cancel().await` sends cancellation out of band. For the
synchronous root, obtain `db.cancel_handle()` before a long call and move that
cloneable, thread-safe capability to the thread which may interrupt it. Calling
`cancel()` on the database itself is immediate but cannot interrupt code already
blocking the same thread. Cancellation never replaces observing the original
operation, which reports PostgreSQL's final result.

## Physical backup and restore

Direct and broker databases expose one physical backup format as bytes. Restore
is a static operation into an absent or empty destination. It never overwrites
an existing managed database.

<!-- liboliphaunt-doc-example:rust-backup-restore -->
```rust
use oliphaunt::{DatabaseStorage, Oliphaunt};

# fn example() -> oliphaunt::Result<()> {
let mut source = Oliphaunt::builder()
    .storage(DatabaseStorage::Directory(".oliphaunt-source".into()))
    .open()?;
let backup = source.backup()?;
source.close()?;

Oliphaunt::restore(".oliphaunt-restored", backup)?;
# Ok(())
# }
```

The archive is a PostgreSQL physical initialization payload. It contains
PGDATA and its backup metadata, not the outer managed-root descriptor. Restore
creates and validates the receiving root and publishes `.oliphaunt.json` only
after complete PGDATA exists. Root restore blocks synchronously;
`AsyncOliphaunt::restore` copies its input and moves native and filesystem work
to a dedicated thread.

## Local server

`OliphauntServer::builder().start()` returns a lifecycle handle with a
nonoptional libpq connection string for standard PostgreSQL clients. The handle
deliberately does not hide a privileged SDK query session: SQL, transactions,
pools, cancellation, and raw protocol are owned by the external driver or ORM.
Its stable surface is `connection_string()`, `is_closed()`, and `close()`.
`is_closed()` reports SDK lifecycle state only; it does not poll the PostgreSQL
child or guarantee that the endpoint is currently reachable. Use the ordinary
driver or pool connected to `connection_string()` for connection health.

The default listener is IPv4 loopback with an automatically assigned port.
Select a fixed loopback port or, on Unix hosts, a PostgreSQL socket directory.
Unix socket directories must resolve to valid UTF-8 so the returned connection
string preserves the exact path for Rust drivers and ORMs:

<!-- liboliphaunt-doc-example:rust-start-server -->
```rust,no_run
use oliphaunt::{OliphauntServer, ServerListen};

# fn open() -> oliphaunt::Result<()> {
let mut server = OliphauntServer::builder()
    .listen(ServerListen::tcp_port(15432))
    .start()?;
println!("{}", server.connection_string());
server.close()?;
# Ok(())
# }
```

The dedicated server builder has no `.direct()` or `.broker()` selector and
the database builders have no listener options. The split makes invalid
cross-topology configuration unrepresentable.

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
catalog. `Extension` is an opaque `Copy + Eq + Hash + Ord` selector with
uppercase associated constants, `ALL`, `by_sql_name`, and `sql_name`. Selection
makes artifacts and required pre-start configuration available but never runs
`CREATE EXTENSION`, `LOAD`, or migration SQL. Build and release tooling owns
artifact resolution; the runtime API does not expose package manifests, size
reports, capability profiles, or packaging internals.

Supported native products and targets are declared by the repository SDK
manifest and release packages. WASIX is a separate binding family and is not a
fallback mode of this crate.
