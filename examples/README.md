# Oliphaunt Examples

The desktop examples keep the same todo schema across shells:

- `tauri`: Tauri v2 with the native Rust SDK.
- `tauri-wasix`: Tauri v2 with `oliphaunt-wasix` and SQLx.
- `electron`: Electron with the TypeScript SDK and native server mode.
- `electron-wasix`: Electron with a Rust WASIX sidecar exposing a PostgreSQL URL.

Additional platform examples live here as well:

- `browser-wasix`: the caller-realm root and explicit `/worker` WASIX
  TypeScript entrypoints with browser storage.
- `react-native-expo`: the React Native SDK in an Expo development build.

Each app opts into `hstore`, `pg_trgm`, and `unaccent`, then uses `hstore`
tags plus trigram/accent-insensitive search for the todo list. Native examples
load `postgres`, `initdb`, and `pg_ctl` from `liboliphaunt-native-*`. Native
tool carriers separately package `pg_basebackup`, `pg_dump`, and `psql`.
WASIX examples load `postgres` and `initdb` from the runtime crates and enable the
`oliphaunt-wasix` `tools` feature, which resolves `pg_dump`/`psql` from
`oliphaunt-wasix-tools`; WASIX intentionally has no `pg_ctl`.

Example dependencies resolve from npm and crates.io. Cargo manifests pin the
current Oliphaunt release versions and do not commit nested lockfiles.

Run the static Cargo manifest checks with:

```sh
tools/dev/bun.sh tools/release/example-cargo-policy.mjs --check
```
The native examples exercise their configured database path during startup;
native tool compatibility is qualified separately against the local server.
The WASIX examples exercise the optional `tools` namespace only in their
explicit Rust smoke tests; ordinary application startup does not run or load
`pg_dump` or `psql`.

Run Tauri GUI smoke tests through WebDriver on Linux:

```sh
examples/tools/run-tauri-webdriver-smoke.sh examples/tauri
examples/tools/run-tauri-webdriver-smoke.sh examples/tauri-wasix
```

The WebDriver smoke builds the selected Tauri app in debug mode, launches it
through `tauri-driver`, creates a todo through the real UI, toggles it done, and
asserts the done filter. It expects `WebKitWebDriver`; on Debian/Ubuntu install
`webkit2gtk-driver`. In headless environments it uses `xvfb-run` when present.

Run Electron GUI smoke tests through the IPC test driver on Linux:

```sh
examples/tools/run-electron-driver-smoke.sh examples/electron
examples/tools/run-electron-driver-smoke.sh examples/electron-wasix
```

The Electron smoke builds the selected app, launches the packaged Electron
binary with a test-driver IPC channel, creates a todo through the real renderer,
toggles it done, and asserts the done filter. In headless environments it uses
`xvfb-run` when present.

On Linux, SwiftPM artifacts are staged for inspection and skipped for registry
publish when `swift` is not installed.
