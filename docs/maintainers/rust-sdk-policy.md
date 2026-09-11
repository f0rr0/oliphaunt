# Rust SDK policy

The published `oliphaunt` crate is the idiomatic native Rust SDK. It owns app
configuration, typed queries, transactions, synchronous and explicit
asynchronous calling shapes, direct/broker/server orchestration,
exact extension artifact selection, cluster-seed hydration, and
language-native errors.
`liboliphaunt` remains the compiled direct/broker boundary.

The public crate stays application focused. Selectable seeds and ICU data are
produced by `database-resources`; extension products own extension carriers.
The remaining private `oliphaunt-native-packaging` tool composes mobile runtime
and static-extension resources. It depends directly on
`liboliphaunt-native-bindings` with `internal-native-packaging`, without exposing
a packaging feature or private packaging API through the public SDK.

`broker/` now owns the independently versioned `oliphaunt-broker` library and
executable. Both the broker and the native SDK depend on
`liboliphaunt-native-bindings` in `sdks/rust/liboliphaunt-native`; the broker no
longer reaches back into a private SDK broker feature. SQL and cancellation use
PostgreSQL wire framing. Backup and shutdown use a separate authenticated
management connection. Swift and Kotlin reach the same native implementation
through the private `sdks/rust/mobile-bindings` UniFFI adapter.

Current public concepts are:

- default `Oliphaunt::open()` / `AsyncOliphaunt::open()` terminals,
  type-associated database builders, and explicit direct or broker selection;
- SDK-owned temporary or application-owned directory storage;
- startup `username`, `database`, and validated PostgreSQL GUCs;
- exact typed `Extension` artifact selections;
- a fluent `Sql` statement builder, typed query/command results, raw protocol,
  callback transactions without transaction-level raw protocol, root
  `CancelHandle` or async-handle cancellation, and close;
- explicit optional seed and ICU-data inputs; reopening an existing database
  does not require an initialization seed;
- one physical backup for direct and broker, plus static restore into a new or
  empty destination; and
- dedicated synchronous and asynchronous server builders whose handles expose
  only connection string, closed state, and close.

`OliphauntBuilder::open()` exposes blocking direct and broker calls without an
SDK owner-queue hop. Those calls occupy the caller until completion; native
direct PostgreSQL still runs on `liboliphaunt`'s internal backend pthread.
`AsyncOliphauntBuilder::open().await` constructs the selected direct or broker
topology on a permanent SDK owner thread, which also serializes later runtime
work. `OliphauntServerBuilder::start()` and
`AsyncOliphauntServerBuilder::start().await` are deliberately separate: a
server is an endpoint owner, not a privileged database session. Ordinary async
database calls await fair, bounded admission instead of returning a queue-full
error. Admitted commands and `close()` share one owner order. Close
drains work already admitted before its cutoff and rejects later work plus
capacity waiters that had not entered the owner FIFO; a retryable close must not
resurrect those stale waiters. Close must never use
a global closing flag to invalidate commands already ahead of the close command.
A pre-cutoff `BEGIN` is therefore authoritative: if it succeeds, close reports
`TransactionActive`, retains the session, and restores admission for an
explicit retry after transaction cleanup. Its required `COMMIT` or `ROLLBACK`
uses reserved, owner-reentrancy-checked admission and remains FIFO-admissible
after the cutoff. `TransactionActive` and any other validation failure before
teardown starts leave the handle retryable. After direct detach, broker
shutdown, or server shutdown begins, any result is terminal: `is_closed()` is
true, work is rejected, and all concurrent or later close calls receive the one
stored exact result. Only successful teardown releases session and managed-root
ownership. A failed teardown intentionally retains that ownership until process
exit rather than invoking an unproven second cleanup path.

## Shared Rust public shape

Native and WASIX expose the same conceptual Rust shape without hiding their
different execution owners:

- blocking native `Oliphaunt` is `Send` but not `Sync`; blocking WASIX
  `Oliphaunt` is neither `Send` nor `Sync`;
- blocking `OliphauntServer` is `Send` but not `Sync`; the WASIX endpoint now
  belongs to the separate `oliphaunt-pgwire-server` package;
- `AsyncOliphaunt` and `AsyncOliphauntServer` are cloneable, `Send + Sync`
  owner handles; and
- `AsyncTransaction` is `Send` but not `Sync`, and its operations require
  exclusive `&mut` access.

Both products root-export opaque public value types rather than exposing their
runtime-specific implementation errors or extension catalogs:

- `Error` is `Clone + std::error::Error + Send + Sync`.
  `#[non_exhaustive] ErrorKind` is `Debug + Clone + Copy + Eq + Hash` and has
  exactly `InvalidConfiguration`, `Lifecycle`, `TransactionActive`, `Postgres`,
  and `Other`; `Error::kind()` is the stable category boundary. Existing
  `postgres_error()`, `transaction_rollback_errors()`, and
  `transaction_callback_database_errors()` accessors retain detailed causes;
  WASIX adds `tool_error()` only with its `tools` feature.
- `Extension` is an opaque `Copy + Eq + Hash + Ord` selector with uppercase
  associated constants, `Extension::ALL`, `Extension::by_sql_name`, and
  `sql_name`. Native `ALL` contains the packaged PostgreSQL 18 catalog. WASIX
  exposes the type and builder methods under `extensions` and includes only
  Cargo-feature-enabled extensions. Neither product exposes free/module
  constants or PascalCase compatibility aliases.

Selecting an extension makes its runtime artifact, dependencies, and required
pre-start preload/GUC settings available. It never executes `CREATE EXTENSION`,
`ALTER EXTENSION`, `LOAD`, schema setup, or post-create SQL; application and ORM
migrations own database-local installation and upgrades.

Database/root handles alone expose buffered and callback-streamed raw protocol.
Managed transaction handles expose structured `query`, `execute`, `exec`, and
`describe`, plus explicit rollback, but no raw escape hatch. Their ownership
guard inspects every exact `CommandComplete` tag and the single terminal
`ReadyForQuery` before high-level parsing. Manual transaction lifecycle SQL and
`AND CHAIN` are unsupported; savepoints and `ROLLBACK TO` remain valid. Because
PostgreSQL reports both `ROLLBACK TO` and `ROLLBACK AND CHAIN` as `ROLLBACK`
with transactional readiness, the shared lexer rejects top-level
`ROLLBACK`/`ABORT ... AND CHAIN` before dispatch while preserving comments,
quoted text, and `ROLLBACK TO`. Exact backend tags and terminal readiness remain
the authoritative boundary validation. Proven or uncertain ownership escape
retires the database without sending speculative follow-up `COMMIT` or
`ROLLBACK`.

Stream callback failure is recoverable only when the topology adapter returns a
typed, independently confirmed `ReadyForQuery` outcome. The blocking API then
resumes its original callback panic; the async owner reports a recovered panic
as `RawStreamError::CallbackPanicked` and leaves the session reusable. A
transport/runtime failure without that proof is authoritative, must not be
masked by the callback outcome, and is `RawStreamError::Database`; it poisons
the session until close.

A blocking transaction callback panic is contained until synchronous
settlement completes, then resumed when the outcome is known. An async
transaction-body panic unwinds its awaiting task immediately; dropping the
active transaction enqueues best-effort rollback in the owner FIFO. The unwind
does not imply rollback has completed, but subsequent database work cannot
overtake it.

Each broker database handle owns one helper generation. Helper exit, liveness
uncertainty, or primary IPC failure permanently fails that handle and retains
the first error. The SDK must not relaunch a helper, replace session state, or
replay a request beneath an existing public handle. Recovery is explicit close
plus a new open on persistent storage.
PostgreSQL `CHECKPOINT` remains available through
ordinary `execute("CHECKPOINT")`; the SDK does not add a one-statement
convenience method.

Do not reintroduce capability reports, archive-format selectors, initialization
enums, tuning profiles, background lifecycle modes, or replacement switches.
Unsupported operations return a direct mode-specific error. Fixed support is
documented in the shared parity matrix.

The unpublished native packaging crate assembles local runtime and extension
resources for mobile producers through `oliphaunt-resources`. It depends on the
shared native bindings directly. Use `database-resources` tasks for selectable
seed/ICU assets and extension owner tasks for release artifacts.

Validate the application crate with:

```sh
moon run oliphaunt-rust:build
moon run oliphaunt-rust:test
moon run oliphaunt-rust:package
```
