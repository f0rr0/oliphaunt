# Dump, Restore, And Upgrade

`pglite-oxide` ships a bundled WASIX `pg_dump` path behind the `extensions`
feature, which is enabled by default. Use it for portable SQL exports,
restores, and version-to-version upgrades.

## Choose The Right Export Format

Use logical dumps when you need:

- a portable SQL export;
- an upgrade path between `pglite-oxide` releases;
- a way to move data between different roots safely.

Use physical data-dir archives when you need:

- a same-version clone;
- a same-runtime restore into another `pglite-oxide` root;
- a fast local snapshot of the current cluster state.

Physical archives are not a cross-version upgrade path.

## Direct API

Dump an already-open `Pglite` database to SQL:

```rust,no_run
use pglite_oxide::{PgDumpOptions, Pglite};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Pglite::temporary()?;
    db.exec("CREATE TABLE items(value TEXT)", None)?;
    db.exec("INSERT INTO items VALUES ('alpha')", None)?;

    let sql = db.dump_sql(PgDumpOptions::new())?;
    assert!(sql.contains("INSERT INTO"));

    db.close()?;
    Ok(())
}
```

Get UTF-8 bytes instead:

```rust,no_run
use pglite_oxide::{PgDumpOptions, Pglite};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Pglite::temporary()?;
    let bytes = db.dump_bytes(PgDumpOptions::new())?;
    assert!(!bytes.is_empty());
    db.close()?;
    Ok(())
}
```

Direct dumps run against the already-open embedded backend. If you need to dump
as a different user or from a different database, start a `PgliteServer` and
use the server dump path instead.

## Server API

Dump through a local Postgres endpoint when another part of your workflow
already uses `PgliteServer`:

```rust,no_run
use pglite_oxide::{PgDumpOptions, PgliteServer};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let server = PgliteServer::temporary_tcp()?;
    let sql = server.dump_sql(PgDumpOptions::new().arg("--schema-only"))?;
    assert!(!sql.is_empty());
    server.shutdown()?;
    Ok(())
}
```

`PgliteServer::dump_sql(...)` currently requires a TCP endpoint.

## `PgDumpOptions`

`PgDumpOptions` controls the managed parts of the dump command:

```rust,no_run
use pglite_oxide::PgDumpOptions;

let options = PgDumpOptions::new()
    .username("postgres")
    .database("template1")
    .args(["--schema-only", "--quote-all-identifiers"]);
```

Useful passthrough flags include dump-shaping options such as:

- `--schema-only`
- `--quote-all-identifiers`
- `-n <schema>`
- `-t <table>`

Managed connection and output flags are reserved by the API. Do not pass
`--file`, `--format`, `--host`, `--port`, `--username`, `--dbname`, or `--jobs`
through `arg(...)` or `args(...)`.

## CLI

Dump a persistent root:

```sh
pglite-dump --root ./.pglite
```

Pass through normal `pg_dump` shaping flags after `--`:

```sh
pglite-dump --root ./.pglite -- --schema-only
pglite-dump --root ./.pglite -- --quote-all-identifiers
```

## Restore

Restore a logical dump by executing the SQL against a new database:

```rust,no_run
use pglite_oxide::{PgDumpOptions, Pglite};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut source = Pglite::temporary()?;
    source.exec("CREATE TABLE items(value TEXT)", None)?;
    source.exec("INSERT INTO items VALUES ('alpha')", None)?;
    let dump_sql = source.dump_sql(PgDumpOptions::new())?;

    let mut restored = Pglite::temporary()?;
    restored.exec(&dump_sql, None)?;

    source.close()?;
    restored.close()?;
    Ok(())
}
```

For same-version root copies, prefer `dump_data_dir()` /
`load_data_dir_archive(...)` or `try_clone()`.

## Upgrade Guidance

Use logical dump and restore when upgrading between `pglite-oxide` versions or
changing packaged runtime assets:

1. Open the old database with the old crate/runtime.
2. Create a logical dump with `dump_sql(...)` or `pglite-dump`.
3. Open a fresh database with the new crate/runtime.
4. Execute the dump SQL into the new database.

Do not treat physical data-dir archives as a general upgrade mechanism. They are
for the same runtime family and database format.
