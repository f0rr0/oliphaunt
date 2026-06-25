# Oliphaunt Examples

These examples keep the same todo schema across desktop shells:

- `tauri`: Tauri v2 with the native Rust SDK.
- `tauri-wasix`: Tauri v2 with `oliphaunt-wasix` and SQLx.
- `electron`: Electron with the TypeScript SDK and native server mode.
- `electron-wasix`: Electron with a Rust WASIX sidecar exposing a PostgreSQL URL.

Each app opts into `hstore`, `pg_trgm`, and `unaccent`, then uses `hstore`
tags plus trigram/accent-insensitive search for the todo list. Native examples
load `postgres`, `initdb`, and `pg_ctl` from `liboliphaunt-native-*`, while
`pg_dump` and `psql` come from `oliphaunt-tools-*`. WASIX examples load
`postgres` and `initdb` from the runtime crates and `pg_dump`/`psql` from
`oliphaunt-wasix-tools`; WASIX intentionally has no `pg_ctl`.

Local registry artifacts for Linux x64 from CI run `28049923289` can be
staged with:

```sh
python3 tools/release/local_registry_publish.py download --run-id 28049923289 --preset local-publish
python3 tools/release/package_liboliphaunt_cargo_artifacts.py \
  --asset-dir target/local-registry-artifacts/liboliphaunt-native-release-assets-linux-x64-gnu \
  --output-dir target/local-registry-generated/liboliphaunt-native-cargo \
  --target linux-x64-gnu
python3 tools/release/package_broker_cargo_artifacts.py \
  --asset-dir target/local-registry-artifacts/oliphaunt-broker-release-assets-linux-x64-gnu \
  --output-dir target/local-registry-generated/broker-cargo \
  --target linux-x64-gnu
python3 tools/release/package_liboliphaunt_wasix_cargo_artifacts.py \
  --asset-dir target/local-registry-artifacts/liboliphaunt-wasix-release-assets \
  --output-dir target/local-registry-generated/wasix-cargo \
  --extension-artifact-root target/local-registry-artifacts/oliphaunt-extension-package-artifacts
python3 tools/release/local_registry_publish.py publish \
  --artifact-root target/local-registry-generated/liboliphaunt-native-cargo \
  --artifact-root target/local-registry-generated/broker-cargo \
  --artifact-root target/local-registry-generated/wasix-cargo \
  --artifact-root target/local-registry-artifacts/oliphaunt-extension-package-artifacts
```

The native packaging step emits both `liboliphaunt-native-linux-x64-gnu` and
`oliphaunt-tools-linux-x64-gnu`. The WASIX packaging step emits
`liboliphaunt-wasix-portable`, `oliphaunt-wasix-tools`,
`liboliphaunt-wasix-aot-*`, and `oliphaunt-wasix-tools-aot-*`.

Run examples through the local registry helper so Cargo resolves
`registry = "oliphaunt-local"` and pnpm reads the local Verdaccio registry:

```sh
examples/tools/with-local-registries.sh pnpm --dir examples/electron install
examples/tools/with-local-registries.sh pnpm --dir examples/electron start
```

The native examples run a SQL backup smoke through `pg_dump` during startup.
The WASIX examples run `dump_sql("--schema-only")` during startup.

On Linux, SwiftPM artifacts are staged for inspection and skipped for registry
publish when `swift` is not installed.
