# Tauri WASIX Todo

Tauri owns a Rust backend that starts `OliphauntServer` from
`oliphaunt-wasix`, then uses a one-connection SQLx pool against the local
PostgreSQL URL. The webview receives app-specific commands only.

```sh
examples/tools/with-local-registries.sh pnpm --dir examples/tauri-wasix install
examples/tools/with-local-registries.sh pnpm --dir examples/tauri-wasix tauri dev
```
