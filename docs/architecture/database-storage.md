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
| IndexedDB / OPFS | Until the origin removes it | Application/origin | Never |

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
| Rust WASIX | `DatabaseStorage::Memory` | `DatabaseStorage::Directory(path)` |
| TypeScript WASIX | omitted `storage` | `indexedDB(name)` or `opfs(name)` in browsers; `directory(path)` on Node, Bun, and Deno |

The React Native `applicationData` case is intentional. JavaScript has no
portable API for constructing an iOS/Android app-sandbox path, so the native
adapter resolves one portable name. Swift and Kotlin callers already have URL
and File APIs and do not need a second path abstraction. Rust WASIX callers
likewise resolve temporary or application-data paths with their preferred host
crate and pass the result through `Directory(path)`.

TypeScript WASIX does not expose a browser `temporaryDirectory` case: omitted
storage already gives the cheapest anonymous lifetime without host I/O. Its
hosts use the same memory default and selectively expose delta-backed browser
or raw-directory providers. Those providers hydrate Wasmer memory and publish
journaled changes at PostgreSQL-safe boundaries; they are not described as
direct guest mounts. Portable `@oliphaunt/wasix-ts` and native
`@oliphaunt/ts` remain separate products.

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

## WASIX persistence contract

`@oliphaunt/wasix-ts` follows the useful parts of PGlite's filesystem model:
memory is the zero-configuration default, and host persistence is an explicit,
selectively imported filesystem adapter. A source-pinned Wasmer mutation
journal lets the adapters publish only changed PGDATA paths. Ordinary protocol
operations publish after `ReadyForQuery`; callback transactions defer their
internal publications and publish exactly once after confirmed `COMMIT` or
`ROLLBACK`. Explicit `checkpoint()` runs PostgreSQL `CHECKPOINT` and then one
provider boundary.

Each logical IndexedDB name owns an independent physical IndexedDB database.
Compatibility metadata and path rows change in one atomic read-write
transaction using the browser's default durability policy, so an aborted
publication leaves the prior generation current. OPFS, Node, Bun, and Deno
expose raw PGDATA layouts and apply WAL before ordinary files,
`global/pg_control` last, and removals after upserts.

Consequences are part of the public contract:

- one open database owns a persistent identity at a time, enforced with Web
  Locks in browsers or an exact local owner lease for host directories;
- distinct IndexedDB names use distinct physical databases and never share
  their metadata/path object-store transaction;
- a PostgreSQL statement error recovers through `ReadyForQuery` and does not
  poison storage;
- an IndexedDB load, compatibility, ownership, or publication failure is a
  distinct storage error;
- a failed IndexedDB transaction leaves the last complete generation current and poisons the
  live handle, because newer commits may exist only in memory; and
- a successful operation or callback transaction does not settle before its
  persistence boundary; abrupt termination may lose only work whose boundary
  had not completed;
- one fixed atomic Node lock slot owns a local-filesystem directory; its
  published child is the complete unique lease identity, concurrent or
  cross-process opens on one host fail `busy`, proven-dead local owners and
  leases from an earlier boot of the same Linux host are reaped by exact-owner
  removal, foreign identities fail closed, and a main-thread parent performs
  token-scoped cleanup after a database worker exit; non-Linux recovery uses
  local PID liveness, while network and cross-host shared filesystems are
  unsupported; and
- Node rejects symlinked or foreign adapter state and never treats unrelated
  files in the application directory as generations.

OPFS is deliberately an asynchronous delta provider rather than a claimed
synchronous guest mount. Its cross-file failure durability is `unknown`, while
IndexedDB can report `not-persisted` when its atomic transaction aborts.

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
