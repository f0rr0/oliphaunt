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

Where a selector accepts a filesystem path, `Directory` always names a managed
Oliphaunt root, not PGDATA itself. The root contains `.oliphaunt.json` and a
`pgdata` child. Ownership locks are host-side state, not part of the managed
root or its backup. Raw PGDATA is an internal engine detail and is not a public
interchange format.

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
| WASIX TypeScript | omitted `storage` | `indexedDB(name)` or `opfs(name)` in browsers; `directory(path)` on Node, Bun, and Deno |

The React Native `applicationData` case is intentional. JavaScript has no
portable API for constructing an iOS/Android app-sandbox path, so the native
adapter resolves one portable name. Swift and Kotlin callers already have URL
and File APIs and do not need a second path abstraction. Rust WASIX callers
likewise resolve temporary or application-data paths with their preferred host
crate and pass the result through `Directory(path)`.

WASIX TypeScript does not expose a browser `temporaryDirectory` case: omitted
storage already gives the cheapest anonymous lifetime without host I/O. Its
hosts use the same memory default and selectively expose delta-backed browser
or managed-directory providers. Those providers hydrate Wasmer memory and publish
journaled changes at PostgreSQL-safe boundaries; they are not described as
direct guest mounts. Portable `@oliphaunt/wasix-ts` and native
`@oliphaunt/ts` remain separate products.

## Initialization and restore

Opening a new or empty store initializes it with the product's packaged
template. Reopening a non-empty persistent store never silently reinitializes
it. Restore is a separate static operation into a new or empty destination.
Tooling that needs `initdb` invokes the packaged tool directly; ordinary SDKs do
not expose an initialization-mode abstraction.

An incomplete non-empty persistent cluster fails closed and remains untouched.
Only SDK-owned memory and temporary allocations may discard interrupted setup
state during their own construction.

Restore uses `destination`, not `root`. A restore destination is an external
filesystem location receiving backup bytes; it is not an open database's
storage selector. The current API accepts only a new or empty destination.

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
publication leaves the prior generation current. OPFS applies WAL before
ordinary files, `global/pg_control` last, and removals after upserts inside its
provider-private directory. Node, Bun, and Deno apply the same order below the
managed root's `pgdata` child.

Consequences are part of the public contract:

- one open database owns a persistent identity at a time, enforced with Web
  Locks in browsers or a binding-local stable sibling owner outside the managed
  root for Rust and TypeScript host directories;
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
- each binding prevents concurrent opens through its native host mechanism;
  these locks do not coordinate across Rust and TypeScript, and cross-binding
  use is not a supported or qualified workflow; and
- host-directory providers reject symlinked or foreign adapter state and never treat unrelated
  files in the application directory as generations.

OPFS is deliberately an asynchronous delta provider rather than a claimed
synchronous guest mount. Its cross-file failure `commitState` is `unknown`,
while IndexedDB can report `not-persisted` when its atomic transaction aborts.

## Physical compatibility domains

Managed roots make engine ownership explicit; they do not make every PostgreSQL
build physically interchangeable. Native roots are shared among compatible
native SDKs. Rust and WASIX TypeScript use the same root descriptor and WASIX
physical-format value, but cross-binding root handoff is not a supported or
qualified workflow. The managed-root descriptor is
written once when the root is created. Source fingerprints remain asset-graph coherence identities
used to reject mixed runtime, template, AOT, and extension build outputs; they
are not a physical-reopen key or binding identity in the root. Both runtime
families validate either exact descriptor shape. Opening another family's root
is not a supported transfer path, so the SDKs add no cross-family rejection
policy; the underlying PostgreSQL/runtime behavior is authoritative.

`.oliphaunt.json` is SDK-owned creation-time identity, not user configuration,
a lock, or a copy of runtime provenance. Its five fields name the schema,
engine family, `pgdata` location, PostgreSQL major, and versioned physical
format. Directory-backed native and WASIX SDKs use that file directly;
IndexedDB and OPFS persist the same physical key inside their provider-private
metadata because they do not expose a filesystem root.

Root descriptors are destination-owned and never travel inside physical
backups. A physical archive carries its own family and physical-format metadata;
restore validates the archive and creates the destination descriptor during
staging. Logical SQL dump/restore is the portable bridge between native and
WASIX products.

Reopening a persistent extension-bearing root requires the binding to provide
the installed extension code. PostgreSQL's standard `ALTER EXTENSION ... UPDATE`
is the upgrade mechanism; Oliphaunt does not add a generic extension-migration
framework.

## Implementation boundaries

The shared unit is the invariant, not a universal filesystem interface:

| Concern | Shared owner | Language/provider-specific part |
| --- | --- | --- |
| Database-root identity | The neutral fixture defines the `.oliphaunt.json` schema and `pgdata` location; each runtime family owns its physical-format value | Native SDKs publish descriptors last during root preparation; `liboliphaunt` validates them on open and creates one only in private restore staging. `liboliphaunt-wasix` defines the WASIX value consumed by Rust and TypeScript hosts; cross-family opens have no special guard because they are outside the supported contract |
| Native ownership | `liboliphaunt` owns direct, broker-helper, and restore sibling leases and validates descriptors | SDKs resolve paths and hydrate packaged PGDATA; Rust server takes the same sibling lease because it bypasses C |
| WASIX host-directory persistence | PostgreSQL major plus the versioned WASIX physical format define reopen compatibility | Rust accesses host PGDATA directly and uses a binding-local stable sibling owner; TypeScript hydrates Wasmer memory, publishes journaled deltas, and uses its own stable sibling owner |
| Browser persistence | Public lifecycle and error vocabulary | IndexedDB keeps atomic row transactions; OPFS keeps ordered file publication; both use Web Locks |
| Cross-family transfer | Logical SQL dump/restore | Physical backup formats remain family-scoped |

This deliberately leaves implementation details local when sharing them would
hide real semantics or add indirection to a hot path.

## Intentional differences

- Native defaults to an SDK-owned temporary directory; WASIX defaults to a true
  memory filesystem.
- IndexedDB and OPFS are TypeScript browser providers. Rust WASIX does not grow
  browser-shaped APIs that its ecosystem cannot use naturally.
- React Native keeps `applicationData(name)` because JavaScript cannot resolve
  mobile sandbox paths portably; native Swift and Kotlin callers use URL/File.
- Native direct storage and Rust WASIX host storage are direct filesystem I/O.
  WASIX TypeScript providers publish deltas, so publication failure state is a
  real part of that SDK's error API.
- Rust errors retain idiomatic error chains. WASIX TypeScript exposes stable
  storage codes and `commitState` because callers must branch on asynchronous
  publication outcomes.
- Network and cross-host shared filesystems remain unsupported. The ownership
  protocols intentionally fail closed instead of claiming distributed locking.

## References

- [PGlite filesystems](https://pglite.dev/docs/filesystems)
- [Oliphaunt issue #90: in-memory mode](https://github.com/f0rr0/oliphaunt/issues/90)
