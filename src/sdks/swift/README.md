# Oliphaunt Swift SDK

## Install

Add the base package and any external extension packages through SwiftPM. The
base `Oliphaunt` product includes PostgreSQL, supported contrib extensions, and
the standard cluster seed. External extensions and ICU are separate packages.

```swift
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Example",
    platforms: [.iOS(.v17), .macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/f0rr0/oliphaunt.git", exact: "0.7.0"),
        .package(url: "https://github.com/f0rr0/oliphaunt-extension-vector.git", from: "0.2.0")
    ],
    targets: [.executableTarget(name: "Example", dependencies: [
        .product(name: "Oliphaunt", package: "oliphaunt"),
        .product(name: "OliphauntExtensionVector", package: "oliphaunt-extension-vector")
    ])]
)
```

Select both the external extension and contrib member explicitly when opening
each database:

```swift
import Foundation
import Oliphaunt
import OliphauntExtensionVector

let directory = URL.applicationSupportDirectory.appending(path: "postgres")
let db = try await OliphauntDatabase.open(configuration: OliphauntConfiguration(
    storage: .directory(directory),
    extensions: [OliphauntExtensionVector.descriptor, OliphauntExtensions.hstore]
))
try await db.exec("CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS hstore;")
try await db.close()
```

The descriptor prepares its package resources and registers native symbols.
Applications do not need a build script, resource generator, or manual registry
call. Installation makes a package available to the application; `extensions`
selects resources for one database, and SQL migrations create the extensions.

For ICU collations, also add the `oliphaunt-icu` Swift package from
`https://github.com/f0rr0/oliphaunt-icu.git` and its `OliphauntICU` product. Import
`OliphauntICU` and pass `icu: OliphauntICU.descriptor` in the configuration. This
package owns the ICU data and matching Apple cluster seeds. Omit the dependency
and configuration option when ICU is unnecessary.

React Native iOS uses this Swift SDK through its npm package and config plugin.

## Quickstart

```swift
let db = try await OliphauntDatabase.open(
    configuration: OliphauntConfiguration(
        storage: .directory(applicationDatabaseURL),
        startupGUCs: ["shared_buffers": "32MB"],
        username: "postgres",
        database: "postgres"
    )
)
let rows = try await db.query(
    "SELECT name FROM widgets WHERE id = $1",
    parameters: [.int64(42)]
)
let name: String? = try rows.rows[0].value(named: "name")

let command = try await db.execute(
    "UPDATE widgets SET active = $1 WHERE id = $2",
    parameters: [.bool(true), .int64(42)]
)
print(command.commandTag ?? "")
print(command.rowCount as Any)
try await db.close()
```

`username` selects an existing PostgreSQL role. New roots are always
bootstrapped with `postgres`; create another role from that account before
reopening the root with a different username.

Swift package for iOS and macOS apps on the native `liboliphaunt` product line.

The public API is actor-based and deliberately small. `query` executes one
statement and returns ordered raw cells plus field metadata, command metadata,
and typed row access through `OliphauntPostgresDecodable`. `execute` is the
stricter one-statement, no-rows assertion. `exec` uses the simple-query protocol
for ordered multi-statement command-or-rows results, while `describe` resolves
parameter OIDs and optional result fields without executing. Results preserve
ordered notices; SQL errors preserve the same PostgreSQL diagnostic fields and
notices.

Parameters carry an optional `OliphauntPostgresOID`, text or binary format, and
nullable owned bytes. Common factories such as `.bool`, `.int32`, `.int64`,
`.string`, `.bytes`, and `.uuid` publish the correct OID; use `.typedNull(.uuid)`
for an ambiguous null, or explicit `.text`/`.binary` with a custom OID for an
extension type. Omit `typeOID` to request PostgreSQL parameter inference;
explicit parameter OID `0` is rejected so omission cannot be confused with a
caller-supplied type. Typed getters validate the field OID and format before
decoding; `row.raw(_:)` remains the lossless fallback.

The database also provides callback-scoped transactions, `cancel`, physical
`backup` and `restore`, raw PostgreSQL protocol execution,
and idempotent `close`. `isClosed` becomes true only after a successful close.
Raw protocol execution remains available for PostgreSQL features without a
typed API. `execProtocolRaw` returns one owned response, while
`execProtocolRawStream` delivers raw backend protocol chunks to a callback without
buffering the complete response. The callback is a synchronous backpressure
boundary: same-database and transaction work is rejected from its scope, with
`cancel()` as the sole out-of-band exception. Neither API adds a second protocol
parser. Callback failures are surfaced only after the native runtime confirms
protocol recovery, so the session remains reusable. A buffered or streaming
transport or recovery failure is authoritative and poisons the database; close
it instead of assuming a later operation can recover the physical session.

These APIs are genuinely asynchronous for the caller even though embedded
PostgreSQL is blocking internally. A dedicated serial owner queue performs root
preparation, open, protocol calls, backup, and close; those operations never run
on the main actor. Ordinary work, `BEGIN`, transaction settlement, and close
share FIFO admission. A transaction or close establishes an atomic cutoff:
operations admitted before it drain first, while later incompatible calls are
rejected. `cancel()` uses a separate control queue so it can interrupt the active
call instead of waiting behind it. It remains available while an admitted close
is draining earlier FIFO work and becomes unavailable when native teardown
starts. Cancelling a Swift task does not implicitly
cancel PostgreSQL; call `cancel()` when an interrupt is intended.

Transactions use one physical session and expose `query`, `execute`, `exec`,
and `describe`; raw protocol execution stays on the database because it owns
transaction lifecycle explicitly. `rollback()` is one-shot: it closes the
transaction, lets the callback return a value, and suppresses `COMMIT`; returning
normally commits. Do not issue outer-lifecycle SQL such as `BEGIN`/`START
TRANSACTION`, `COMMIT`/`END`, a full `ROLLBACK`/`ABORT` (with or without
`AND [NO] CHAIN`), or `PREPARE TRANSACTION` inside a managed callback. Use
`SAVEPOINT`, `RELEASE SAVEPOINT`, and `ROLLBACK TO SAVEPOINT` for nested work.
PostgreSQL reports both `ROLLBACK TO` and `ROLLBACK AND CHAIN` as `ROLLBACK`
with `ReadyForQuery=T`, so the SDK rejects `ROLLBACK`/`ABORT ... AND CHAIN`
before dispatch and still validates every actual protocol boundary. A detected
lifecycle command, escaped idle session, failed rollback, or uncertain commit
makes the database close-only; close it before reopening.
If a callback catches such a poisoning database or rollback error and returns,
the transaction still fails with the stored original error; an unsafe session
cannot be converted into success by swallowing the error.
After a successful automatic rollback, the original callback error is rethrown.
When the callback and rollback both fail,
`OliphauntTransactionRollbackError` retains them in its public `callbackError`
and `rollbackError` fields. If an earlier independent database or protocol
failure has already poisoned or expired transaction ownership and the callback
then throws a different error, `OliphauntTransactionDatabaseError` retains the
two errors in its public `callbackError` and `databaseError` fields; the database
is close-only. An ordinary PostgreSQL statement error that remains safely
rollbackable is not automatically wrapped in either composite error.

`startupGUCs` are passed directly as PostgreSQL `-c name=value` arguments.
There are no SDK-specific durability, memory, or runtime profiles.

Database storage is optional in the common case. The default,
`.temporaryDirectory`, uses an SDK-owned directory below the operating system's
temporary location. Native direct keeps that directory for its process-resident
database so a logical close can be reopened safely; it is not durable storage
and may be reclaimed after the process exits. Select persistence explicitly
with `storage: .directory(applicationDatabaseURL)`. `close()` never deletes a
directory supplied by the application.

Use `transaction {}` for multi-step work that must stay on the same physical
session. Database calls outside the active `OliphauntTransaction` are rejected
until the transaction commits or rolls back.
Use `execute("CHECKPOINT")` when an explicit PostgreSQL checkpoint is required;
like other database operations, it is rejected while a transaction is active.

```swift
let result = try await db.query(
    "SELECT $1::text AS value, $2::uuid AS optional_id",
    parameters: [.string("hello"), .typedNull(.uuid)]
)
```

## Physical backup and storage

`backup()` returns the native physical archive as `Data`. Restore accepts those
bytes and a new destination; it never replaces an existing database root.

```swift
let bytes = try await db.backup()
try await db.close()
try await OliphauntDatabase.restore(destination: restoredDatabaseURL, bytes: bytes)
```

A persistent database directory is a managed root:

```text
.oliphaunt.json
pgdata/
```

The descriptor is published only after a packaged cluster seed or packaged `initdb`
has produced complete PGDATA. Existing managed roots must contain PostgreSQL 18 `PG_VERSION`, `global/pg_control`, and
`pg_wal`. A pre-existing nonempty directory without the descriptor is rejected
without modification. Physical archives contain PGDATA and the exact physical
backup manifest. Restore creates the receiving root descriptor after validating
the extracted PGDATA.

## Local Development

For local contributor tests from this repository:

```bash
cd src/sdks/swift
swift test
```

To run the native C ABI smoke from Swift:

```bash
LIBOLIPHAUNT_PATH=/path/to/liboliphaunt.dylib \
OLIPHAUNT_INSTALL_DIR=/path/to/postgres/install \
swift test
```

The native-direct env-backed test opens temporary storage, executes `SELECT 1`
through PostgreSQL protocol bytes, cancels an active
`pg_sleep`, creates a
same-version physical backup through the C ABI, restores it into a new destination, and
closes the runtime. The package tests also check explicit extension selection,
resource composition, cluster seed compatibility, and native registration.

## Runtime resources

SwiftPM selects the Apple XCFramework slice for the target. The base framework
contains the runtime and standard seed. Selected extension descriptors register
resource fragments; the SDK resolves required dependencies and composes the
selected resources into a cache. ICU data and its matching target seed come
from the explicitly selected ICU package. The SDK checks the seed target and
ICU data identity before hydrating a new database directory.

On iOS, database initialization uses a packaged seed. Existing database storage
can be reopened without running a separate `initdb` executable.

Release tooling generates base contrib targets and independent external package
trees from checksum-verified carrier manifests. `render-extension-products.mjs`
is also available for advanced assembly of prebuilt artifacts; it is not an
application setup step. Native libraries remain binary targets, and SQL/data
resources remain SwiftPM resources.
