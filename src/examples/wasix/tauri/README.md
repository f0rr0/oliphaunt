# Tauri WASIX Todo

A native Tauri desktop app hosts WebAssembly PostgreSQL in its Rust backend.
See the [Tauri guide](https://oliphaunt.dev/docs/learn/tauri) for both Rust SDK
choices, including an async embedded handle without a PostgreSQL driver.

Tauri owns a Rust backend that asynchronously starts
`AsyncOliphauntServer` from `oliphaunt-pgwire-server`, then uses a one-connection
SQLx pool against the local
PostgreSQL URL. The webview receives app-specific commands only. The explicit
Rust smoke test covers `pg_dump` and `psql` through the direct
`oliphaunt_wasix` API; ordinary application startup does not run
PostgreSQL client tools.

```sh
bun install --cwd src/examples/wasix/tauri
bun run --cwd src/examples/wasix/tauri tauri dev
```
