# Database storage contract

Oliphaunt has two public product families: native SDKs and WASIX SDKs. They do
not share a runtime implementation or a public package identity. They do share
the following vocabulary and lifecycle rules so moving between SDK languages
does not require relearning what storage means.

## Public vocabulary

`storage` answers one question: where PostgreSQL's mutable database files live.
It does not select the runtime, extension artifacts, packaged cluster seed,
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

## Synchronization

Persistent storage selects where files live, not whether every commit is forced
to disk. Embedded Native and WASIX default PostgreSQL's `fsync` to `off`.
Caller startup settings take precedence over saved PostgreSQL configuration,
which takes precedence over this default. No SDK durability flag or environment
variable duplicates that control. Full native servers and the separate WASIX
Postmaster retain PostgreSQL's `fsync=on` default.

For disk synchronization, use the existing startup GUC (`fsync: 'on'` in
TypeScript or `.startup_guc("fsync", "on")` in Rust). With it off, a machine or
OS crash can lose committed data or corrupt the cluster. Turning it on later
does not retroactively make earlier unsynchronized writes safe; follow
PostgreSQL's procedure when changing a running database's durability policy.
WASIX host directories distinguish ordinary write flushing from explicit
`fdatasync` (data) and `fsync` (data and metadata); errors from explicit requests
are not suppressed by the default. Initial installation and physical restore
keep their checked publication barriers, independently of query settings.
Host directory barriers are checked on Unix; Windows helpers flush regular
files but do not implement a POSIX directory-sync barrier.

Browser providers still complete their existing publication/flush boundary
before returning. IndexedDB's transaction guarantees and OPFS's per-file flushes
are different contracts; `fsync=on` alone does not make either a POSIX disk.
Memory storage has no durable medium to synchronize.

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
| WASIX TypeScript | omitted `storage` | `indexedDB(name)` or `opfs(name)` in browsers; `directory(path)` on Node, Bun, Deno, and Electron |

The React Native `applicationData` case is intentional. JavaScript has no
portable API for constructing an iOS/Android app-sandbox path, so the native
adapter resolves one portable name. Swift and Kotlin callers already have URL
and File APIs and do not need a second path abstraction. Rust WASIX callers
likewise resolve temporary or application-data paths with their preferred host
crate and pass the result through `Directory(path)`.

WASIX TypeScript does not expose a browser `temporaryDirectory` case: omitted
storage already gives the cheapest anonymous lifetime without host I/O. Its
hosts use the same memory default and selectively expose browser or
managed-directory providers. IndexedDB and portable OPFS hydrate Wasmer memory
and publish journaled changes. Worker OPFS uses direct range I/O and a
synchronous recovery journal for names and staged overflow files. On Node, Bun, Deno, and Electron,
managed directories delegate directly to the Rust WASIX runtime and its host
filesystem implementation. Portable `@oliphaunt/wasix-ts` and native
`@oliphaunt/ts` remain separate products.

## Initialization and restore

Every ordinary package-managed new or empty embedded store uses its runtime
product's packaged cluster seed. Native targets and WASIX use separately
qualified physical compatibility identities, and ICU selection resolves ICU
data with the matching `icu` seed. Explicit locally built native runtimes and
new native server roots use the internal `initdb` path with the fixed
`postgres` bootstrap role. Public usernames always select existing connection
roles. The decisions and recurring release gates are recorded in
[Cluster seeds and ICU](cluster-seeds-and-icu.md).

Reopening a non-empty persistent store never silently reinitializes it. Restore
is a separate static operation into a new or empty destination. Tooling that
needs `initdb` invokes the packaged tool directly; ordinary SDKs do not expose
an initialization-mode abstraction.

A published non-empty persistent cluster is never silently reinitialized. A
provider may discard and rebuild only its explicitly unpublished first-open
staging generation; it cannot be mistaken for an existing database.

Restore uses `destination`, not `root`. A restore destination is an external
filesystem location receiving backup bytes; it is not an open database's
storage selector. The current API accepts only a new or empty destination.
If native restore fails its final durability check after publication, it retains
the populated destination and reports that outcome. Do not blindly retry or
delete that destination: an error does not always mean nothing was published.

## WASIX persistence contract

`@oliphaunt/wasix-ts` follows the useful parts of PGlite's filesystem model:
memory is the zero-configuration default, and host persistence is an explicit,
selectively imported filesystem adapter. A source-pinned Wasmer mutation
journal lets adapters publish only changed PGDATA paths. Ordinary protocol
operations complete their provider boundary after `ReadyForQuery`; callback
transactions do so once after confirmed `COMMIT` or `ROLLBACK`. Initialization
publishes only after its full provider boundary succeeds. Applications that need
a PostgreSQL checkpoint call `execute("CHECKPOINT")`; that statement completes
the same ordinary provider boundary as another successful operation.
PostgreSQL's `fsync` setting controls guest file-sync barriers. Browser providers
retain their own durability contract rather than native filesystem guarantees.

Each logical IndexedDB name owns an independent physical IndexedDB database.
Compatibility metadata and path rows change in one atomic read-write transaction
using the browser's default durability policy, so an aborted publication leaves
the prior generation current. OPFS stores an opaque logical namespace over flat
backing files. Direct workers journal namespace changes and staged overflow
contents before dependent published-file mutations or successful guest flushes.
Written WAL precedes publication of ordinary overflow contents. The portable
provider uses copy-on-write backings, writes changed WAL before ordinary files
and `global/pg_control`, and atomically replaces namespace state last. A
persistence failure poisons the live handle; direct storage relies on PostgreSQL
WAL recovery rather than byte-identical rollback of every database file. Node, Bun, and Deno
apply PostgreSQL-safe publication ordering below the managed root's `pgdata` child.

Consequences are part of the public contract:

- one open database owns a persistent identity at a time, enforced with Web
  Locks in browsers or the shared Rust WASIX stable sibling advisory lock for
  Rust and native-host TypeScript directories;
- distinct IndexedDB names use distinct physical databases and never share
  their metadata/path object-store transaction;
- a PostgreSQL statement error recovers through `ReadyForQuery` and does not
  poison storage;
- an IndexedDB load, compatibility, ownership, or publication failure is a
  distinct storage error;
- a failed IndexedDB transaction leaves the last complete generation current and poisons the
  live handle, because newer commits may exist only in memory; and
- a successful operation or callback transaction does not settle before its
  provider boundary;
- the shared WASIX host lock coordinates Rust and native-host TypeScript
  owners, although sequential cross-binding handoff is not yet a supported or
  qualified workflow; and
- host-directory providers reject symlinked or foreign adapter state and never treat unrelated
  files in the application directory as generations.

OPFS selects direct access only during worker acquisition; unavailable primitives
retain the portable provider. It never switches providers during a query. Both
providers and restore share state validation and recovery. Direct acquisition
upgrades the private pool metadata to v2 at the same location; older SDKs reject
it. PostgreSQL physical compatibility is unchanged. OPFS cannot make a cross-file
atomic commit claim, so publication failures report `commitState: 'unknown'`.
IndexedDB can report `not-persisted` when its atomic transaction aborts.

### OPFS decisions retained from earlier work

[#144](https://github.com/f0rr0/oliphaunt/pull/144) introduced same-worker range I/O
to avoid a storage-worker mailbox and full-PGDATA copies.
[#272](https://github.com/f0rr0/oliphaunt/pull/272) avoided full namespace publication
when temporary create/delete cycles leave the final mapping unchanged. Both
remain design requirements.

[#203 item 05](https://github.com/f0rr0/oliphaunt/issues/203) demonstrated the missing
intermediate namespace barrier for preopened and overflow WAL files. The repair
requires both names and overflow bytes, not a larger reserve or end-of-query
flush sorting. Checksummed committed positions protect interrupted journal
appends; checkpoints publish a new journal reference before retiring the old
one. A fully redundant log may be reset only when the owning snapshot already
describes the complete current namespace and contains no live overflow files.
Staged files are materialized before the new snapshot becomes authoritative.
Overflow records store changed ranges and size/truncation changes, avoiding
whole-file journal copies for preallocated WAL segments. The journal tracks the virtual filesystem namespace; PostgreSQL WAL remains the
transaction recovery mechanism. Process termination tests do not establish OS
power-loss durability.

## Physical compatibility domains

Managed roots make engine ownership explicit; they do not make every PostgreSQL
build physically interchangeable. Native roots are shared among compatible
native SDKs. Rust and WASIX TypeScript use the same root descriptor and WASIX
physical-format value, but cross-binding root handoff is not a supported or
qualified workflow. The managed-root descriptor is
written once when the root is created. WASIX source fingerprints remain
asset-graph coherence identities used to reject mixed runtime, cluster-seed,
AOT, and extension build outputs; they
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
| Native ownership | C-backed direct and restore paths plus native Rust direct, broker, and server paths coordinate through one sibling-lock identity; `liboliphaunt` validates direct descriptors | C-backed SDKs let `liboliphaunt` own the lease; native Rust retains the byte-identical lease and hands direct/broker ownership into C explicitly, while its server keeps the lease because it bypasses C |
| WASIX host-directory persistence | PostgreSQL major plus the versioned WASIX physical format define reopen compatibility | Rust accesses host PGDATA directly and owns one stable sibling advisory lock; native-host TypeScript delegates to that same implementation and lock, while browser providers retain their Wasmer-specific persistence paths |
| Browser persistence | Public lifecycle and error vocabulary | IndexedDB keeps atomic row transactions; OPFS uses one opaque pool for direct worker I/O and portable publication; both use Web Locks |
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
  WASIX TypeScript has direct OPFS and asynchronous persistent providers, so
  publication failure state is a real part of that SDK's error API.
- Rust errors retain idiomatic error chains. WASIX TypeScript exposes stable
  storage codes and `commitState` because callers must branch on asynchronous
  publication outcomes.
- Network and cross-host shared filesystems remain unsupported. The ownership
  protocols intentionally fail closed instead of claiming distributed locking.

## References

- [PGlite filesystems](https://pglite.dev/docs/filesystems)
- [Oliphaunt issue #90: in-memory mode](https://github.com/f0rr0/oliphaunt/issues/90)
