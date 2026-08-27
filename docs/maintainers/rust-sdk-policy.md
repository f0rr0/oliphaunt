# Rust SDK policy

The published `oliphaunt` crate is the idiomatic native Rust SDK. It owns app
configuration, typed queries, transactions, synchronous caller-thread and
explicit asynchronous worker execution, direct/broker/server orchestration,
exact extension selection, cluster-seed hydration, and language-native errors.
`liboliphaunt` remains the compiled direct/broker boundary.

The public crate stays application focused. Native resource construction,
extension artifact/index creation and signing, package size reporting, and
release-policy generation belong to the unpublished workspace crate
`oliphaunt-native-packaging`, not to `oliphaunt`.

That workspace tool enables `internal-native-packaging` and consumes the
version-locked `oliphaunt::__private::packaging` seam. The seam is absent from
default builds, is inventoried separately, and may change only together with
the unpublished tool; its symbols are not application API.

The separately built, unpublished `oliphaunt-broker` executable consumes one
exact-version internal seam. It enables the non-default
`__internal-broker-helper` feature and accesses `oliphaunt::__private`; the
module is absent from default builds, is not application API, and may change
only in lockstep with that executable. Keeping the seam in-process avoids an
extra owner-thread hop inside the process whose sole job is to own PostgreSQL.
Its symbols are still listed separately in the generated API inventory so a
review cannot accidentally widen it.

Current public concepts are:

- `Oliphaunt::builder()` and explicit native mode selection;
- SDK-owned temporary or application-owned directory storage;
- startup `username`, `database`, and validated PostgreSQL GUCs;
- exact typed `Extension` selections;
- a fluent `Sql` statement builder, typed query/command results, raw protocol,
  transactions, root `CancelHandle` or worker cancellation, and close;
- one physical backup for direct and broker, plus static restore into a new or
  empty destination; and
- a connection string only in server mode.

The root builder constructs direct, broker, and server state synchronously on
the calling thread. `oliphaunt::worker::OliphauntBuilder::open().await`
constructs the same selected topology on a permanent owner thread, which also
serializes later runtime work. All worker commands and `close()` share one
admission order. Close drains work
admitted before its cutoff and rejects later application work; it must never use
a global closing flag to invalidate commands already ahead of the close command.
A pre-cutoff `BEGIN` is therefore authoritative: if it succeeds, close reports
`TransactionActive`, retains the session, and restores admission for an
explicit retry after transaction cleanup. Its required `COMMIT` or `ROLLBACK`
uses reserved, owner-reentrancy-checked admission and remains FIFO-admissible
after the cutoff. `TransactionActive` and any other validation failure before
teardown starts leave the handle retryable. After direct detach, broker
shutdown, or server shutdown begins, any result is terminal: `is_closed()` is
true, work is rejected, and all concurrent or later close calls receive the one
stored exact result.
PostgreSQL `CHECKPOINT` remains available through
ordinary `execute("CHECKPOINT")`; the SDK does not add a one-statement
convenience method.

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
