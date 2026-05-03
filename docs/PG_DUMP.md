# pg_dump

`pglite-oxide` ships the bundled WASIX `pg_dump` tool behind the default
`extensions` feature.

## Rust API

Use `PgDumpOptions` with either a direct `Pglite` instance or a `PgliteServer`.

```rust,no_run
use pglite_oxide::{PgDumpOptions, Pglite};

fn main() -> anyhow::Result<()> {
    let mut db = Pglite::temporary()?;
    db.exec("CREATE TABLE items(value TEXT)", None)?;
    db.exec("INSERT INTO items VALUES ('alpha')", None)?;

    let sql = db.dump_sql(PgDumpOptions::new())?;
    assert!(sql.contains("INSERT INTO"));

    db.close()?;
    Ok(())
}
```

`Pglite::dump_sql` no longer creates a physical clone and no longer starts a
public `PgliteServer`. It checkpoints the source connection, runs the bundled
WASIX `pg_dump`, and gives libpq an in-process Wasmer virtual TCP connection
whose server side is routed through the same direct raw-protocol backend.
`PgliteServer::dump_sql` runs directly against that server and currently
requires a TCP endpoint.

The direct path deliberately keeps `pg_dump` and libpq stock. The host owns the
transport through Wasmer's virtual networking layer instead of patching
`pg_dump` with pglite-oxide-specific callback imports. The direct socket adapter
also normalizes the in-memory socket's first write-readiness probe to match
libpq's level-triggered expectations after connect.

Options default to PGlite-compatible logical dumps:

- plain SQL;
- `--inserts`;
- `-j 1`;
- user `postgres`;
- database `template1`.

Additional `pg_dump` flags can be passed through:

```rust,no_run
use pglite_oxide::PgDumpOptions;

let options = PgDumpOptions::new()
    .arg("--schema-only")
    .username("postgres")
    .database("template1");
```

`PgDumpOptions` owns the connection and output contract. Passthrough arguments
that try to override the managed output file, output format, host, port,
username, database, or job count are rejected instead of being silently passed
to `pg_dump`.

## CLI

```sh
pglite-dump --root ./.pglite > dump.sql
pglite-dump --root ./.pglite -- --schema-only > schema.sql
```

The old `pglite-dump` behavior that unpacked runtime archives has been removed.

## Validation

The test suite covers plain SQL dump/restore, indexes, views, sequences,
`--schema-only`, `--quote-all-identifiers`, source-server reuse after dump, and
vector extension dump/restore.
