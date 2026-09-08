# Oliphaunt Swift SDK

Embed PostgreSQL in an iOS 17+ or macOS 14+ application using Swift 6 concurrency.

## Install

Add the package in Xcode and link its `Oliphaunt` product, or add this dependency to `Package.swift`:

```swift
.package(url: "https://github.com/f0rr0/oliphaunt.git", exact: "0.7.0")
```

The [quickstart](https://oliphaunt.dev/docs/sdk/swift) covers prerequisites and the versions documented by the current site. Pin dependencies in your application manifest or lockfile.

## First query

Call `firstQuery()` from an async application context.

```swift
import Oliphaunt

func firstQuery() async throws {
    let db = try await OliphauntDatabase.open()
    do {
        let result = try await db.query(
            "SELECT $1::int4 AS answer",
            parameters: [.int32(42)]
        )
        let answer: Int32? = try result.rows[0].value(named: "answer")
        print(answer ?? 0) // 42
    } catch {
        try? await db.close()
        throw error
    }
    try await db.close()
}
```

Default storage is a disposable temporary directory. Direct mode stays bound to its first root and configuration for the lifetime of the process, even after closing a handle. Use the quickstart's persistent-storage example for application data; run it as an alternative to this disposable example. Always close database handles explicitly.

## Build your integration

- [Guide](https://oliphaunt.dev/docs/sdk/swift/guide): parameters, transactions, extensions, backups, and shutdown.
- [API reference](https://oliphaunt.dev/docs/sdk/swift/api-reference): methods, configuration, results, and errors.
- [Runtime support](https://oliphaunt.dev/docs/reference/capabilities): platforms, storage, and concurrency.
- [Releases and upgrades](https://oliphaunt.dev/docs/reference/releases): dependency and database upgrades.
