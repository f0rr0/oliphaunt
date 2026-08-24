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
the resident backend has stopped.

## Shared application API

Every native language SDK exposes its idiomatic form of:

- open and close;
- query and command execution with typed values;
- callback transactions;
- raw PostgreSQL protocol access where the language boundary can carry bytes;
- checkpoint and cancellation;
- exact extension selection before open; and
- one physical backup and static restore where the runtime mode supports it.

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

Extensions are exact selections. SDK packaging resolves only the artifacts
needed by those selections; the application still runs standard PostgreSQL
`CREATE EXTENSION`, `ALTER EXTENSION`, and related SQL. Mobile direct builds use
the static extension registry, while desktop direct/broker and server layouts
use packaged modules appropriate to their runtime.

Desktop tool packages expose normal PostgreSQL tools separately from the SDK
library. They are not dependencies or locator APIs of desktop TypeScript. Tool
availability is package/target documentation, not a runtime capability query.

## Errors and lifecycle

PostgreSQL errors preserve SQLSTATE and available `ErrorResponse` fields.
Transport, storage, lifecycle, unsupported-mode, and package-resolution errors
remain distinct. Cancellation must recover the connection through PostgreSQL's
normal readiness boundary before reuse.

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
the complete deferred-feature list.
