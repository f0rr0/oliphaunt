# Native runtime contract

The native product family shares PostgreSQL 18 through `liboliphaunt`. Rust and
desktop TypeScript offer direct, broker, and server modes. Swift, Kotlin, and
React Native currently offer direct mode through their platform bindings.

## Modes

| Mode | Process and sessions | Intended use |
| --- | --- | --- |
| Direct | One process-resident embedded backend and one serialized physical session | Lowest-overhead embedded access |
| Broker | The same embedded boundary in an SDK-owned helper, one serialized session per instance | Process isolation and multiple application-owned instances |
| Server | Packaged PostgreSQL process with independent client sessions and a connection string | Pools, ORMs, `psql`, `pg_dump`, and ordinary PostgreSQL clients |

SDK handles may be cloned, but direct and broker clones share one executor and
one physical session. Transactions pin that session so unrelated work cannot
interleave. Server connections follow normal PostgreSQL session semantics.

## Storage and initialization

Native storage is either an SDK-owned temporary directory or an explicit
application-owned managed root. Native does not advertise a memory filesystem.
An explicit path names `<root>`, which contains `.oliphaunt.json` and `pgdata`.

SDKs prepare new roots from the packaged cluster seed and publish the exact
native descriptor last. The low-level C runtime only validates complete roots;
it does not run `initdb`, adopt raw PGDATA, or create descriptors on open.
Reopening a nonempty incomplete root fails without mutation.

Closing never removes an application-owned root. SDK-owned temporary roots live
for the physical runtime lifetime; direct logical detach does not imply that
the resident backend has stopped. Session/root ownership is released only when
teardown succeeds. After a teardown failure, the native Rust SDK intentionally
retains the failed owner until process exit so no destructor repeats an
unconfirmed destructive operation.

## Shared application API

Every native embedded-database SDK exposes its idiomatic form of:

- open and close;
- query and command execution with typed values;
- callback transactions without a raw-protocol bypass;
- raw PostgreSQL protocol access on the database/root handle where the
  language boundary can carry bytes;
- cancellation where the platform has an out-of-band recovery contract;
- exact extension artifact selection before open; and
- one physical backup and static restore where the runtime mode supports it.

PostgreSQL `CHECKPOINT` remains available through ordinary
`execute("CHECKPOINT")`; it is not a separate public SDK method. Native Rust's
root `Oliphaunt` calls block the caller without an SDK owner-queue hop; direct
PostgreSQL still runs on liboliphaunt's internal backend pthread. Root
`AsyncOliphaunt` retains the selected direct or broker topology on a permanent
owner thread and exposes futures. Dedicated `OliphauntServerBuilder` and
`AsyncOliphauntServerBuilder` values start server products; their returned
handles expose only the connection string, closed state, and close. Swift and Kotlin use
dedicated serial owners. Native TypeScript keeps Promise-facing direct calls
behind its native async-work boundary; broker calls cross a process boundary,
while server SQL belongs to external PostgreSQL clients rather than the server
lifecycle facade.

Direct and broker support physical backup. Native server SDK backup is not
currently exposed; server applications use normal PostgreSQL tooling. Static
restore accepts a new or existing-empty destination and never replaces
nonempty data.

There is no public capability object, format selector, durability profile,
runtime-footprint profile, initialization mode, background-preparation mode, or
restore-replacement policy. Fixed facts belong in documentation and types;
PostgreSQL startup tuning uses validated `name=value` GUCs.

## Startup and identity

`username`, `database`, and validated PostgreSQL startup GUCs are chosen before
open. Later GUC entries win, matching PostgreSQL command-line behavior. The SDK
adds only mode-required settings. It does not translate a profile enum into a
hidden bundle of tuning values.

## Extensions and tools

Extensions are exact artifact selections. SDK packaging resolves the selected
runtime modules, dependencies, and required pre-start preload/GUC settings; it
never runs database-local `CREATE EXTENSION`, `ALTER EXTENSION`, `LOAD`, schema
setup, or post-create SQL. Applications and ORM migrations own that standard
PostgreSQL SQL. Mobile direct builds use
the static extension registry, while desktop direct/broker and server layouts
use packaged modules appropriate to their runtime.

Desktop tool packages expose normal PostgreSQL tools separately from the SDK
library. They are not dependencies or locator APIs of desktop TypeScript. Tool
availability is package/target documentation, not a runtime capability query.

## Errors and lifecycle

PostgreSQL errors preserve SQLSTATE and available `ErrorResponse` fields.
Transport, storage, lifecycle, unsupported-mode, and package-resolution errors
remain distinct. Native Rust exposes the stable categories through opaque
`Error` plus non-exhaustive `ErrorKind`; the other SDKs use their native error
taxonomy. Cancellation must recover the connection through PostgreSQL's normal
readiness boundary before reuse.

Direct close is generation guarded so stale async cleanup cannot terminate a
newer logical reopen. Broker and server owners supervise their child processes
and surface process exit as a runtime error rather than silently selecting
another mode.

## Qualification

```sh
moon run oliphaunt-rust:check
moon run oliphaunt-typescript:check
moon run oliphaunt-swift:check
moon run oliphaunt-kotlin:check
moon run oliphaunt-react-native:check
moon run liboliphaunt-native:host-smoke
```

The SDK parity policy is authoritative for deliberate runtime-family gaps and
the repository-enforced deferred-feature identifiers.
