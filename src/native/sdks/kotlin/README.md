# Oliphaunt Kotlin SDK

Embed PostgreSQL in an Android app with coroutine APIs. Android API 24+ is supported on `arm64-v8a` and `x86_64`.

## Install

Follow the [Android setup](https://oliphaunt.dev/docs/sdk/kotlin#install) to configure repositories, apply the `dev.oliphaunt.android` plugin, and add the matching SDK dependency. Use the same version for the plugin and library.

Set `seedProfile.set("standard")` in the app's `oliphaunt` Gradle block before building a new database.

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
