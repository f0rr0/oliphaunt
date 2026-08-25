# SDK parity policy

Oliphaunt has two runtime families, seven public SDKs, and one lower-level C
binding surface:

- native SDKs: Rust, Swift, Kotlin, React Native, and desktop TypeScript;
- WASIX: Rust and TypeScript, both consuming `liboliphaunt-wasix` carriers.
- native C ABI: the common low-level boundary beneath the native SDK family.

Parity means the same product concepts and decided behavior where the runtime
can support them. It does not mean identical signatures, configuration records,
or host implementations. Each SDK uses its language's normal errors, async
model, byte buffers, paths, and resource-lifetime conventions.

## Stable semantic core

Every app-facing SDK exposes the concepts below unless the table records a
deliberate runtime-specific limit. The C ABI is the lower-level native binding
boundary: it supplies handles, protocol bytes, backup/restore, cancellation,
and lifecycle; typed queries and callback transactions belong in language SDKs.

| Concept | Native SDK family | Rust WASIX | WASIX TypeScript |
| --- | --- | --- | --- |
| Open and close | yes | yes | yes; `AsyncDisposable` also closes |
| Default storage | SDK-owned temporary directory | true WASIX memory filesystem | true WASIX memory filesystem |
| Persistent storage | managed filesystem root | managed filesystem root | IndexedDB or OPFS in browsers; managed filesystem root on Node, Bun, and Deno |
| Query and command helpers | yes | yes | yes |
| Raw PostgreSQL protocol | yes | yes | yes, owned byte response |
| Callback transaction | yes | yes | yes |
| Checkpoint | PostgreSQL `CHECKPOINT` | PostgreSQL `CHECKPOINT` / storage sync | PostgreSQL `CHECKPOINT` followed by provider publication |
| Exact extension selection | yes | yes | yes |
| Physical backup | direct and broker; mobile direct | yes | yes |
| Physical restore | new or empty destination | static restore into a new or empty directory | static restore into new or empty persistent storage |
| Listening server | Rust and desktop TypeScript | yes | Node, Bun, and Deno through explicit server subpaths; no browser socket API |
| PostgreSQL tools | optional endpoint-oriented Rust and desktop TypeScript products; no core SDK dependency | `tools` feature: open-database `pg_dump` and non-interactive `psql` | optional `@oliphaunt/wasix-tools`: `pgDump` in direct or worker placement; non-interactive `psql` in worker placement |
| Cancellation | native C and language SDKs | no public direct cancellation contract | no |
| Protocol/COPY response streaming | callback raw-protocol streaming in every native SDK, backed by the native C callback ABI | callback raw-protocol streaming; COPY uses the guest stream pump | buffered and callback raw-protocol streaming with bounded backpressure |

These are language-native deltas, not parity failures:

- Rust uses builders, enums, futures, and owned byte buffers.
- Swift uses actors, `URL`, and `Data`.
- Kotlin uses coroutines, sealed storage types, and `ByteArray`.
- React Native delegates runtime behavior to Swift or Kotlin and owns the
  TypeScript/TurboModule boundary.
- TypeScript uses promises, opaque storage values, `Uint8Array`, selective
  package subpaths, and `Symbol.asyncDispose` where appropriate.
- Rust WASIX and WASIX TypeScript expose the same lightweight single-backend
  endpoint where the host has local sockets. TypeScript keeps the server absent
  in browsers and exports it only from the Node, Bun, and Deno server subpaths.
- WASIX tools run against an open embedded database in both bindings. Their
  optional carriers stay outside the core SDK packages. TypeScript `pgDump`
  supports direct and worker database placement; TypeScript `psql` requires
  worker placement and uses a bounded internal pgwire bridge between workers.
  Neither needs a browser socket.
- Native tools are endpoint-oriented optional products. `oliphaunt-tools` and
  `@oliphaunt/tools` accept a PostgreSQL connection string and do not become
  dependencies or methods of the embedded database SDKs.
- Native Rust server mode owns an SDK pgwire client, so its database handle
  retains the ordinary session helpers. Rust WASIX dedicates its one embedded
  backend to the listener; its server handle therefore owns only the endpoint
  and lifecycle, and applications use an ordinary PostgreSQL client for SQL.

## Storage and physical data

`storage` means where mutable PostgreSQL files live. It does not choose a
runtime, archive format, capability profile, initialization mode, or extension
set.

Cluster initialization and ICU are separate product concepts. The locked
convergence target is that ordinary new roots transparently use a runtime-bound
cluster seed, while language-native package/build selection enables optional
ICU runtime data. A new ICU-enabled root must use the matching `icu` seed
so its per-database collation catalog matches normal ICU-aware `initdb`.
Existing roots are never replaced or silently catalog-migrated. The complete
decision register and cross-SDK qualification matrix are in
[Cluster seeds and ICU](../architecture/cluster-seeds-and-icu.md).

Every SDK bootstraps the fixed PostgreSQL `postgres` role. Public `username`
configuration selects an existing connection role; it never changes initdb or
creates a superuser. A first open with another username fails before seed
loading or PGDATA mutation/publication. Native server roots are the deliberate
initialization exception to
seed hydration: they run normal server `initdb` so independent replication/WAL
systems receive independent PostgreSQL system identifiers.

Filesystem-backed SDK storage is a managed root with exactly one
`.oliphaunt.json` object and one `pgdata` child. The descriptor has exactly five
fields: `schema`, `engineFamily`, `pgdata`, `postgresMajor`, and
`physicalFormat`. JSON key order and ordinary whitespace are irrelevant;
missing, duplicate, unknown, wrongly typed, or incompatible fields are rejected.
Native and WASIX descriptors are both structurally accepted. There is no
special cross-family rejection because cross-family direct opening is not a
documented transfer path.

The descriptor is destination identity. It is not configuration, provenance,
a lock, or backup content. Descriptorless nonempty roots are rejected without
mutation; only a known-new or empty destination may receive a descriptor.

Native and WASIX each have one PostgreSQL 18 physical archive. The exact
five-key `.oliphaunt/backup-manifest.properties` inside the tar identifies the
archive; the destination creates `.oliphaunt.json` after validation. There is
no public format enum or negotiation API. Native archives are compatible among
native SDKs. Rust and TypeScript implement the same WASIX archive envelope, but
cross-binding transfer is not a supported or qualified workflow. Native and
WASIX archives are not physically interchangeable; logical SQL is the bridge.

Provider ownership remains binding-specific implementation:

- Swift, Kotlin, React Native, desktop TypeScript direct mode, native Rust
  direct/broker mode, and C restore use the C runtime's stable sibling lease;
- native server modes rely on PostgreSQL's own live-cluster ownership after
  bounded, atomic root initialization;
- Rust WASIX uses its host-directory owner;
- TypeScript uses Web Locks or a Node/Bun/Deno sibling owner as appropriate.

Each mechanism prevents duplicate ownership within its provider. They do not
coordinate simultaneous direct/broker/server mutation of one root, which is
application error. Locks are provider-local state outside the managed root and
backups. Cross-binding root use is not a supported or qualified workflow.

## Deferred work with decided current behavior

These identifiers are the complete deferred list for this contract. They are
not hidden modes or partly supported capabilities.

| ID | Current behavior | Evidence required before implementation |
| --- | --- | --- |
| `FUTURE-NATIVE-SERVER-SDK-BACKUP` | Native server handles expose no SDK physical-backup method; applications use ordinary PostgreSQL tools such as `pg_basebackup`. Direct and broker physical backup work | Any future method must implement PostgreSQL replication `BASE_BACKUP` with WAL streaming and round-trip tests; it must not archive a live root |
| `FUTURE-SWIFT-MACOS-SERVER-TOOLS` | Swift remains a direct embedded SDK on both iOS and macOS; it exposes no server or frontend-tool product | A separately distributed macOS-only product that carries the native server/tool artifacts, provides the same listener and endpoint lifecycle contract as Rust/TypeScript, and leaves every server/tool symbol absent on iOS; an endpoint-only wrapper or an iOS throwing stub does not qualify |
| `FUTURE-WASIX-CANCELLATION` | WASIX app-facing bindings have no public direct-query cancellation API | A guest interrupt contract that preserves PostgreSQL recovery plus idiomatic Rust and JS cancellation tests |
| `FUTURE-WASIX-DIRECT-COPY` | Both WASIX bindings expose bounded raw response streaming, but neither exposes a dedicated typed COPY reader/writer | A language-native bounded reader/writer API with COPY IN, COPY OUT, early-close, error, and recovery tests; it must reuse protocol framing rather than parse SQL text |
| `FUTURE-RESTORE-REPLACE` | Restore accepts only a nonexistent or empty destination and rejects nonempty data without mutation | An atomic, recoverable replacement contract for directories, IndexedDB, and OPFS, with crash tests and demonstrated app demand |
| `FUTURE-EXTENSION-MIGRATION` | Persistent data must reopen with required extension code; PostgreSQL SQL such as `ALTER EXTENSION` is explicit application work | A real cross-version extension case that cannot be handled honestly with standard PostgreSQL operations |

## Non-goals

- backward compatibility with removed capability, format, profile,
  initialization, background-preparation, or replace-policy APIs;
- identical method names and configuration records across languages;
- runtime auto-selection or fallback between native and WASIX packages;
- automatic adoption of descriptorless PGDATA or legacy archive envelopes;
- physical interchange between native and WASIX builds;
- calling a native temporary directory “memory” before PostgreSQL has a real
  in-memory filesystem implementation;
- configuration variables for behavior that is fixed today.

## Review and release rule

A public SDK change is complete when all affected language surfaces, C/header
copies, generated API inventory, docs route, package shape, and behavioral tests
agree. A deliberate delta must appear above with current behavior; a future idea
must use one of the exact deferred IDs above or be rejected until a concrete
need exists.

The lightweight contract checks are:

```sh
moon run sdk-contracts:check
tools/policy/check-sdk-parity.sh
```

Product-owned compile, package, smoke, and release tasks remain the authority
for executable behavior.
