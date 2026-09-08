# Oliphaunt Kotlin SDK

Embed PostgreSQL in an Android app with coroutine APIs. Android API 24+ is supported on `arm64-v8a` and `x86_64`.

## Install

Follow the [Android setup](https://oliphaunt.dev/docs/sdk/kotlin) to configure repositories and apply the matching `dev.oliphaunt.android` plugin. Add the SDK dependency to your app module:

```kotlin
dependencies {
    implementation("dev.oliphaunt:oliphaunt-android:0.2.0")
}
```

The [quickstart](https://oliphaunt.dev/docs/sdk/kotlin) covers prerequisites and the versions documented by the current site. Pin dependencies in your application manifest or lockfile.

## First query

Call `firstQuery(context)` from a coroutine.

```kotlin
import android.content.Context
import dev.oliphaunt.*

suspend fun firstQuery(context: Context) {
    val db = Oliphaunt.open(context.applicationContext)
    try {
        val result = db.query(
            "SELECT $1::int4 AS answer",
            parameters = listOf(QueryParam.int(42)),
        )
        println(result.rows[0].value("answer", PostgresDecoders.int)) // 42
    } finally {
        db.close()
    }
}
```

Default storage is a disposable temporary directory. Direct mode stays bound to its first root and configuration for the lifetime of the process, even after closing a handle. Use the quickstart's persistent-storage example for application data; run it as an alternative to this disposable example. Always close database handles explicitly.

## Build your integration

- [Guide](https://oliphaunt.dev/docs/sdk/kotlin/guide): parameters, transactions, extensions, backups, and shutdown.
- [API reference](https://oliphaunt.dev/docs/sdk/kotlin/api-reference): methods, configuration, results, and errors.
- [Runtime support](https://oliphaunt.dev/docs/reference/capabilities): platforms, storage, and concurrency.
- [Releases and upgrades](https://oliphaunt.dev/docs/reference/releases): dependency and database upgrades.
