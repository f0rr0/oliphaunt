# Changelog

## Unreleased

- Construct native sessions on their permanent SDK owner thread and keep the
  root API asynchronous across direct, broker, and server topologies.
- Make restore and out-of-band cancellation asynchronous, bound ordinary owner
  work while reserving FIFO lifecycle admission, and make explicit close
  coalesced, phase-aware, and definitive.
- Prevent owner failures and dropped reply senders from stranding futures;
  contain raw-stream callback panics and reject callback reentrancy.
- Keep required transaction settlement admissible across an ordered close
  cutoff, and make every teardown-started close result terminal and replayable
  to concurrent or repeated callers.
- Keep out-of-band cancellation admissible while pre-cutoff SQL drains, with an
  atomic rejection boundary at destructive teardown.
- Reject builder options at the wrong `open()` or `open_server()` terminal
  instead of silently ignoring topology-specific configuration.
- Snapshot native errors into Rust-owned memory through
  `oliphaunt_copy_last_error`.

## [0.1.1](https://github.com/f0rr0/oliphaunt/compare/oliphaunt-rust-v0.1.0...oliphaunt-rust-v0.1.1) (2026-08-08)


### Bug Fixes

* **runtime:** close mobile package and readiness gaps [skip ci] ([60b9df9](https://github.com/f0rr0/oliphaunt/commit/60b9df9de1d710d6faeb34114ac66409b689cf22))

## 0.1.0 (2026-07-28)


### Features

* introduce oliphaunt ([a4f438c](https://github.com/f0rr0/oliphaunt/commit/a4f438c3b2770a841efc8eb9864b474eb76e6114))
