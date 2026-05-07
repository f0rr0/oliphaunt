# pglite-oxide Tauri SQLx example

This is a Tauri v2 example that keeps `pglite-oxide` in Rust state and talks to
it through a real one-connection `sqlx::PgPool`.

## Run the desktop app

```sh
npm install
npm run tauri dev
```

The app opens first and runs the database profile only when the profile command
is invoked from the UI.

## Run the headless profiler

```sh
cd src-tauri
cargo run --release --bin profile_queries -- --fresh --rows 10000 --json-out /tmp/pglite-profile-release.json
```

Use `--fresh` to remove the profile data directory before the run. Omit it to
measure a warm start with an existing cluster.

## What it demonstrates

- storing the database in managed Rust state;
- using `PgliteServer` to hand SQLx a PostgreSQL URI;
- configuring the SQLx pool with `max_connections(1)`;
- creating schema, seeding rows, and profiling real SQL queries.
