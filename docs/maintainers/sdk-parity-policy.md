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

The normative query, row, description, notice, lifecycle, and transaction
semantics are in the
[stable public database API decision](../architecture/stable-database-api.md).
PGlite is migration evidence for the JavaScript shape, not the source of this
cross-language contract.

## Stable semantic core

Every app-facing SDK exposes the database and callback-transaction concepts
below. The spelling and host types are language-native; the behavior is shared.
The C ABI remains the lower-level native binding boundary: it supplies handles,
protocol bytes, backup/restore, cancellation, and lifecycle. OID codecs,
structured results, descriptions, notices, and callback transactions belong in
language SDKs and do not expand that ABI.

| Concept | Stable behavior | Deliberate language shaping |
| --- | --- | --- |
| Open, close, and closed state | `open` waits for readiness; close rejects new work and is idempotent after success; every database exposes read-only closed state | `closed`, `isClosed`, or `is_closed`; no separate `ready`/`waitReady` requirement |
| Encoded parameters | Optional PostgreSQL type OID, text/binary format for non-null bytes, and null; typed null retains its OID and canonicalizes its unobservable format to text; untyped null/text/binary remain | Common values use constructors, conversions, or builders. JavaScript may infer safe encoders through one owned Parse/Describe/Bind cycle and also accepts explicit wrappers and immutable per-query OID encoders |
| Raw row contract | Ordered fields with complete wire metadata and ordered nullable byte cells; duplicate field names remain representable | Rust, Swift, and Kotlin retain this as their ordinary row and add typed access. JavaScript exposes it explicitly as `queryRaw` |
| Typed or decoded rows | Decoding is selected and validated by field OID; typed name lookup rejects duplicates; raw bytes and metadata remain available | Rust uses `FromSql`, Swift `OliphauntPostgresDecodable`, Kotlin `PostgresDecoder<T>`; JavaScript `query` defaults to decoded objects and supports array rows, text mode, and immutable per-query OID decoders |
| `execute` | One extended-query statement that must return no rows; command tag is authoritative and affected-row count is optional | Retained as an Oliphaunt command-only convenience in every language |
| `exec` | Simple-query SQL with zero or more statements and ordered structured command-or-row results; no bind parameters; all structured executing operations reject top-level COPY before buffered dispatch | JavaScript applies its selected row/value mode; native languages use enums, sealed values, or equivalent |
| `describe` | `Parse` + `Describe` + `Sync`, without execution; returns parameter OIDs, optional result fields, and notices | May accept caller parameter OIDs through options, a builder, or an overload; it does not return mutable codec objects |
| Query-scoped notices | Structured PostgreSQL notices stay ordered with the `query`, `queryRaw`, `execute`, `exec`, or `describe` operation that received them | No global parser registry, notice bus, or idle notification pump is implied |
| Callback transaction | Exclusive physical-session ownership; mirrors structured query, execute, exec, and describe; exposes closed state; has no raw-protocol bypass | Explicit rollback is one-shot, expires the handle, skips outer commit, and lets a normally returning callback return its value |
| PostgreSQL errors | Preserve SQLSTATE, available `ErrorResponse` fields, and unknown raw fields; remain distinct from lifecycle, transport, storage, codec, and unsupported-operation errors | Language-native error classes, enums, or exceptions |
| Transaction-status ownership | Structured database operations do not silently leave `ReadyForQuery` in an open or failed transaction for the next borrower; callback operations inspect every exact wire command tag and the one terminal readiness status before high-level parsing | Raw protocol is a database/root-only explicit bypass; managed transactions settle by callback return or rollback, allow savepoint SQL, and make uncertain or escaped ownership close-only without a follow-up SDK control |

The runtime/product capabilities around that common database API are:

| Concept | Native SDK family | Rust WASIX | WASIX TypeScript |
| --- | --- | --- | --- |
| Default storage | SDK-owned temporary directory | true WASIX memory filesystem | true WASIX memory filesystem |
| Persistent storage | managed filesystem root | managed filesystem root | IndexedDB or OPFS in browsers; managed filesystem root on Node, Bun, and Deno |
| Raw PostgreSQL protocol on database/root handles | yes | yes | yes, owned byte response |
| Exact extension artifact selection | yes | yes | yes |
| Physical backup | direct and broker; mobile direct | yes | yes |
| Physical restore | new or empty destination | static restore into a new or empty directory | static restore into new or empty persistent storage |
| Listening server | Rust and desktop TypeScript | yes | Node, Bun, and Deno through explicit server subpaths; no browser socket API |
| PostgreSQL tools | optional endpoint-oriented Rust and desktop TypeScript products; no core SDK dependency | `tools` feature: fluent open-database `pg_dump` and non-interactive `psql` methods on sync or async handles | optional `@oliphaunt/wasix-tools`: `pgDump` with direct or Worker handles; non-interactive `psql` with a Worker handle |
| Cancellation | native C and language SDKs | no public direct cancellation contract | no |
| Protocol/COPY response streaming | canonical `execProtocolRawStream`/`exec_protocol_raw_stream`, backed by `oliphaunt_exec_protocol_raw_stream` | `exec_protocol_raw_stream`; COPY uses the guest stream pump | `execProtocolRawStream` with bounded backpressure |

There is no public checkpoint method. PostgreSQL `CHECKPOINT` is ordinary SQL
and is available through `execute("CHECKPOINT")` or the language-equivalent
call. WASIX storage publication after successful work, including the separate
full-publication boundary for a newly initialized persistent direct-OPFS root,
is runtime-owned and does not become a database method or option.

These are language-native deltas, not parity failures:

- Both Rust products expose the same fluent `Sql` statement builder with typed
  binds and `query`, `execute`, or `describe` terminals. Root `Oliphaunt` types
  are synchronous and exclusive; root `AsyncOliphaunt` types retain the
  cloneable asynchronous contract and use dedicated owner threads. Native Rust
  synchronous calls block their caller without an SDK queue hop, while native
  direct PostgreSQL itself runs on `liboliphaunt`'s internal backend pthread.
  Rust WASIX direct guest work truly executes on the caller thread, and its
  server lifecycle calls remain synchronous while the listener owns its backend
  thread.
- Native blocking `Oliphaunt` is `Send` but not `Sync`; WASIX blocking
  `Oliphaunt` is neither `Send` nor `Sync`. Blocking server handles in both
  products are `Send` but not `Sync`. The cloneable async database and server
  handles are `Send + Sync`; an async transaction is `Send` but not `Sync` and
  its operations require exclusive mutable access. These differences describe
  real owner placement rather than different SQL semantics.
- Both Rust products keep database and server construction separate:
  `OliphauntBuilder` / `AsyncOliphauntBuilder` end in `open`, while dedicated
  `OliphauntServerBuilder` / `AsyncOliphauntServerBuilder` end in `start`.
- Both Rust products root-export an opaque, cloneable `Error` and a
  `#[non_exhaustive] ErrorKind` with `InvalidConfiguration`, `Lifecycle`,
  `TransactionActive`, `Postgres`, and `Other`; `Error::kind()` is the stable
  category boundary. PostgreSQL and composite transaction detail remains
  available through dedicated accessors without exposing runtime-specific
  causes as public enum variants.
- Both Rust products use an opaque root `Extension` with uppercase associated
  constants, `Extension::ALL`, `Extension::by_sql_name`, and `sql_name`.
  Native `ALL` is the packaged PostgreSQL 18 catalog; WASIX exposes only
  Cargo-feature-enabled extensions and gates the type and builder methods on
  its `extensions` feature. Free/module constants and PascalCase aliases are
  not public compatibility surfaces.
- Swift uses actors, `URL`, `Data`, and `OliphauntPostgresDecodable`.
- Kotlin uses coroutines, sealed storage types, `ByteArray`, and
  `PostgresDecoder<T>`.
- React Native delegates runtime behavior to Swift or Kotlin and owns the
  TypeScript/TurboModule boundary. It transfers complete results and performs
  JavaScript row decoding above the bridge.
- TypeScript uses promises, opaque storage values, decoded object or array
  rows, explicit raw rows, immutable per-query OID decoders, `Uint8Array`,
  selective package subpaths, and `Symbol.asyncDispose` where appropriate.
- Rust WASIX and WASIX TypeScript expose the same lightweight single-backend
  endpoint where the host has local sockets. TypeScript keeps the server absent
  in browsers and exports it only from the Node, Bun, and Deno server subpaths.
- WASIX tools run against an open embedded database in both bindings. Their
  optional carriers stay outside the core SDK packages. TypeScript `pgDump`
  supports root-direct and explicit Worker database handles; TypeScript `psql`
  requires a Worker handle and uses a bounded internal pgwire bridge between
  workers.
  Neither needs a browser socket.
- `@oliphaunt/wasix-ts/internal/tools` is a version-locked cross-package bridge
  owned solely by `@oliphaunt/wasix-tools`. Its export-map visibility does not
  make it an app-facing or stable database API. The JavaScript SDKs expose
  codec helpers and result types from their roots and deliberately do not
  publish implementation-heavy `query` or `protocol` subpaths.
- Swift's `OliphauntExtensionSupport` product is a version-locked carrier seam
  owned by generated Swift extension products. Ordinary applications select
  extensions by SQL name through `Oliphaunt`; they should not import this
  support product directly. It may evolve only in lockstep with the carrier
  products that consume it. The public `COliphaunt` product is governed by the
  documented C ABI contract rather than the Swift application API.
- Native Rust's non-default `__internal-broker-helper` feature similarly exposes
  `oliphaunt::__private` only to the exact-version, unpublished
  `oliphaunt-broker` executable. It is absent from normal builds, is inventoried
  separately, and is not part of the stable application contract.
- Native tools are endpoint-oriented optional products. `oliphaunt-tools` and
  `@oliphaunt/tools` accept a PostgreSQL connection string and do not become
  dependencies or methods of the embedded database SDKs.
- Server handles in native/WASIX Rust, desktop TypeScript, and WASIX TypeScript
  own only the process/listener, connection string, and lifecycle. Applications
  use an ordinary PostgreSQL ORM, driver, or tool for SQL and cancellation; a
  server handle never controls independent client connections.
- Native cancellation targets the runtime's active operation and recovers it
  through PostgreSQL readiness. It is not query-scoped cancellation, and WASIX
  exposes no cancellation method until it has a guest interrupt contract.
- WASIX TypeScript persistence settles a logical operation only after provider
  publication. A callback transaction publishes once after confirmed commit or
  rollback; publication failures preserve their storage and commit-state error.
- WASIX TypeScript close is one terminal memoized attempt once teardown starts.
  A failed or timed-out attempt still retires its Worker/guest owner, reports
  `closed`, rejects later work, and returns the same failure on repeated close;
  a pre-teardown active-transaction rejection remains retryable.
- Native TypeScript classifies close at the private runtime boundary. A direct
  logical-detach error is retryable only before deactivation; broker/server
  errors after their destructive cutoff retire the facade, set `closed`, and
  replay the same terminal attempt. Error strings are never lifecycle state.
- Native broker helpers are one generation per public database handle in both
  Rust and TypeScript. Helper or IPC loss fails the handle permanently; callers
  explicitly close and open a new handle. Neither SDK transparently replaces
  session state or replays uncertain work.
- Native response streaming starts with complete frontend input. Stronger
  WASIX guest stream machinery does not raise that portable guarantee.

Selecting an extension means making its exact runtime artifact, dependencies,
and required pre-start preload/GUC configuration available. It never executes
`CREATE EXTENSION`, `ALTER EXTENSION`, `LOAD`, schema setup, or post-create SQL.
Applications and ORM migrations own database-local installation and upgrades;
reopening a catalog that uses an extension requires selecting its runtime code
again.

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

- Swift, Kotlin, React Native, desktop TypeScript direct mode, and C restore
  use the C runtime's stable sibling lease;
- native Rust retains the byte-identical sibling lease in direct mode and
  hands ownership into C explicitly; its broker child follows that direct path,
  while native server mode retains the lease around the PostgreSQL process;
- Rust WASIX uses its host-directory owner;
- TypeScript uses Web Locks or a Node/Bun/Deno sibling owner as appropriate.

The C and Rust native sibling leases use the same lock identity, so native
direct, broker, server, and C-backed SDK owners reject overlapping use of one
root even across those bindings. WASIX ownership remains provider-specific and
does not establish a cross-runtime lock contract. Locks stay outside the
managed root and backups. Cross-binding root use is not a supported or
qualified workflow even where the native safety lock is shared.

## Registered deferred work

These identifiers record existing repository-enforced deferrals. They are not
an exhaustive roadmap. The deliberate omissions in the stable database API
decision remain absent without requiring a placeholder identifier here; the
rows below are likewise not hidden modes or partly supported capabilities.

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
- treating the PGlite interface as the universal Rust, Swift, or Kotlin API;
- a mutable global parser/serializer registry or silent coercion between
  incompatible PostgreSQL OIDs;
- `ready`/`waitReady`, manual transaction commit, model mapping, a public
  session-reservation primitive, or an ORM-owned pool in the database core;
- idle `LISTEN`/`NOTIFY`, named prepared-statement caching, typed COPY, or
  pull-based row streaming before their runtime contracts exist;
- runtime auto-selection or fallback between native and WASIX packages;
- automatic adoption of descriptorless PGDATA or legacy archive envelopes;
- physical interchange between native and WASIX builds;
- calling a native temporary directory “memory” before PostgreSQL has a real
  in-memory filesystem implementation;
- configuration variables for behavior that is fixed today.

## Review and release rule

A public SDK change is complete when all affected language surfaces, C/header
copies, generated API inventory, docs route, package shape, and behavioral tests
agree. A deliberate delta must appear above with current behavior. A new idea
needs a concrete cross-runtime contract and executable evidence; only the
repository-enforced deferrals listed above require one of their existing exact
IDs.

The lightweight contract checks are:

```sh
moon run sdk-contracts:check
tools/policy/check-sdk-parity.sh
```

Product-owned compile, package, smoke, and release tasks remain the authority
for executable behavior.
