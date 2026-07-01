# Oliphaunt Examples

These examples keep the same todo schema across desktop shells:

- `tauri`: Tauri v2 with the native Rust SDK.
- `tauri-wasix`: Tauri v2 with `oliphaunt-wasix` and SQLx.
- `electron`: Electron with the TypeScript SDK and native server mode.
- `electron-wasix`: Electron with a Rust WASIX sidecar exposing a PostgreSQL URL.

Each app opts into `hstore`, `pg_trgm`, and `unaccent`, then uses `hstore`
tags plus trigram/accent-insensitive search for the todo list. Native examples
load `postgres`, `initdb`, and `pg_ctl` from `liboliphaunt-native-*`, while
`pg_dump` and `psql` come through the `oliphaunt-tools` facade selecting
`oliphaunt-tools-*` payload crates. WASIX examples load `postgres` and `initdb`
from the runtime crates. WASIX examples enable the `oliphaunt-wasix` `tools`
feature, which resolves `pg_dump`/`psql` from `oliphaunt-wasix-tools`; WASIX
intentionally has no `pg_ctl`.

Local registry artifacts for Linux x64 from CI run `28049923289` can be
staged with:

```sh
tools/dev/bun.sh tools/release/local-registry-publish.mjs download --run-id 28049923289 --preset local-publish
tools/dev/bun.sh tools/release/package-liboliphaunt-cargo-artifacts.mjs \
  --asset-dir target/local-registry-artifacts/liboliphaunt-native-release-assets-linux-x64-gnu \
  --output-dir target/local-registry-generated/liboliphaunt-native-cargo \
  --target linux-x64-gnu
tools/dev/bun.sh tools/release/package_broker_cargo_artifacts.mjs \
  --asset-dir target/local-registry-artifacts/oliphaunt-broker-release-assets-linux-x64-gnu \
  --output-dir target/local-registry-generated/broker-cargo \
  --target linux-x64-gnu
tools/dev/bun.sh tools/release/package_liboliphaunt_wasix_cargo_artifacts.mjs \
  --asset-dir target/local-registry-artifacts/liboliphaunt-wasix-release-assets \
  --output-dir target/local-registry-generated/wasix-cargo \
  --extension-artifact-root target/local-registry-artifacts/oliphaunt-extension-package-artifacts
tools/dev/bun.sh tools/release/local-registry-publish.mjs publish \
  --artifact-root target/local-registry-generated/liboliphaunt-native-cargo \
  --artifact-root target/local-registry-generated/broker-cargo \
  --artifact-root target/local-registry-generated/wasix-cargo \
  --artifact-root target/local-registry-artifacts/oliphaunt-extension-package-artifacts
```

The native packaging step emits `liboliphaunt-native-linux-x64-gnu`, the
`oliphaunt-tools` facade crate, and `oliphaunt-tools-linux-x64-gnu`. The WASIX
packaging step emits
`liboliphaunt-wasix-portable`, `oliphaunt-wasix-tools`,
`liboliphaunt-wasix-aot-*`, and `oliphaunt-wasix-tools-aot-*`.

Run examples through the local registry helper so Cargo resolves
`registry = "oliphaunt-local"` and pnpm reads the local Verdaccio registry:

```sh
examples/tools/with-local-registries.sh pnpm --dir examples/electron install
examples/tools/with-local-registries.sh pnpm --dir examples/electron start
```

The native examples run a SQL backup smoke through `pg_dump` during startup.
The WASIX examples run `dump_sql("--schema-only")` and a non-interactive `psql`
`SELECT 1` smoke during startup.

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
