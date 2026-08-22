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
| Listening server | Rust and desktop TypeScript | yes | no |
| PostgreSQL tools | separate desktop products; desktop TypeScript has no SDK tools API or dependency | `tools` feature: `pg_dump` and `psql` | no |
| Cancellation | native C and language SDKs | no public direct cancellation contract | no |
| Protocol/COPY response streaming | callback streaming in every native SDK, backed by the native C callback ABI | buffered raw protocol | buffered raw protocol |

These are language-native deltas, not parity failures:

- Rust uses builders, enums, futures, and owned byte buffers.
- Swift uses actors, `URL`, and `Data`.
- Kotlin uses coroutines, sealed storage types, and `ByteArray`.
- React Native delegates runtime behavior to Swift or Kotlin and owns the
  TypeScript/TurboModule boundary.
- TypeScript uses promises, opaque storage values, `Uint8Array`, selective
  package subpaths, and `Symbol.asyncDispose` where appropriate.
- Rust WASIX exposes its local server and optional tools because a Rust host can
  provide sockets and tool execution. The browser-capable TypeScript package
  does not pretend those host facilities are universal.
- Native Rust server mode owns an SDK pgwire client, so its database handle
  retains the ordinary session helpers. Rust WASIX dedicates its one embedded
  backend to the listener; its server handle therefore owns only the endpoint
  and lifecycle, and applications use an ordinary PostgreSQL client for SQL.

## Storage and physical data

`storage` means where mutable PostgreSQL files live. It does not choose a
runtime, archive format, capability profile, initialization mode, or extension
set.

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
| `FUTURE-WASIX-TS-SERVER-TOOLS` | WASIX TypeScript exposes neither a listener nor `pg_dump`/`psql` | Concrete Node/Bun/Deno demand for an optional host-only package using shared `liboliphaunt-wasix` artifacts and an isolated backend/session; browser support remains unpromised |
| `FUTURE-WASIX-CANCELLATION` | WASIX app-facing bindings have no public direct-query cancellation API | A guest interrupt contract that preserves PostgreSQL recovery plus idiomatic Rust and JS cancellation tests |
| `FUTURE-WASIX-DIRECT-COPY` | WASIX typed APIs buffer responses; no dedicated COPY stream/backpressure API is promised | A guest protocol pump and language-native stream tests for COPY IN and COPY OUT |
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
