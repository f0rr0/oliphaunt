# Rust SDK architecture

The Rust SDK is a native binding over `liboliphaunt`. It does not wrap the
WASIX binding and has no runtime fallback matrix.

## Public boundary

The public database boundary is:

- `Oliphaunt::builder()` for direct and broker databases.
- `OliphauntBuilder::open_server()` for the distinct local-server handle.
- PostgreSQL-shaped execute, query, parameter, result, transaction, checkpoint,
  cancellation, raw protocol, and close methods.
- One byte physical-backup method on direct and broker databases.
- One static restore operation into an absent or empty destination.

Internal engine modes, runtime profiles, lifecycle requests, backup envelopes,
resource manifests, package reports, and protocol parsers are not public API.

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

An owner thread is the single place that calls a runtime session. Cloneable SDK
handles share it; cloning does not create a PostgreSQL connection.

A transaction pin rejects unrelated work while its callback is active. Body
failure rolls back. A failed rollback poisons the session. COMMIT uncertainty
never triggers a later ROLLBACK because PostgreSQL may already have committed;
the session is poisoned unless PostgreSQL explicitly returns the known idle
`ROLLBACK` command tag. Pin cleanup remains admissible after poisoning so close
cannot strand the owner thread.

Cancellation is out of band: the C cancellation hook in direct mode, a separate
authenticated endpoint in broker mode, and PostgreSQL CancelRequest in server
mode. Close is a queue boundary and does not implicitly cancel active work.

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
