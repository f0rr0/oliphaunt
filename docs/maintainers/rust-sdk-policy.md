# Rust SDK policy

The published `oliphaunt` crate is the idiomatic native Rust SDK. It owns app
configuration, typed queries, transactions, async execution, direct/broker/
server orchestration, exact extension selection, cluster-seed hydration, and
language-native errors. `liboliphaunt` remains the compiled direct/broker
boundary.

The public crate stays application focused. Native resource construction,
extension artifact/index creation and signing, package size reporting, and
release-policy generation belong to the unpublished workspace crate
`oliphaunt-native-packaging`, not to `oliphaunt`.

Current public concepts are:

- `Oliphaunt::builder()` and explicit native mode selection;
- SDK-owned temporary or application-owned directory storage;
- startup `username`, `database`, and validated PostgreSQL GUCs;
- exact typed `Extension` selections;
- typed query/command results, raw protocol, transactions, checkpoint, cancel,
  and close;
- one physical backup for direct and broker, plus static restore into a new or
  empty destination; and
- a connection string only in server mode.

Do not reintroduce capability reports, archive-format selectors, initialization
enums, tuning profiles, background lifecycle modes, or replacement switches.
Unsupported operations return a direct mode-specific error. Fixed support is
documented in the shared parity matrix.

Internal packaging commands use the workspace tool explicitly, for example:

```sh
cargo run -p oliphaunt-native-packaging --bin oliphaunt-resources -- ...
cargo run -p oliphaunt-native-packaging --bin oliphaunt-extension-artifact -- ...
cargo run -p oliphaunt-native-packaging --bin oliphaunt-extension-index -- ...
```

Validate the application crate with:

```sh
moon run oliphaunt-rust:check
moon run oliphaunt-rust:test
moon run oliphaunt-rust:package
```
