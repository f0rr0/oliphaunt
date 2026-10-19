# Native PostgreSQL tools

This product owns the `oliphaunt-tools` Rust facade, `@oliphaunt/tools` npm facade, and their platform-specific tool carriers. Its versions are independent of the native database runtime.

`moon run postgres-tools-native:test` runs Rust tools source tests, including the shared argument contract. `moon run postgres-tools-native:build` builds both Rust and npm facades without compiling PostgreSQL. `moon run postgres-tools-native:package-assets` builds the native PostgreSQL prerequisite and assembles the current platform's executables and their own shared libraries; `test-assets` checks that archive's platform compatibility. Native Windows and macOS producers require those hosts and their compiler toolchains.

The separate Rust integration proof starts native SDK servers and uses the public Rust `psql` and `pg_dump` APIs to seed, dump, restore and verify a database. It is ignored by ordinary Cargo test runs because it requires prepared runtime and extension resources. Invoke it explicitly from this directory:

```sh
export LIBOLIPHAUNT_PATH=/absolute/path/to/liboliphaunt.so
export OLIPHAUNT_INSTALL_DIR=/absolute/path/to/native-runtime
export OLIPHAUNT_TOOLS_DIR=/absolute/path/to/tools/runtime
export OLIPHAUNT_RESOURCES_DIR=/absolute/path/to/prepared-sdk-resources
export OLIPHAUNT_ICU_DATA_DIR=/absolute/path/to/verified-icu-data
cargo test -p oliphaunt-native-tools-proof --locked --lib -- --ignored native_server_pg_dump_psql_round_trip
```

Use the host's library suffix. The native install must contain the server/initdb programs and their supporting files. The SDK resources must include the packaged `pgtap` extension and native runtime resources; ICU must match that runtime. Missing resources fail the explicit test through the actual SDK/resource loaders. There is no best-effort availability probe. The proof manages and removes its temporary database directories.
