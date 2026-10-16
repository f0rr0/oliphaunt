# Oliphaunt WASIX Rust SDK

Host WebAssembly PostgreSQL in a Rust application. The synchronous handle must be created, used, and dropped on one OS thread. Use `AsyncOliphaunt` for a cloneable `Send + Sync` owner.

Requires Rust 1.96 or newer.

## Install

```sh
cargo add oliphaunt-wasix
```

The [quickstart](https://oliphaunt.dev/docs/sdk/wasix-rust) covers prerequisites and the versions documented by the current site. Pin dependencies in your application manifest or lockfile.

## First query

```rust,no_run
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

Embedded execution defaults to `fsync=off`; saved PostgreSQL configuration and `.startup_guc("fsync", "on")` can override it. A persistent directory alone does not provide crash safety. Memory storage has no disk to synchronize.

SQL `statement_timeout` cancels statements at PostgreSQL interrupt points, including
CPU work and PostgreSQL waits, with SQLSTATE `57014`. Managed transactions roll
back when their callbacks propagate the error. This cooperative deadline cannot
interrupt an inactive guest or an arbitrary blocked host call. Timing out a
caller's future does not stop guest work.

The host-selected username is the real PostgreSQL session principal: LOGIN/CONNECT restrictions, role defaults and login triggers apply. `RESET ROLE` and `DISCARD ALL` do not restore the bootstrap superuser. The host authenticates the caller; initialize new storage as `postgres` before selecting an existing application role.

With the `tools` feature, `pg_dump` and `psql` return complete output in memory.
Use `pg_dump_to_writer` or `psql_to_writer` to move a `Write + Send + 'static`
destination to the tool runner. The optional diagnostic writer receives complete
stderr; summaries and errors retain a marked 8 KiB diagnostic tail. Owned writers
are flushed before completion. A failed writer may contain partial output.

`pg_dump_to_file` and `psql_to_file` stage a private host file beside its destination
and publish it create-only after tool execution and database-session cleanup succeed.
Existing files are preserved; Unix permissions are `0600`. Ordinary flushing and
publication do not promise power-loss durability. Direct and async handles expose
the same destination methods. Tools reset the session; reapply session settings
and prepared statements afterward. Script input remains buffered.

## Build your integration

- [Guide](https://oliphaunt.dev/docs/sdk/wasix-rust/guide): parameters, transactions, extensions, backups, and shutdown.
- [API reference](https://oliphaunt.dev/docs/sdk/wasix-rust/api-reference): methods, configuration, results, and errors.
- [Runtime support](https://oliphaunt.dev/docs/reference/capabilities): platforms, storage, and concurrency.
- [Releases and upgrades](https://oliphaunt.dev/docs/reference/releases): dependency and database upgrades.
