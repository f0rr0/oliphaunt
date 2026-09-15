# oliphaunt-query

Runtime-independent PostgreSQL query encoding, decoding, results and diagnostics shared by the native and WASIX Rust SDKs. This crate depends only on the Rust standard library.

Run `cargo test`, `cargo check`, or `cargo fmt --check` from this directory. Database execution and lifecycle belong to the consuming SDKs.

## Maintainer commands

Run these commands from this directory with the repository-pinned Rust toolchain, Moon and Bun available. Cargo resolves versioned workspace dependencies itself; no runtime build is needed for source tests. Bash is required for package staging (Git Bash on Windows). The initial locked Cargo fetch needs network access.

| Command | Result |
| --- | --- |
| `moon run oliphaunt-query:format` | Rewrite Rust formatting. |
| `moon run oliphaunt-query:format-check` | Check formatting without changing files. |
| `moon run oliphaunt-query:lint` | Clippy diagnostics for all targets; no database execution. |
| `moon run oliphaunt-query:build` | Compile this project and its Cargo dependencies. |
| `moon run oliphaunt-query:test` | Run source tests; Cargo compiles the required test targets. |
| `moon run oliphaunt-query:package` | Stage distributable source crates under target/sdk-artifacts/oliphaunt-query; repeated runs replace this owner’s candidates. |

Native Cargo entry points remain available: `cargo build -p oliphaunt-query --locked`, `cargo test -p oliphaunt-query --locked`, `cargo clippy -p oliphaunt-query --all-targets --locked -- -D warnings`, and `cargo fmt -p oliphaunt-query --check`. Moon supplies the additional source-test feature matrix and artifact staging where defined. `package` assembles bytes; it does not run the project test suite.

The native SDK’s `moon run oliphaunt-rust:test-consumer` installs the real packed query, bindings and broker crates together with the SDK. This tests their public dependency closure without duplicate per-crate consumer harnesses.
