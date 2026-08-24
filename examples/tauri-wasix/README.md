# Tauri WASIX Todo

Tauri owns a Rust backend that starts `OliphauntServer` from
`oliphaunt-wasix`, then uses a one-connection SQLx pool against the local
PostgreSQL URL. The webview receives app-specific commands only. The explicit
Rust smoke test covers `pg_dump` and `psql`; ordinary application startup does
not run PostgreSQL client tools.

```sh
pnpm --dir examples/tauri-wasix install
pnpm --dir examples/tauri-wasix tauri dev
```
