# Changelog

## Unreleased

- Fail broker database objects permanently after helper or IPC failure. Close
  and explicitly open a new object for PostgreSQL WAL recovery; the SDK never
  substitutes a new session or replays uncertain work under the old object.

## [0.1.1](https://github.com/f0rr0/oliphaunt/compare/oliphaunt-js-v0.1.0...oliphaunt-js-v0.1.1) (2026-08-08)


### Bug Fixes

* **runtime:** close mobile package and readiness gaps [skip ci] ([60b9df9](https://github.com/f0rr0/oliphaunt/commit/60b9df9de1d710d6faeb34114ac66409b689cf22))

## 0.1.0 (2026-07-28)


### Features

* introduce oliphaunt ([a4f438c](https://github.com/f0rr0/oliphaunt/commit/a4f438c3b2770a841efc8eb9864b474eb76e6114))
