# Tauri Native Todo

Tauri v2 owns an `oliphaunt` Rust SDK handle in backend state and exposes
app-specific commands to the webview. The native runtime is selected in Rust,
the persistent storage lives under the app data directory, and the exact extension
set is declared in `src-tauri/Cargo.toml`.

```sh
bun install --cwd examples/tauri
bun run --cwd examples/tauri tauri dev
```
