# Changelog

## Unreleased

- **Breaking:** make root `Oliphaunt` the synchronous, exclusive database API
  for direct and broker topologies, with a separate synchronous
  `OliphauntServer` lifecycle handle. Calls block until completion without an
  SDK owner-queue hop; native direct PostgreSQL still uses `liboliphaunt`'s
  internal backend thread.
- **Migration from 0.1.1:** the previously asynchronous root
  `oliphaunt::Oliphaunt` is now `oliphaunt::AsyncOliphaunt`. Rename that type
  (and its `AsyncOliphauntBuilder`, `AsyncOliphauntServer`, `AsyncSql`, and
  `AsyncTransaction` companions where named) and keep the existing `.await`
  calls. Use the new root `Oliphaunt` only when a blocking API is intended.
- Expose the cloneable asynchronous owner-thread API through named root
  `Async*` types; there is no public Rust `worker` namespace.
- Add default `Oliphaunt::open()` and `AsyncOliphaunt::open()` terminals and
  dedicated cloneable `OliphauntServerBuilder` / `AsyncOliphauntServerBuilder`
  terminals ending in `start()`.
- Add a thread-safe root `CancelHandle` so another thread can interrupt a
  synchronous operation without making the database handle shareable.
- Keep async restore and cancellation asynchronous, apply fair awaitable
  backpressure to ordinary owner work while reserving FIFO lifecycle admission,
  and make explicit close coalesced, phase-aware, and definitive. Capacity
  waiters that miss a close cutoff remain rejected even if that close is
  retryable. Root restore and close execute synchronously.
- Prevent owner failures and dropped reply senders from stranding futures;
  contain raw-stream callback panics and reject callback reentrancy. Typed
  direct and broker stream outcomes now resume a blocking callback
  panic only after confirmed `ReadyForQuery`; independent recovery failure is
  authoritative and poisons the session.
- **Breaking:** accept typed transaction and raw-stream callback errors. Callback
  transactions now return `TransactionResult<T, E>` / `TransactionError<E>`;
  streams accept `()` or `Result<(), E>` and return `RawStreamError<E>`. Literal
  rollback failure, independent database failure, recovered callback abort, and
  recovered async callback panic remain distinct public outcomes.
- **Breaking:** remove raw protocol methods from managed transaction handles;
  arbitrary protocol bytes cannot preserve the SDK-owned transaction boundary.
  Root database raw APIs remain available to protocol adapters which own their
  complete lifecycle. Structured callback-transaction methods reject
  `ROLLBACK`/`ABORT ... AND CHAIN` before dispatch while preserving savepoints
  and `ROLLBACK TO`.
- **Breaking:** make server handles endpoint/lifecycle-only. Use
  `connection_string()` with a PostgreSQL driver or ORM for SQL, transactions,
  cancellation, and raw protocol; server handles retain only `is_closed()` and
  `close()`.
- Validate an explicit native server executable before preparing persistent
  storage, so a deterministic path error cannot initialize or alter PGDATA.
- **Breaking:** make `Error` opaque and expose the shared non-exhaustive
  `ErrorKind` recovery categories plus typed PostgreSQL and transaction-cause
  accessors. `Error` no longer promises equality or destructuring stability.
- **Breaking:** make `Extension` an opaque selector with uppercase associated
  constants, `Extension::ALL`, `Extension::by_sql_name`, and `sql_name`; remove
  the old free constants and PascalCase aliases. Selecting an artifact never
  installs database-local extension objects.
- **Breaking:** remove the redundant `QueryParam` wrapper. Use natural
  `IntoParameter` values or `Parameter::{text,binary,null}` for dynamically
  typed values. Execution rejects an explicitly attached OID 0; leave the OID
  unset for execution-time inference, while `describe` continues to accept 0.
  Multi-statement `exec` now retains each notice on its statement result as
  well as in the operation-wide ordered notice list.
- Keep required transaction settlement admissible across an ordered close
  cutoff, and make every teardown-started close result terminal and replayable
  to concurrent or repeated callers. Pin-release failures are never discarded,
  poison lifecycle state, and failed teardown retains root ownership until
  process exit rather than invoking a second destructor.
- Keep out-of-band cancellation admissible while pre-cutoff SQL drains, with an
  atomic rejection boundary at destructive teardown.
- Split database and server builders so cross-topology options are
  unrepresentable; `broker_executable` is still rejected unless `broker()` is
  selected.
- Snapshot each ABI 10 native operation error through its same-call
  `*_with_error` capture; synchronous cancellation alone uses
  `oliphaunt_copy_last_error` because the C ABI has no cancel capture variant.
- Fail native broker handles permanently after helper exit or IPC failure.
  Recovery now requires an explicit close and new open; the SDK never replaces
  a session invisibly or replays work with an uncertain outcome.

## [0.1.1](https://github.com/f0rr0/oliphaunt/compare/oliphaunt-rust-v0.1.0...oliphaunt-rust-v0.1.1) (2026-08-08)


### Bug Fixes

* **runtime:** close mobile package and readiness gaps [skip ci] ([60b9df9](https://github.com/f0rr0/oliphaunt/commit/60b9df9de1d710d6faeb34114ac66409b689cf22))

## 0.1.0 (2026-07-28)


### Features

* introduce oliphaunt ([a4f438c](https://github.com/f0rr0/oliphaunt/commit/a4f438c3b2770a841efc8eb9864b474eb76e6114))
