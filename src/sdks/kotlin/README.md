# Oliphaunt Kotlin SDK

Oliphaunt embeds PostgreSQL 18 behind a small coroutine-native Android API. The
common implementation is also compiled and tested on the JVM, but Android is
the only supported and published application facade.

## Android setup

Apply `dev.oliphaunt.android` and depend on
`dev.oliphaunt:oliphaunt-android`. The plugin packages the matching runtime and
only the selected extension artifacts; applications do not build PostgreSQL at
runtime.

<!-- liboliphaunt-doc-example:kotlin-setup -->
```kotlin
plugins {
    id("dev.oliphaunt.android") version "0.1.1"
}

dependencies {
    implementation("dev.oliphaunt:oliphaunt-android:0.1.1")
}

oliphaunt {
    icu.set(true) // Omit unless PostgreSQL ICU collations are required.
}
```

The Gradle plugin resolves ICU data together with the matching Android cluster
seed. This is a build-time package choice, not a database-open mode.

Open with the Android `Oliphaunt` object and an application `Context`.

`username` selects an existing PostgreSQL role. A new root is bootstrapped with
the fixed `postgres` role, so create additional roles from `postgres` before
opening that root as them.

<!-- liboliphaunt-doc-example:kotlin-typed-query -->
```kotlin
val db = Oliphaunt.open(
    context = applicationContext,
    config = OliphauntConfig(
        storage = DatabaseStorage.Directory(filesDir.resolve("database")),
        startupGucs = listOf(PostgresStartupGuc("application_name", "my-app")),
        extensions = listOf("vector"),
    ),
)

db.execute(
    "INSERT INTO widgets(name) VALUES ($1)",
    listOf(QueryParam.string("ready")),
)
val rows = db.query("SELECT name FROM widgets")
println(rows.rows.first().value("name", PostgresDecoders.string))

val bytes = db.backup()
db.close()
Oliphaunt.restore(
    context = applicationContext,
    destination = filesDir.resolve("restored-database").path,
    bytes = bytes,
)
```

## API contract

`query` executes one statement and returns ordered nullable bytes, complete
field metadata, command metadata, and typed access through a local
`PostgresDecoder<T>`. `execute` is the stricter one-statement, no-rows
assertion. `exec` returns ordered command-or-rows results for simple-query SQL,
and `describe` resolves parameter OIDs and optional result fields without
executing. Results preserve ordered notices; SQL failures expose the same
structured diagnostics and notices through `PostgresException`.

Every `QueryParam` carries an optional `PostgresOid`, `ValueFormat`, and nullable
owned bytes. Prefer factories such as `string`, `boolean`, `int`, `long`,
`bytes`, and `uuid`; use `typedNull(PostgresOid.uuid)` for an ambiguous null or
explicit text/binary bytes plus a custom OID for an extension type. Built-in
decoders validate both OID and wire format. `QueryRow.raw` remains the lossless
fallback, and name-based typed access rejects duplicate column names.

The database also provides callback `transaction`, out-of-band `cancel`,
buffered `execProtocolRaw`, callback `execProtocolRawStream`, byte
`backup`, a read-only `isClosed`, and idempotent `close`. The stream contains raw
PostgreSQL backend bytes; callback chunks are transport-dependent and are not a
separate public protocol parser. The callback is a synchronous backpressure
boundary: while it is running, the database rejects all same-database and
transaction work, including work launched onto another coroutine dispatcher;
`cancel()` is the sole out-of-band exception.
Callback failures are surfaced only after the native runtime confirms protocol
recovery, so the session remains reusable. A buffered or streaming transport or
recovery failure is authoritative and poisons the database; close it instead of
assuming a later operation can recover the physical session.

Suspending calls never execute embedded PostgreSQL or storage preparation on
the Android UI thread. One single-thread owner dispatcher performs open,
protocol calls, backup, and close in admission order. A transaction or close
establishes an atomic cutoff: operations admitted before it drain first, while
later incompatible calls are rejected. `cancel()` uses a separate control
dispatcher so it can interrupt the active owner call. It remains available
while an admitted close drains earlier FIFO work and
becomes unavailable when native teardown starts. Once JNI work is admitted
it completes its handle ownership transition, and `close()` finishes in a
non-cancellable context; coroutine cancellation alone is not a PostgreSQL
interrupt. Applications must still call `close()` explicitly. A phantom-reference
cleaner is a best-effort forgotten-handle safety net and only schedules close on
the native owner; it never blocks the garbage collector thread.

Transactions pin the single physical session and expose `query`, `execute`,
`exec`, and `describe`; raw protocol execution stays on the database because it
owns transaction lifecycle explicitly. One-shot `rollback()` closes the
transaction and lets its callback return without committing; returning normally
commits. Do not issue outer-lifecycle SQL such as `BEGIN`/`START TRANSACTION`,
`COMMIT`/`END`, a full `ROLLBACK`/`ABORT` (with or without `AND [NO] CHAIN`), or
`PREPARE TRANSACTION` inside a managed callback. Use
`SAVEPOINT`, `RELEASE SAVEPOINT`, and `ROLLBACK TO SAVEPOINT` for nested work.
PostgreSQL reports both `ROLLBACK TO` and `ROLLBACK AND CHAIN` as `ROLLBACK`
with `ReadyForQuery=T`, so the SDK rejects `ROLLBACK`/`ABORT ... AND CHAIN`
before dispatch and still validates every actual protocol boundary. A detected
lifecycle command, escaped idle session, failed rollback, or uncertain COMMIT
makes the database close-only; no second control command claims recovery. If a
callback catches such a poisoning database or rollback error and returns, the
transaction still fails with the stored original error. After a successful
automatic rollback, the original callback exception is rethrown.
When the callback and rollback both fail, `OliphauntTransactionRollbackException`
exposes `callbackError` and `rollbackError`, uses the callback as its cause, and
adds the rollback as a suppressed exception. If an earlier independent database
or protocol failure has already poisoned or expired transaction ownership and
the callback then throws a different exception,
`OliphauntTransactionDatabaseException` exposes `callbackError` and
`databaseError`, uses the callback as its cause, and adds the database error as a
suppressed exception; the database is close-only. An ordinary PostgreSQL
statement error that remains safely rollbackable is not automatically wrapped
in either composite exception.

Backup has one representation: PostgreSQL physical initialization bytes.
Restore requires an absent or empty destination and never replaces an existing
root. The payload contains PGDATA and backup metadata, not the outer managed-root
descriptor; the receiving root publishes its descriptor after PGDATA validates.

## Storage and extensions

A persistent root contains `.oliphaunt.json` and `pgdata/`. The descriptor's
exact fields are schema, engine family, PGDATA directory name, PostgreSQL major,
and physical format. Initialization validates PGDATA first and publishes the
descriptor last. Nonempty descriptorless roots and symlink structural
directories are rejected without mutation.

`PostgresStartupGuc` is the only tuning vocabulary. Values map directly to
PostgreSQL `-c name=value` settings; the SDK has no durability, memory, runtime,
or capability profiles.

`OliphauntConfig.extensions` accepts exact generated PostgreSQL SQL names.
Packaging resolves dependencies and native registration; package manifests and
size reports remain internal build concerns.

## Local checks

Run `./gradlew :oliphaunt:jvmTest :oliphaunt:testDebugUnitTest` with
`ANDROID_HOME` configured. Android runtime smoke tests use explicitly packaged
runtime resources and JNI libraries.
