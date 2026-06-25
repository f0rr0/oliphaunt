# Oliphaunt Examples

These examples keep the same todo schema across desktop shells:

- `tauri`: Tauri v2 with the native Rust SDK.
- `tauri-wasix`: Tauri v2 with `oliphaunt-wasix` and SQLx.
- `electron`: Electron with the TypeScript SDK and native broker mode.
- `electron-wasix`: Electron with a Rust WASIX sidecar exposing a PostgreSQL URL.

Each app opts into `hstore`, `pg_trgm`, and `unaccent`, then uses `hstore`
tags plus trigram/accent-insensitive search for the todo list.

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

Run examples through the local registry helper so Cargo resolves
`registry = "oliphaunt-local"` and pnpm reads the local Verdaccio registry:

```sh
examples/tools/with-local-registries.sh pnpm --dir examples/electron install
examples/tools/with-local-registries.sh pnpm --dir examples/electron start
```

On Linux, SwiftPM artifacts are staged for inspection and skipped for registry
publish when `swift` is not installed.
