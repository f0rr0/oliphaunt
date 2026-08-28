# Rust SDK architecture

The Rust SDK is a native binding over `liboliphaunt`. It does not wrap the
WASIX binding and has no runtime fallback matrix.

## Public boundary

The public database boundary is:

- Root `Oliphaunt::open()` or `Oliphaunt::builder()` for synchronous,
  exclusive direct and broker databases.
- Root `AsyncOliphaunt::open()` or `AsyncOliphaunt::builder()` for the same
  topology vocabulary on a dedicated owner thread with cloneable asynchronous
  handles.
- Dedicated `OliphauntServer::builder().start()` and
  `AsyncOliphauntServer::builder().start().await` terminals for local-server
  lifecycle handles.
- PostgreSQL-shaped execute, query, parameter, result, transaction,
  cancellation, raw protocol, and close methods on database handles.
- Only `connection_string`, `is_closed`, and `close` on server handles; an
  external driver or ORM owns SQL and protocol behavior.
- One byte physical-backup method on direct and broker databases.
- One static restore operation into an absent or empty destination.

Internal engine modes, runtime profiles, lifecycle requests, backup envelopes,
resource manifests, package reports, and protocol parsers are not public API.
Database and server builders are distinct, so listener/server options cannot be
combined with direct/broker options. Within the database builder,
`broker_executable` is valid only after selecting `broker()`.

## Runtime ownership

Direct mode owns one embedded PostgreSQL backend in the application process.
Broker mode owns the same backend in one authenticated helper process. These
are database topologies, not scheduling modes. Root `Oliphaunt` handles block
until either session completes; `AsyncOliphaunt` serializes either session on
one owner thread.

Server mode starts a normal local PostgreSQL server and returns
`OliphauntServer` with a nonoptional libpq connection string. Startup readiness
uses a short-lived probe; the lifecycle handle retains no privileged PostgreSQL
connection. It is the only product that supports independent external client
connections. Its handle has no physical-backup method because PostgreSQL already provides
`pg_basebackup`; the optional endpoint-oriented `oliphaunt-tools` crate runs
plain `pg_dump` and non-interactive `psql` without entering the core SDK API.

The engine traits, C symbols, broker frames, server wire client, and artifact
materialization helpers are crate-internal. The only `#[doc(hidden)]` exports are
narrow cross-crate boundaries consumed by the unpublished broker and packaging
tools.

## Execution and transactions

The root API is synchronous: its operations take `&mut self` and block the
calling thread until the selected runtime reports completion. It does not add
an SDK owner queue. Native direct mode nevertheless runs the embedded backend
on `liboliphaunt`'s internal pthread; broker and server keep their own process
or server boundaries. The contract is therefore caller blocking, not
caller-thread PostgreSQL execution. The handle is `Send + !Sync`, so ownership
may move between threads but references cannot be shared concurrently. A
callback transaction exclusively borrows the database. Inline raw-stream
callbacks may borrow caller state and cannot reenter the database through safe
Rust while its mutable borrow is active.

A broker handle owns exactly one helper-backed PostgreSQL session. Helper exit
or IPC failure is terminal for that handle and retains the first failure; no
runtime path launches a replacement beneath it. Explicit close cleans owned
resources, and a new open on persistent storage is the only recovery boundary.
Requests with unknown outcomes are never replayed.

The `AsyncOliphaunt` API constructs and calls its session on one permanent
SDK-owned thread. A session is never opened on a temporary thread and then
transferred. Cloneable `Send + Sync` handles share that owner; cloning does not
create a PostgreSQL connection. The public name describes its calling contract;
the owner thread is an implementation placement guarantee, not a Rust
`Worker` abstraction.

Asynchronous application work awaits fair, bounded admission before entering
one FIFO. Saturation suspends the admitting future rather than returning a
queue-full error. Transaction control, rollback cleanup, and close enter the
same FIFO without consuming ordinary capacity, so queue pressure cannot strand
lifecycle work and cannot reorder cleanup ahead of an already-admitted COMMIT.
Close and command admission share one lock: work
admitted before the close cutoff remains ahead of Close and drains, while later
application work, including capacity waiters that never entered the FIFO, is
rejected. A rejected pre-cutoff waiter cannot cross a retryable close attempt
after admission reopens. The closing state is never used to invalidate a
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

A root transaction callback panic is contained until synchronous settlement
completes and is then resumed when the outcome is known. An async transaction
body panic unwinds the awaiting task immediately. Dropping its active
transaction enqueues best-effort rollback in the same owner FIFO, so later work
cannot overtake cleanup even though the unwind does not wait for it.

Cancellation is out of band: the C cancellation hook in direct mode and a
separate authenticated endpoint in broker mode. External clients of server
mode own PostgreSQL CancelRequest through their driver. Root database callers
obtain a separate `CancelHandle` before blocking when
another thread must interrupt the operation. Asynchronous cancellation is
asynchronous and does not wait in the ordinary FIFO. Close does not implicitly
cancel active work. Root close is synchronous; async close is an ordered queue
boundary with shared concurrent waiters. Once direct detach, broker shutdown,
or server shutdown begins, either handle is terminal and retains one exact
close result. A failed teardown is never followed by a second implicit teardown.
Session and managed-root ownership is released only after successful teardown.
On failure the SDK intentionally retains that ownership until process exit;
leaking the failed owner is safer than running an unproven second destructor.
Final asynchronous-handle `Drop` requests cleanup without joining the owner
thread.

Every asynchronous reply channel turns sender disappearance into
`EngineStopped`; an owner panic therefore cannot strand callers. Runtime panics
stop the owner and reject pending work. Raw-stream callback panics are contained
before any C boundary. A typed adapter outcome distinguishes confirmed
`ReadyForQuery` recovery from an independent runtime or transport failure. The
blocking root resumes the original panic only after confirmed recovery; the
async API returns a recovered owner-thread panic as
`RawStreamError::CallbackPanicked` and leaves the session reusable. An
unconfirmed recovery failure is authoritative, becomes
`RawStreamError::Database`, and poisons the session until close. Callbacks are
synchronous owner-thread code, so reentrant work on the same async handle is
rejected rather than deadlocking. Root callbacks run inline and rely on the
exclusive borrow instead of runtime reentrancy detection.

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
