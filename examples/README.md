# Oliphaunt Examples

These examples keep the same todo schema across desktop shells:

- `tauri`: Tauri v2 with the native Rust SDK.
- `tauri-wasix`: Tauri v2 with `oliphaunt-wasix` and SQLx.
- `electron`: Electron with the TypeScript SDK and native broker mode.
- `electron-wasix`: Electron with a Rust WASIX sidecar exposing a PostgreSQL URL.

Each app opts into `hstore`, `pg_trgm`, and `unaccent`, then uses `hstore`
tags plus trigram/accent-insensitive search for the todo list.

Local registry artifacts from CI run `28049923289` can be staged with:

```sh
python3 tools/release/local_registry_publish.py download --run-id 28049923289 --preset local-publish
python3 tools/release/local_registry_publish.py publish
```

On Linux, SwiftPM artifacts are staged for inspection and skipped for registry
publish when `swift` is not installed.
