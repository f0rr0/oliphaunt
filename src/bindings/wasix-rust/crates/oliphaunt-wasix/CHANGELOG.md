# Changelog

## Unreleased

- Keep the synchronous, no-hop database, SQL builder, transactions, raw
  protocol, server, and tools at the crate root. PostgreSQL work runs on the
  calling thread; the server continues to own its listener/backend thread.
- Add root `AsyncOliphaunt` and `AsyncOliphauntServer` types for cloneable
  asynchronous handles backed by dedicated owner threads. The published root
  `Oliphaunt` API remains synchronous; no migration is required for existing
  WASIX Rust callers, and there is no public Rust `worker` namespace.
- Make packaged `pg_dump` and `psql` fluent methods on both database handles:
  synchronous `database.pg_dump(options)` / `database.psql(options)` and
  asynchronous `database.pg_dump(options).await` /
  `database.psql(options).await`.
- Add fair, awaitable bounded owner admission, pinned asynchronous
  transactions, best-effort rollback when an in-flight transaction future is
  abandoned, and explicit owner-stop errors. Close rejects capacity waiters
  that miss its cutoff even when pre-shutdown validation makes close retryable.
- Make the direct transaction callback unwind-safe: a panic rolls back when
  possible, poisons uncertain state, releases ownership, and is rethrown.
- Keep raw-stream callback output draining after callback failure. Resume a
  direct callback panic or return its error only after the guest protocol pump
  confirms recovery; an independent pump failure takes precedence and poisons
  the session until close.
- **Breaking:** make transaction and raw-stream callback failures generic and
  symmetric with native Rust. Transactions return `TransactionError<E>` with
  honest rollback-versus-independent-database composites; stream callbacks use
  `()` or `Result<(), E>`, and recovered async callback panics have their own
  `RawStreamError::CallbackPanicked` classification.
- Use `Error::transaction_rollback_errors()` for the same callback/rollback
  error-pair access as native Rust, retiring the redundant public WASIX-only
  wrapper and singular accessor as part of the breaking API unification.
- **Breaking:** make `Error` opaque and add the shared non-exhaustive
  `ErrorKind` recovery categories without message-based classification or an
  equality promise.
- **Breaking:** remove raw protocol from managed transaction handles and make
  server handles endpoint/lifecycle-only. Root databases retain the raw escape
  hatch; server SQL goes through `connection_string()` and a PostgreSQL driver.
  Structured callback-transaction methods reject `ROLLBACK`/`ABORT ... AND
  CHAIN` before dispatch while preserving savepoints and `ROLLBACK TO`.
- **Breaking:** replace the public extension module/free values with an opaque
  root `Extension` and uppercase associated constants. Each selector,
  `Extension::ALL`, and `by_sql_name` now reflects exactly the enabled
  `extension-*` Cargo features. Selection materializes artifacts and required
  pre-start configuration only; migrations own `CREATE EXTENSION`, `LOAD`, and
  all database-local setup.
- **Breaking:** remove the redundant `QueryParam` wrapper. Use natural
  `IntoParameter` values or `Parameter::{text,binary,null}` for dynamically
  typed values. Execution rejects an explicitly attached OID 0; leave the OID
  unset for execution-time inference, while `describe` continues to accept 0.
  Multi-statement `exec` now retains each notice on its statement result as
  well as in the operation-wide ordered notice list.
- Keep the direct server handle after `close(&mut self)`, add `is_closed()`,
  and replay the first terminal close result on repeated calls.

## [0.1.1](https://github.com/f0rr0/oliphaunt/compare/oliphaunt-wasix-rust-v0.1.0...oliphaunt-wasix-rust-v0.1.1) (2026-08-08)


### Bug Fixes

* **runtime:** close mobile package and readiness gaps [skip ci] ([60b9df9](https://github.com/f0rr0/oliphaunt/commit/60b9df9de1d710d6faeb34114ac66409b689cf22))

## 0.1.0 (2026-07-28)


### Features

* introduce oliphaunt ([a4f438c](https://github.com/f0rr0/oliphaunt/commit/a4f438c3b2770a841efc8eb9864b474eb76e6114))
