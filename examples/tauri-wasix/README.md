# Tauri WASIX Todo

Tauri owns a Rust backend that asynchronously starts
`AsyncOliphauntServer` from `oliphaunt-pgwire-server`, then uses a one-connection
SQLx pool against the local
PostgreSQL URL. The webview receives app-specific commands only. The explicit
Rust smoke test covers `pg_dump` and `psql` through the direct
`oliphaunt_wasix` API; ordinary application startup does not run
PostgreSQL client tools.

```sh
bun install --cwd examples/tauri-wasix
bun run --cwd examples/tauri-wasix tauri dev
```
