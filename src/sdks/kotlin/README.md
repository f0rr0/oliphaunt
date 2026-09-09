# Oliphaunt Kotlin SDK

Oliphaunt embeds PostgreSQL 18 behind a small coroutine-native Android API. The
common implementation is also compiled and tested on the JVM, but Android is
the only supported and published application facade.

## Android setup

Apply the Android plugin and install the SDK. Add vector as an independently
versioned dependency; contrib ships with the SDK.

```kotlin
plugins {
    id("dev.oliphaunt.android") version "0.1.1"
}

dependencies {
    implementation("dev.oliphaunt:oliphaunt-android:0.2.0")
    implementation("dev.oliphaunt.extensions:oliphaunt-extension-vector:0.2.0")
}
```

The plugin reads resolved dependencies for each Android variant and packages
the required native artifacts. No duplicate extension or version list is needed.
Select resources explicitly when opening each database:

```kotlin
import dev.oliphaunt.*
import dev.oliphaunt.extensions.vector.Vector

val db = Oliphaunt.open(
    context = applicationContext,
    config = OliphauntConfig(
        storage = DatabaseStorage.Directory(filesDir.resolve("database")),
        startupGucs = mapOf("application_name" to "my-app"),
        extensions = listOf(Vector.descriptor, Extensions.HSTORE),
    ),
)
try {
    db.execute("CREATE EXTENSION vector")
    db.execute("CREATE EXTENSION hstore")
    val rows = db.query("SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance")
    println(rows.rows.first().value("distance", PostgresDecoders.double))
} finally {
    db.close()
}
```

For ICU collations, add `dev.oliphaunt.runtime:oliphaunt-icu` at the compatible
native runtime version, import `dev.oliphaunt.icu.ICU`, and pass `icu = ICU.data`.
Installing resources determines what the app ships; the configuration determines
what each database selects. Adding native dependencies requires rebuilding the app.

`username` selects an existing PostgreSQL role. New roots start with `postgres`;
create additional roles before reopening a root as them.

## Java on Android

Java uses the same dependencies and runtime. Call the blocking facade on an
application worker thread and use try-with-resources:

```java
import dev.oliphaunt.*;
import dev.oliphaunt.extensions.vector.Vector;
import java.io.File;

var config = OliphauntConfig.builder()
    .storage(new DatabaseStorage.Directory(new File(context.getFilesDir(), "database")))
    .startupGuc("application_name", "my-app")
    .extensions(Vector.descriptor, Extensions.HSTORE)
    .build();
try (var db = OliphauntJava.open(context, config)) {
    db.execute("CREATE EXTENSION vector");
    db.execute("CREATE EXTENSION hstore");
}
```

Use `.icu(ICU.data)` for the optional ICU dependency. Kotlin retains its suspend
API; Java's facade owns the same native session and adapts the calling convention.

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

`startupGucs` is a map of PostgreSQL setting names to string values. Values map directly to
PostgreSQL `-c name=value` settings; the SDK has no durability, memory, runtime,
or capability profiles.

`OliphauntConfig.extensions` accepts imported external descriptors and SDK contrib
values. Both are explicit selections; applications run `CREATE EXTENSION` in SQL.
Packaging resolves dependencies and native registration; package manifests and
size reports remain internal build concerns.

## Local checks

Run `./gradlew :oliphaunt:jvmTest :oliphaunt:testDebugUnitTest` with
`ANDROID_HOME` configured. Android runtime smoke tests use explicitly packaged
runtime resources and JNI libraries.
