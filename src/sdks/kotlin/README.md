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
        storage = DatabaseStorage.Directory(filesDir.resolve("database").path),
        startupGucs = listOf(PostgresStartupGuc("application_name", "my-app")),
        extensions = listOf("vector"),
    ),
)

db.execute(
    "INSERT INTO widgets(name) VALUES ($1)",
    listOf(QueryParam.Text("ready")),
)
val rows = db.query("SELECT name FROM widgets")
println(rows.getText(row = 0, column = "name"))

val bytes = db.backup()
db.close()
Oliphaunt.restore(
    context = applicationContext,
    destination = filesDir.resolve("restored-database").path,
    bytes = bytes,
)
```

## API contract

`execute` returns `CommandResult`; `query` returns `QueryResult` fields and rows.
Both expose the PostgreSQL command tag and nullable row count reported by
PostgreSQL. Parameters are explicit `QueryParam` values. SQL failures expose
structured `PostgresError` through `PostgresException`.

The database also provides callback `transaction`, `checkpoint`, out-of-band
`cancel`, buffered `execProtocolRaw`, callback `execProtocolStream`, byte
`backup`, and idempotent `close`. The stream contains raw PostgreSQL backend
frames; there is no separate public protocol parser.

Transactions pin the single physical session. Callback failure rolls back; a
failed rollback poisons the handle. COMMIT uncertainty is never followed by a
misleading ROLLBACK. PostgreSQL's explicit `COMMIT` → `ROLLBACK` command tag is
the known idle-session exception.

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
