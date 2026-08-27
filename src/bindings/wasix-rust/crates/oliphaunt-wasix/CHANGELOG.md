# Changelog

## Unreleased

- Make the root database and server APIs asynchronous and cloneable so embedded
  PostgreSQL work and server lifecycle waits do not block the calling executor.
- Preserve the synchronous API under `oliphaunt_wasix::blocking`, including its
  no-hop direct database, SQL builder, transactions, raw protocol, server, and
  tools. The server continues to own its existing listener/backend thread.
- Add bounded owner admission, pinned asynchronous transactions, best-effort
  rollback when an in-flight transaction future is abandoned, and explicit
  owner-stop errors.
- Make the blocking transaction callback unwind-safe: a panic rolls back when
  possible, poisons uncertain state, releases ownership, and is rethrown.
- Keep the blocking server handle after `close(&mut self)`, add `is_closed()`,
  and replay the first terminal close result on repeated calls.

## [0.1.1](https://github.com/f0rr0/oliphaunt/compare/oliphaunt-wasix-rust-v0.1.0...oliphaunt-wasix-rust-v0.1.1) (2026-08-08)


### Bug Fixes

* **runtime:** close mobile package and readiness gaps [skip ci] ([60b9df9](https://github.com/f0rr0/oliphaunt/commit/60b9df9de1d710d6faeb34114ac66409b689cf22))

## 0.1.0 (2026-07-28)


### Features

* introduce oliphaunt ([a4f438c](https://github.com/f0rr0/oliphaunt/commit/a4f438c3b2770a841efc8eb9864b474eb76e6114))
