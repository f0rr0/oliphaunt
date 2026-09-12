# oliphaunt-broker

`oliphaunt-broker` is the helper process used by broker mode. It owns one
native database root per process, serves PostgreSQL protocol 3.0, and
is packaged as platform-specific release assets for SDKs that need process
isolation.

Seeds and ICU data are optional, separate resources. New roots use `initdb`
unless `--seed-directory` and `--seed-manifest` select an unpacked native seed.
`--icu-data-directory` and `--icu-data-manifest` select ICU data. Each pair is
validated together by the shared Rust native bindings before initialization.
Existing roots do not read seed contents again. The broker bundles neither
resource; SDKs supply these arguments when explicitly selected.

The same package exports the transport library consumed by the Rust SDK.
Its executable uses `liboliphaunt-native-bindings` directly for native execution;
it does not depend on the public Rust SDK.

The SQL endpoint accepts one authenticated connection at a time. Ordinary
PostgreSQL drivers can use its user/database and the process password supplied
through `OLIPHAUNT_BROKER_AUTH_TOKEN`; query results, incremental Flush/Sync,
COPY and cancellation use PostgreSQL's protocol. This remains one embedded
backend, not a concurrent PostgreSQL server.

SDKs also hold a separate authenticated management connection for physical
backup and process shutdown. Its EOF retires the helper when the owning
application dies. SQL Terminate resets the native session and permits a new
SQL connection; it does not shut down the management owner. Backend cancellation
keys change on each connection. If a disconnected client abandons an incomplete
protocol batch that cannot drain within three seconds, the helper exits and the
application must explicitly reopen its database. No request is replayed and no
missing Sync is manufactured.

## Release licensing

The source-only `oliphaunt-broker` crate is Oliphaunt code under MIT. The four
compiled target carriers also contain the exact normal
Rust dependency graph selected for their OS target. Those binary carriers
therefore declare the complete payload expression and carry a target-specific
`THIRD_PARTY_LICENSES/rust/DEPENDENCIES.json` plus its byte-pinned license
texts.

`dependency-licenses.json` binds every registry dependency to its Cargo.lock
name, version, checksum, declared license, selected redistribution branch,
target set, and complete LICENSE/UNLICENSE/COPYING/NOTICE/COPYRIGHT plus
author, credit, patent, and third-party attribution inventory.
`broker/tools/broker-dependency-license-contract.mts check-contract` verifies
the self-contained contract and committed canonical blobs without consulting
Cargo or a registry cache. The connected production audit runs
`bash broker/tools/audit-dependency-licenses.sh`: Cargo fetches any
missing locked dependencies, then supplies all four target graphs offline. The
audit checks every legal file against its committed bytes and SHA-256, including
files already in the Cargo cache. A dependency update is incomplete until that audit passes and
all four packed target carriers reopen the exact updated closure.

## Maintainer commands

Run these commands from this directory with the repository-pinned Rust toolchain, Moon and Bun available. Cargo resolves versioned workspace dependencies itself; no runtime build is needed for source tests. Bash is required for package staging (Git Bash on Windows). The initial locked Cargo fetch needs network access.

| Command | Result |
| --- | --- |
| `moon run oliphaunt-broker:format` | Rewrite Rust formatting. |
| `moon run oliphaunt-broker:format-check` | Check formatting without changing files. |
| `moon run oliphaunt-broker:lint` | Clippy diagnostics for all targets; no database execution. |
| `moon run oliphaunt-broker:build` | Compile this project and its Cargo dependencies. |
| `moon run oliphaunt-broker:test` | Run source tests; Cargo compiles the required test targets. |
| `moon run oliphaunt-broker:test-integration` | Build the native runtime and exercise the real broker's SQL and management endpoints. |
| `moon run oliphaunt-broker:package` | Stage distributable source crates under target/sdk-artifacts/oliphaunt-broker; repeated runs replace this owner’s candidates. |

With `LIBOLIPHAUNT_PATH`, `OLIPHAUNT_INSTALL_DIR` and (when needed)
`OLIPHAUNT_EMBEDDED_MODULE_DIR` pointing to a prepared runtime, run
`cargo test --locked --test postgres_client -- --ignored`. These tests launch the
actual broker and exercise large parameters after Flush, simultaneous large
requests and responses, COPY, cancellation, callback recovery, connection reset,
backup/shutdown, abrupt disconnect, and parent death. They fail when required
runtime inputs are missing; source-only tests report them as ignored.

Native Cargo entry points remain available: `cargo build -p oliphaunt-broker --locked`, `cargo test -p oliphaunt-broker --locked`, `cargo clippy -p oliphaunt-broker --all-targets --locked -- -D warnings`, and `cargo fmt -p oliphaunt-broker --check`. Moon supplies the additional source-test feature matrix and artifact staging where defined. `package` assembles bytes; it does not run the project test suite.

The native SDK’s `moon run oliphaunt-rust:test-consumer` installs the real packed query, bindings and broker crates together with the SDK. This tests their public dependency closure without duplicate per-crate consumer harnesses.

`build-release-assets` and `finalize-release-assets` remain explicit target-specific binary-carrier production tasks. They require the matching target toolchain and licensing inputs; source-crate packaging does not build those binaries.
