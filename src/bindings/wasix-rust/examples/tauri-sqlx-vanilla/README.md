# oliphaunt-wasix Tauri SQLx example

This is a Tauri v2 example that keeps `oliphaunt-wasix` in Rust state and talks to
it through a real one-connection `sqlx::PgPool`.

## Run the desktop app

```sh
examples/tools/with-local-registries.sh pnpm --dir src/bindings/wasix-rust/examples/tauri-sqlx-vanilla install
examples/tools/with-local-registries.sh pnpm --dir src/bindings/wasix-rust/examples/tauri-sqlx-vanilla tauri dev
```

The app opens first and runs the database profile only when the profile command
is invoked from the UI.

## Run the headless profiler

```sh
examples/tools/with-local-registries.sh cargo run \
  --manifest-path src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/src-tauri/Cargo.toml \
  --release \
  --bin profile_queries \
  -- --fresh --rows 10000 --json-out /tmp/oliphaunt-profile-release.json
```

Use `--fresh` to remove the profile data directory before the run. Omit it to
measure a warm start with an existing cluster.

## What it demonstrates

- storing the database in managed Rust state;
- using `OliphauntServer` to hand SQLx a PostgreSQL URI;
- configuring the SQLx pool with `max_connections(1)`;
- creating schema, seeding rows, and profiling real SQL queries;
- resolving `oliphaunt-wasix-tools` and tools-AOT crates from the configured
  Cargo registry;
- preflighting the split WASIX tools, running `pg_dump --schema-only`, and
  running noninteractive `psql` with `SELECT 1`.
