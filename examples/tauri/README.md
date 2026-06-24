# Tauri Native Todo

Tauri v2 owns an `oliphaunt` Rust SDK handle in backend state and exposes
app-specific commands to the webview. The native runtime is selected in Rust,
the persistent root lives under the app data directory, and the exact extension
set is declared in `src-tauri/Cargo.toml`.

```sh
pnpm --dir examples/tauri install
pnpm --dir examples/tauri tauri dev
```
