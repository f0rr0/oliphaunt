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

## [0.3.3]() (2026-10-11)


### Bug Fixes

* **release:** bind publication to package contracts and consumers ([#288](https://github.com/f0rr0/oliphaunt/issues/288)) ([027ffdc](https://github.com/f0rr0/oliphaunt/commit/027ffdcca83824a7a455926d4546a6b98b09c3c2))
* **release:** bind qualification to exact package versions ([#280](https://github.com/f0rr0/oliphaunt/issues/280)) ([cd68c6c](https://github.com/f0rr0/oliphaunt/commit/cd68c6c9655f53c50a3a98d4db36cfc256d26a3c))


### Dependencies

* Require liboliphaunt-wasix@0.3.3 for the default extension install.

## [0.3.2]() (2026-10-07)


### Bug Fixes

* **build:** scope package-test inputs and honor compiler caching ([#254](https://github.com/f0rr0/oliphaunt/issues/254)) ([b0e90b2](https://github.com/f0rr0/oliphaunt/commit/b0e90b279077f0d40e9270512a11ada156818f87))
* **packaging:** preserve independent SDK compatibility pins ([#251](https://github.com/f0rr0/oliphaunt/issues/251)) ([dabb453](https://github.com/f0rr0/oliphaunt/commit/dabb45393b209d99bcc9c18eb40daca828de68e2))


### Performance Improvements

* **wasix:** reduce initdb latency with private initialization ([#246](https://github.com/f0rr0/oliphaunt/issues/246)) ([410e5dc](https://github.com/f0rr0/oliphaunt/commit/410e5dcb861b7a4110520a115e9e5d0262284ad3))

## [0.3.1]() (2026-10-05)


### Performance Improvements

* **wasix:** reduce initdb latency with private initialization ([#246](https://github.com/f0rr0/oliphaunt/issues/246)) ([410e5dc](https://github.com/f0rr0/oliphaunt/commit/410e5dcb861b7a4110520a115e9e5d0262284ad3))

## [0.3.0]() (2026-09-29)


### ⚠ BREAKING CHANGES

* **mobile:** native runtime ABI advances to 12 for streaming archive APIs; rebuild native clients and workers with matching artifacts.
* **sdk:** Native extension lists use typed selections, and native TypeScript restore accepts a directory storage descriptor instead of a path.

### Features

* **mobile:** add unified iOS and Android broker modes ([#219](https://github.com/f0rr0/oliphaunt/issues/219)) ([6f205e9](https://github.com/f0rr0/oliphaunt/commit/6f205e966c6ce404f252ddcc5c5c1b0b8da47e31))


### Bug Fixes

* **ci:** unify Bun test entrypoints and import Swift signing keys ([#214](https://github.com/f0rr0/oliphaunt/issues/214)) ([a7724ef](https://github.com/f0rr0/oliphaunt/commit/a7724efe3ebda8c7f2e1af64d66b64fed645e3bf))
* **sdk:** align resource loading and extension selection ([#216](https://github.com/f0rr0/oliphaunt/issues/216)) ([b25d496](https://github.com/f0rr0/oliphaunt/commit/b25d49655de694525544c5553e77bdd83b2e1632))


### Code Refactoring

* model product dependencies and simplify qualification ([#209](https://github.com/f0rr0/oliphaunt/issues/209)) ([e058785](https://github.com/f0rr0/oliphaunt/commit/e0587850e153fb8f8866711aa73717ca37bdb657))
* organize sources by native and WASIX runtime families ([#215](https://github.com/f0rr0/oliphaunt/issues/215)) ([a8f9bfe](https://github.com/f0rr0/oliphaunt/commit/a8f9bfe75f4cff0426f0089eb248783efacbde2e))

## [0.2.0](https://github.com/f0rr0/oliphaunt/compare/oliphaunt-wasix-rust-v0.1.1...oliphaunt-wasix-rust-v0.2.0) (2026-09-05)


### ⚠ BREAKING CHANGES

* **wasix-ts:** run host runtimes through Rust Node-API ([#156](https://github.com/f0rr0/oliphaunt/issues/156))
* **sdk:** unify embedded PostgreSQL public APIs ([#153](https://github.com/f0rr0/oliphaunt/issues/153))
* Rust WASIX removes temporary/application-data storage variants, and browser IndexedDB uses the new per-database v3 layout without migrating prior generations.
* **release:** simplify releases and make contrib runtime-owned ([#127](https://github.com/f0rr0/oliphaunt/issues/127))

### Features

* **sdk:** unify embedded PostgreSQL public APIs ([#153](https://github.com/f0rr0/oliphaunt/issues/153)) ([4384d1b](https://github.com/f0rr0/oliphaunt/commit/4384d1bdfafee07e4e1963ac68027b4bcf002a1e))
* unify native and WASIX runtimes and SDKs ([#129](https://github.com/f0rr0/oliphaunt/issues/129)) ([fae2bd7](https://github.com/f0rr0/oliphaunt/commit/fae2bd7bde00ae436d9b62ba6a37d919679ac790))
* **wasix-ts:** run host runtimes through Rust Node-API ([#156](https://github.com/f0rr0/oliphaunt/issues/156)) ([28e07be](https://github.com/f0rr0/oliphaunt/commit/28e07be782388915b28ad3fd30e3e78143710d28))


### Performance Improvements

* **wasix:** accelerate regular-file seek end ([#162](https://github.com/f0rr0/oliphaunt/issues/162)) ([b411aa3](https://github.com/f0rr0/oliphaunt/commit/b411aa3ed0707ed8c49f2ef1583241d9ceb66335))


### Code Refactoring

* **ci:** model independent product dependencies ([#173](https://github.com/f0rr0/oliphaunt/issues/173)) ([2d5f90c](https://github.com/f0rr0/oliphaunt/commit/2d5f90c837ef7ecd8b43c2547e4b3c9b04767121))
* **release:** simplify releases and make contrib runtime-owned ([#127](https://github.com/f0rr0/oliphaunt/issues/127)) ([c45082d](https://github.com/f0rr0/oliphaunt/commit/c45082dc522f04ed0f020464282ed79150f83ecc))

## [0.1.1](https://github.com/f0rr0/oliphaunt/compare/oliphaunt-wasix-rust-v0.1.0...oliphaunt-wasix-rust-v0.1.1) (2026-08-08)


### Bug Fixes

* **runtime:** close mobile package and readiness gaps [skip ci] ([60b9df9](https://github.com/f0rr0/oliphaunt/commit/60b9df9de1d710d6faeb34114ac66409b689cf22))

## 0.1.0 (2026-07-28)


### Features

* introduce oliphaunt ([a4f438c](https://github.com/f0rr0/oliphaunt/commit/a4f438c3b2770a841efc8eb9864b474eb76e6114))
