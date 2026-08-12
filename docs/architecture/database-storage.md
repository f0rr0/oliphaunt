# Database storage contract

Oliphaunt has two public product families: native SDKs and WASIX SDKs. They do
not share a runtime implementation or a public package identity. They do share
the following vocabulary and lifecycle rules so moving between SDK languages
does not require relearning what storage means.

## Public vocabulary

`storage` answers one question: where PostgreSQL's mutable database files live.
It does not select the runtime, extension artifacts, packaged PGDATA template,
or initialization policy.

| Storage | Lifetime | Owner | Default |
| --- | --- | --- | --- |
| Memory | One WASIX database instance | SDK | WASIX |
| Temporary directory | Native process/runtime lifetime | SDK | Native |
| Directory | Until the application removes it | Application | Never |
| Application data | Until the application removes it | Application | Never |
| IndexedDB | Until the origin removes it | Application/origin | Never |

Native SDKs default to an SDK-owned temporary directory because native
PostgreSQL requires a real PGDATA directory. WASIX SDKs default to a true
in-memory virtual filesystem. A native temporary directory is not called
"memory", and WASIX memory is not implemented with a host temporary directory.

This does not claim to implement the native Rust in-memory mode requested by
issue #90. That request requires a native PostgreSQL filesystem abstraction (and
an honest no-OS-resource cloning model), not a renamed temporary directory.
Until the native runtime owns such a filesystem, `DatabaseStorage::Memory`
exists only in the WASIX product family.

Opening persistent storage is always explicit. Closing a database never removes
an application-owned directory, application-data database, or IndexedDB
database. Native direct close may be a logical detach from a process-resident
PostgreSQL backend; its SDK-owned temporary directory must remain until that
backend's physical lifetime ends. It is not durable storage and the operating
system may reclaim it after process exit.

## SDK spellings

Each language keeps its native conventions instead of importing a cross-language
configuration schema.

| SDK | Default | Explicit persistence |
| --- | --- | --- |
| Rust | `DatabaseStorage::TemporaryDirectory` | `DatabaseStorage::Directory(path)` |
| TypeScript | omitted `storage` | `{ kind: 'directory', path }` |
| Swift | `.temporaryDirectory` | `.directory(url)` |
| Kotlin | `DatabaseStorage.TemporaryDirectory` | `DatabaseStorage.Directory(path)` |
| React Native | omitted `storage` | `{ kind: 'directory', path }` or `{ kind: 'applicationData', name }` |
| Rust WASIX | `DatabaseStorage::Memory` | `Directory` or `ApplicationData` |
| TypeScript WASIX | omitted `storage` | selectively imported `indexedDB(name)` |

The React Native `applicationData` case is intentional. JavaScript has no
portable API for constructing an iOS/Android app-sandbox path, so the native
adapter resolves one portable name. Swift and Kotlin callers already have URL
and File APIs and do not need a second path abstraction. Rust WASIX retains the
idiomatic `directories` project identity for host applications.

TypeScript WASIX does not expose a browser `temporaryDirectory` case: omitted
storage already gives the cheapest anonymous lifetime without host I/O. Its
Node worker-thread host uses the same memory default. Node directory persistence
remains absent until the binding owns a truthful host-filesystem provider;
portable `@oliphaunt/wasix` and native `@oliphaunt/ts` remain separate products.

## Initialization and restore

Initialization is orthogonal to storage. A newly empty store can use a packaged
template, run `initdb` where the product supports it, or load a compatible
archive. Reopening a non-empty persistent store does not silently reinitialize
it. Runtime, PostgreSQL, template, and extension identities are validated before
reuse.

An incomplete non-empty persistent cluster fails closed and remains untouched.
Only SDK-owned memory and temporary allocations may discard interrupted setup
state during their own construction.

An SDK exposes an initialization selector only when that product supports more
than one useful consumer policy. Mobile and browser SDKs automatically open an
existing database or use their packaged template for an empty store; asking the
consumer to repeat that policy would add configuration without adding control.
Rust and Rust WASIX expose the selector because their host and tooling
use cases genuinely support multiple initialization sources.

Restore uses `destination`, not `root`. A restore destination is an external
filesystem location receiving a backup artifact; it is not an open database's
storage selector. Replacement must remain explicit.

## Browser IndexedDB contract

`@oliphaunt/wasix` follows the useful parts of PGlite's filesystem model:
memory is the zero-configuration default, and browser persistence is an
explicit, selectively imported filesystem adapter. PGlite's IndexedDB layer
loads files into memory and flushes changed whole files after queries. Oliphaunt
currently publishes one complete PGDATA snapshot atomically on
`checkpoint()` and clean `close()` because Wasmer's browser `Directory` API does
not expose a dirty-file feed.

Consequences are part of the public contract:

- one worker owns an IndexedDB database at a time, enforced with the Web Locks
  API;
- a PostgreSQL statement error recovers through `ReadyForQuery` and does not
  poison storage;
- an IndexedDB load, compatibility, ownership, or snapshot failure is a
  distinct storage error;
- a failed snapshot leaves the last complete generation current and poisons the
  live handle, because newer commits may exist only in memory; and
- browser termination loses changes after the last successful checkpoint or
  clean close. This is not per-query or crash durability.

OPFS is intentionally absent. The current host cannot provide a truthful direct
synchronous mount across supported browsers, and an OPFS-branded copy of the
same snapshot mechanism would misstate its behavior.

## Capabilities

Database-facing capabilities describe instances, never filesystem topology:

- `multipleInstances`
- `sameInstanceLogicalReopen`
- `instanceSwitchable`
- `crashRestartable`

Rust uses the corresponding snake_case fields. Internal lock files, PGDATA
paths, resource roots, archive roots, and C ABI fields retain `root` when it is
the accurate filesystem term.

## References

- [PGlite filesystems](https://pglite.dev/docs/filesystems)
- [Oliphaunt issue #90: in-memory mode](https://github.com/f0rr0/oliphaunt/issues/90)
