# oliphaunt-wasix-tools

Cargo artifact crate for Oliphaunt WASIX PostgreSQL command-line tools.
The `oliphaunt-wasix` crate selects it through the `tools` feature when an
application needs the WASIX `pg_dump` or `psql` modules.

This checkout copy is a source template. Release packaging injects
`pg_dump.wasix.wasm` and `psql.wasix.wasm`, removes the local `publish = false`
guard, and publishes the generated `oliphaunt-wasix-tools` crate to the Cargo
registry. WASIX intentionally has no `pg_ctl` tools crate payload.
