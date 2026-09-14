# liboliphaunt-native-bindings

Native liboliphaunt sessions, cancellation, raw PostgreSQL protocol execution, physical backups, and database resource preparation. The Rust SDK and broker consume this crate. Server process management and broker transport belong to their respective products.

`NativeConfig::default()` selects no seed or ICU data. New roots use the prepared
runtime's `initdb`; existing roots retain their catalog. `NativeClusterSeed::new`
accepts an explicit seed carrier's `seed_archive()` and `seed_manifest()` bytes.
`NativeClusterSeed::Directory` accepts an unpacked native seed directory and its
receipt. `NativeResourceDirectory` supplies explicit ICU data and its receipt.
These types are also reexported by the public Rust SDK, whose builders expose
`seed` and `icu_data`. The broker uses the same guarded initialization.

The ignored `resource_selection` integration test requires an actual native
runtime plus selected resources. Set `LIBOLIPHAUNT_PATH`, `OLIPHAUNT_INSTALL_DIR`,
`OLIPHAUNT_EMBEDDED_MODULE_DIR`, `OLIPHAUNT_TEST_STANDARD_SEED` and
`OLIPHAUNT_TEST_ICU_SEED` (carrier directories containing `seed.tar.zst` and
`manifest.json`), and `OLIPHAUNT_TEST_ICU_DATA` / `OLIPHAUNT_TEST_ICU_MANIFEST`.
Run each profile in its own process because native terminal shutdown is final:

```sh
for profile in standard icu; do
  OLIPHAUNT_TEST_PROFILE="$profile" cargo test --locked --test resource_selection -- --ignored
done
```

It verifies actual seeded queries, ICU collation, seedless initialization,
reopening without usable seed input, and corrupt-input rejection before PGDATA
publication. Missing resource inputs fail this explicit command.

`NativeSession::protocol_input()` resolves concurrent input support for a running
raw protocol stream. Its cloned handle reports the active stream token and feeds
complete frontend frames to that exact stream; a full native queue returns
`false` without consuming bytes. Detached sessions and stale stream tokens fail.
With `LIBOLIPHAUNT_PATH` and `OLIPHAUNT_INSTALL_DIR` pointing to a prepared native
runtime, run `cargo test --locked --test protocol_input -- --ignored`. This proves
extended-query Flush followed by a later Sync, incremental COPY FROM STDIN,
malformed input rejection, and rejection of input from an earlier stream.

## Maintainer commands

Run these commands from this directory with the repository-pinned Rust toolchain, Moon and Bun available. Cargo resolves versioned workspace dependencies itself; no runtime build is needed for source tests. Bash is required for package staging (Git Bash on Windows). The initial locked Cargo fetch needs network access.

| Command | Result |
| --- | --- |
| `moon run liboliphaunt-native-bindings:format` | Rewrite Rust formatting. |
| `moon run liboliphaunt-native-bindings:format-check` | Check formatting without changing files. |
| `moon run liboliphaunt-native-bindings:lint` | Clippy diagnostics for all targets; no database execution. |
| `moon run liboliphaunt-native-bindings:build` | Compile this project and its Cargo dependencies. |
| `moon run liboliphaunt-native-bindings:test` | Run source tests; Cargo compiles the required test targets. |
| `moon run liboliphaunt-native-bindings:package` | Stage distributable source crates under target/sdk-artifacts/liboliphaunt-native-bindings; repeated runs replace this owner’s candidates. |

Native Cargo entry points remain available: `cargo build -p liboliphaunt-native-bindings --locked`, `cargo test -p liboliphaunt-native-bindings --locked`, `cargo clippy -p liboliphaunt-native-bindings --all-targets --locked -- -D warnings`, and `cargo fmt -p liboliphaunt-native-bindings --check`. Moon supplies the additional source-test feature matrix and artifact staging where defined. `package` assembles bytes; it does not run the project test suite.

The native SDK’s `moon run oliphaunt-rust:test-consumer` installs the real packed query, bindings and broker crates together with the SDK. This tests their public dependency closure without duplicate per-crate consumer harnesses.
