# Oliphaunt WASIX Rust SDK

Host WebAssembly PostgreSQL in a Rust application. The synchronous handle must be created, used, and dropped on one OS thread. Use `AsyncOliphaunt` for a cloneable `Send + Sync` owner.

## Install

```sh
cargo add oliphaunt-wasix
```

The [quickstart](https://oliphaunt.dev/docs/sdk/wasix-rust) covers prerequisites and the versions documented by the current site. Pin dependencies in your application manifest or lockfile.

## First query

```rust
use oliphaunt_wasix::Oliphaunt;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Oliphaunt::open()?;
    let result = db.sql("SELECT $1::int4 AS answer").bind(42_i32).query()?;
    let answer: i32 = result.rows()[0].try_get("answer")?;
    println!("{answer}"); // 42
    db.close()?;
    Ok(())
}
```

Default storage is a memory filesystem and is discarded on close. Use the quickstart's persistent-storage example for application data; run it as an alternative to this disposable example. Always close database handles explicitly.

## Build your integration

- [Guide](https://oliphaunt.dev/docs/sdk/wasix-rust/guide): parameters, transactions, extensions, backups, and shutdown.
- [API reference](https://oliphaunt.dev/docs/sdk/wasix-rust/api-reference): methods, configuration, results, and errors.
- [Runtime support](https://oliphaunt.dev/docs/reference/capabilities): platforms, storage, and concurrency.
- [Releases and upgrades](https://oliphaunt.dev/docs/reference/releases): dependency and database upgrades.
