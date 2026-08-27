# Rust SDK architecture

The Rust SDK is a native binding over `liboliphaunt`. It does not wrap the
WASIX binding and has no runtime fallback matrix.

## Public boundary

The public database boundary is:

- `Oliphaunt::builder()` for direct and broker databases.
- `OliphauntBuilder::open_server()` for the distinct local-server handle.
- PostgreSQL-shaped execute, query, parameter, result, transaction,
  cancellation, raw protocol, and close methods.
- One byte physical-backup method on direct and broker databases.
- One static restore operation into an absent or empty destination.

Internal engine modes, runtime profiles, lifecycle requests, backup envelopes,
resource manifests, package reports, and protocol parsers are not public API.
The shared builder validates its terminal: direct/broker selectors and broker
executable options belong to `open()`, while listener and server executable
options belong to `open_server()`. Cross-topology configuration is rejected,
never ignored.

## Runtime ownership

Direct mode owns one embedded PostgreSQL backend in the application process.
Broker mode owns the same backend in one authenticated helper process. Both
present the same `Oliphaunt` API and serialize commands through one owner
executor.

Server mode starts a normal local PostgreSQL server, opens one SDK connection,
and returns `OliphauntServer` with a nonoptional libpq connection string. It is
the only product that supports independent external client connections. Its
handle has no physical-backup method because PostgreSQL already provides
`pg_basebackup`; the optional endpoint-oriented `oliphaunt-tools` crate runs
plain `pg_dump` and non-interactive `psql` without entering the core SDK API.

The engine traits, C symbols, broker frames, server wire client, and artifact
materialization helpers are crate-internal. The only `#[doc(hidden)]` exports are
narrow cross-crate boundaries consumed by the unpublished broker and packaging
tools.

## Execution and transactions

An owner thread is the single place that constructs and calls a runtime
session. A session is never opened on a temporary thread and then transferred.
Cloneable SDK handles share the owner; cloning does not create a PostgreSQL
connection. This is scheduling ownership, not another public topology.

Ordinary application work enters one bounded FIFO. Transaction control,
rollback cleanup, and close enter the same FIFO through reserved admission, so
queue pressure cannot strand lifecycle work and cannot reorder cleanup ahead of
an already-admitted COMMIT. Close and command admission share one lock: work
admitted before the close cutoff remains ahead of Close and drains, while later
application work is rejected. The closing state is never used to invalidate a
command that is already in the FIFO. If a queued `BEGIN` succeeds before Close,
the owner rejects that close attempt with `TransactionActive`, restores open
admission, and retains the session for retry. If an operation future is dropped
before the owner starts it, the command is skipped. Once PostgreSQL execution
starts, dropping the future is not cancellation and the owner completes through
its readiness boundary. Required `COMMIT` and `ROLLBACK` settlement for a pin
created by a pre-cutoff `BEGIN` remains admissible after the cutoff through a
reserved, reentrancy-checked path and retains FIFO order with Close.

A transaction pin rejects unrelated work while its callback is active. Body
failure rolls back. A failed rollback poisons the session. COMMIT uncertainty
never triggers a later ROLLBACK because PostgreSQL may already have committed;
the session is poisoned unless PostgreSQL explicitly returns the known idle
`ROLLBACK` command tag. Pin cleanup remains admissible after poisoning so close
cannot strand the owner thread.

Cancellation is asynchronous and out of band: the C cancellation hook in direct
mode, a separate authenticated endpoint in broker mode, and PostgreSQL
CancelRequest in server mode. The ordinary-work close cutoff does not disable
cancellation while earlier admitted work drains; cancellation admission closes
atomically only when destructive teardown begins. Close does not implicitly
cancel active work. Concurrent close callers share one attempt. Explicit close
resolves only after session destruction or a terminal teardown failure.
`TransactionActive` and other validation failures before destruction leave the
session retryable. Once direct detach, broker shutdown, or server shutdown
begins, the handle is terminal: success or failure sets `is_closed()`, rejects
later work, and stores one exact close result for concurrent and repeated
callers. Final `Drop` requests cleanup without joining the owner thread.

Every reply channel turns sender disappearance into `EngineStopped`; an owner
panic therefore cannot strand callers. Runtime panics stop the owner and reject
pending work. Raw-stream callback panics are contained before any C boundary,
returned as SDK errors, and adapters drain to `ReadyForQuery`. Callbacks are
synchronous owner-thread code, so reentrant work on the same handle is rejected
rather than deadlocking.

## Storage and identity

Public storage is either a caller-owned directory or an SDK-owned temporary
directory. A persistent directory contains an outer `.oliphaunt.json`
descriptor and `pgdata/`.

Root validation is shared in contract, not by pretending all host filesystems
are one implementation. The native adapter rejects symlink roots and symlink
structural directories, validates PostgreSQL 18 PGDATA, and writes the exact
five-field descriptor last. A sibling admission lock prevents multiple
supported native owners from opening the same root. The lock is an internal
lifecycle implementation detail, not a public cross-binding coordination mode.

The descriptor records schema, engine family, PGDATA directory name,
PostgreSQL major, and physical format. A valid native or WASIX family/format
pair is accepted. Cross-family rejection and conversion are not part of root
admission.

Direct and broker backup bytes carry a PostgreSQL physical initialization
payload. They do not carry the outer descriptor. Restore stages and validates
PGDATA, then creates the receiving root identity. Existing nonempty destinations
are rejected; there is no replacement option.

## Artifacts and extensions

Build and release tooling stages the runtime, PostgreSQL tools, templates, and
selected extension artifacts. The SDK selects extensions by exact generated SQL
name and passes only runtime-relevant selection into root preparation.

Runtime materialization maintains two internal layouts where PostgreSQL requires
them: embedded modules for direct/broker and standalone server modules. This is
natural implementation separation, not a public capability profile.

Performance profiles and diagnostic knobs belong to the perf harness. They must
not leak into the SDK unless a concrete application need establishes a stable
public contract.
