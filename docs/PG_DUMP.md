# pg_dump

The `pglite-dump` binary is reserved for logical dumps backed by the packaged
WASIX `pg_dump` module.

The old behavior that unpacked runtime archives has been removed.

## Current Status

The dump runner is tested privately but is not public API yet. It can load the
packaged `pg_dump` module, connect to `PgliteServer`, produce plain SQL, restore
into a fresh `Pglite`, and verify restored data.

Public Rust APIs such as `Pglite::dump_sql` and `Pglite::dump_bytes` will be
added only after the CLI and public API are wired to the same tested runner.

## Intended CLI Shape

```sh
pglite-dump --root ./.pglite > dump.sql
pglite-dump --root ./.pglite -- --schema-only > schema.sql
```

Until this is public, use normal Postgres tooling against `PgliteServer` when a
manual dump is required.
