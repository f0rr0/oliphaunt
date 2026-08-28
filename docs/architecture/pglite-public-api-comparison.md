# PGlite and Oliphaunt public API comparison

Status: current design and implementation report
Compared: 2026-08-28
PGlite baseline: `@electric-sql/pglite` 0.5.7 at
`faa505ad2ea0d14dfb1c99ab9614361c39d2c7e2`

This report compares the current Oliphaunt tree with PGlite's supported
`PGliteInterface`, transaction, query options, results, construction options,
and documented concrete-class conveniences. The
[stable public database API](stable-database-api.md) and
[SDK parity policy](../maintainers/sdk-parity-policy.md) are authoritative for
Oliphaunt. PGlite is the incumbent JavaScript migration source, not the design
authority for Rust, Swift, Kotlin, storage, or runtime ownership.

## Executive conclusion

Oliphaunt now implements the difficult database-client behavior directly:

- decoded JavaScript object and array rows plus a byte-preserving `queryRaw`;
- OID-aware parameters, JavaScript encoders and decoders, and typed native rows;
- structured single-statement `query`, command-only `execute`, multi-statement
  `exec`, and non-executing `describe`;
- callback transactions with explicit rollback, closed state, session
  ownership, recovery, and poisoning rules; and
- buffered and bounded callback raw-protocol execution.

An Oliphaunt-native ORM driver therefore does not need a second query engine,
row decoder, or transaction layer. Oliphaunt is nevertheless not a structural
implementation of `PGliteInterface`. Existing code typed directly against that
interface still needs a small adapter for method and result names, PGlite's
option-object shapes, lifecycle compatibility fields, and ownership policy.

Server mode remains the zero-special-case path: ordinary PostgreSQL drivers and
ORMs use `connectionString`. This comparison matters most for native direct and
broker execution, WASIX caller-realm and explicit Worker execution, browsers,
mobile, and the two embedded Rust products.

## Core method contrast

| PGlite public API | Current Oliphaunt | Assessment |
| --- | --- | --- |
| `new PGlite(...)` | Language-native `open` or builder `open` | Same construction intent, different lifecycle shape |
| `PGlite.create(...)` | `open(...)` | Closest match; returns only after readiness |
| `waitReady`, `ready` | Absent | Deliberate: callers await `open` rather than receive a not-yet-ready handle |
| `closed` | `closed`, `isClosed`, or `is_closed` | Conceptual parity in all app-facing SDKs |
| `debug` | Absent | PGlite implementation convenience, not an ORM requirement |
| `close()` | `close()` | Parity; Oliphaunt close is idempotent after success |
| async disposal | JavaScript database/server handles support `Symbol.asyncDispose` | Parity where the language has the convention |
| `query()` | `query()`; JavaScript also has `queryRaw()` | Strong semantic parity; result type names differ |
| tagged `` sql`...` `` | No JavaScript tag | Missing convenience, not a database capability gap |
| `exec()` | `exec()` | Strong parity: parameterless simple-query, ordered multi-results |
| `describeQuery()` | `describe()` | Same protocol purpose; result contracts deliberately differ |
| `transaction()` | `transaction()` | Strong parity; Oliphaunt has stricter ownership and recovery semantics |
| `execProtocolRaw()` | `execProtocolRaw` / `exec_protocol_raw` on database/root handles | Same raw-byte operation and root-level escape-hatch placement |
| `execProtocolRawStream()` | `execProtocolRawStream` / `exec_protocol_raw_stream` on database/root handles | Same raw-byte streaming concept; JavaScript signatures differ |
| structured `execProtocol()` | Absent | Real gap for callers wanting parsed arbitrary backend messages |
| `runExclusive()` | Absent publicly | Deliberate; one operation or callback transaction owns the session |
| notification methods | Absent | Real gap for embedded idle `LISTEN`/`NOTIFY` delivery |
| `dumpDataDir()` | `backup()` plus static/client `restore()` | Similar use, intentionally incompatible physical archive contract |
| `refreshArrayTypes()` | Absent | Standard array OIDs plus operation-scoped codecs; custom arrays need a decoder |

PGlite's concrete class also exposes members outside `PGliteInterface`, such as
`dataDir`, mutable codec maps, `execProtocolRawSync`, `syncToFs`, `clone`,
`copyToFS`, and Emscripten module details. They are useful evidence about PGlite
applications but are not a portable database-interface target. Oliphaunt does
not expose its runtime module, filesystem, mutex, or process internals.

## Construction and readiness

PGlite supports a synchronous constructor that begins initialization and an
async factory that waits for readiness. Oliphaunt exposes only a ready handle,
with execution placement kept separate from database topology:

- native Rust and WASIX Rust root `Oliphaunt` types are synchronous and
  exclusive, while root `AsyncOliphaunt` types provide cloneable asynchronous
  owner-thread alternatives. Native direct calls block without an SDK queue hop
  but PostgreSQL runs on liboliphaunt's backend pthread; WASIX direct guest work
  actually executes on the caller thread;
- native TypeScript and React Native return promises and retain runtime work
  behind their SDK/platform asynchronous boundaries; and
- Swift uses an async throwing factory and Kotlin uses a suspending factory,
  with dedicated serial owners appropriate to those platforms.

WASIX TypeScript follows PGlite's placement philosophy directly. The root
entry point runs PostgreSQL in the importing realm, while `/worker` opts into a
package-owned Web Worker or Node-compatible worker thread. Both surfaces remain
Promise-shaped because loading and durable provider publication are
asynchronous. On the root surface, that Promise does not move synchronous guest
CPU work off the caller's event loop. The Worker surface changes execution
placement, not database topology or query semantics.

Every SDK publishes closed state. Readiness properties remain unnecessary for
Oliphaunt-native code because a successful `open` is the readiness boundary. A
PGlite compatibility adapter may expose an already-resolved `waitReady` and
`ready === true` without adding those compatibility fields to the stable core.

Rust separates database construction from endpoint ownership. Synchronous
`OliphauntBuilder` and asynchronous `AsyncOliphauntBuilder` end in `open`;
dedicated `OliphauntServerBuilder` and `AsyncOliphauntServerBuilder` end in
`start`. Server handles publish only their connection string, closed state, and
close. This has no PGlite equivalent because PGlite is itself the query handle,
not a supervisor for independent PostgreSQL client connections.

## `query`, `execute`, and `exec` are different operations

These names are intentionally not aliases:

| Operation | PostgreSQL path | Statements | Parameters | Row contract |
| --- | --- | --- | --- | --- |
| `query` | Extended query | Exactly one | Yes | Zero or one row set; command-only SQL is represented by empty fields/rows |
| `execute` | Extended query | Exactly one | Yes | Asserts that the statement returns no rows and returns command metadata |
| `exec` | Simple query | Zero or more | No | Returns every command or row result in wire order |

PGlite has `query` and `exec`, but no distinct command-only `execute` assertion.
Oliphaunt retains `execute` because it catches a useful class of mistakes while
keeping `query` general enough for ORMs that cannot classify arbitrary SQL in
advance. In both products, multi-statement parameter binding is not part of
`exec`.

Every structured executing operation rejects top-level COPY rather than
buffering an unbounded result or waiting forever for interactive COPY input.
Callers use the raw protocol APIs, a future typed COPY API, or server mode.

There is no public `checkpoint()` convenience in Oliphaunt. PostgreSQL already
defines the operation as SQL; an application with a real need calls
`execute("CHECKPOINT")` or the native-language equivalent. This avoids a thin
method that would otherwise need permanent cross-SDK maintenance. WASIX
persistence publication after successful operations is an internal runtime
boundary, not a checkpoint method.

## Query rows, options, and codecs

### JavaScript

PGlite and the three Oliphaunt JavaScript SDK packages, including both WASIX
root and Worker execution surfaces, now share the important shape:

- object rows by default;
- positional rows with `rowMode: 'array'`;
- per-query OID decoders and encoders; and
- safe parameter serialization after PostgreSQL has resolved ambiguous OIDs.

Oliphaunt additionally exposes `valueMode: 'text'` and `queryRaw`. Its raw
result preserves field name, table OID, table attribute number, type OID, type
size, type modifier, format, and ordered nullable bytes. PGlite's public field
shape contains only `name` and `dataTypeID`.

The shared object-row default does not imply identical ambiguity handling.
PGlite follows the common JavaScript behavior of overwriting an earlier value
when result columns repeat a name. Oliphaunt rejects that object shape instead;
callers use `rowMode: 'array'` (or `queryRaw`) to preserve duplicate columns.

The option names are intentionally Oliphaunt-owned:

| PGlite option | Oliphaunt | Difference |
| --- | --- | --- |
| `rowMode` | `rowMode` | Same object/array selection; Oliphaunt rejects duplicate names in object mode instead of overwriting an earlier value |
| `parsers` | `decoders` | Oliphaunt decoder also receives field metadata |
| `serializers` | `encoders` | Oliphaunt returns validated typed wire carriers rather than only strings |
| `paramTypes` | OID-bearing parameter values and typed-null/text/binary/JSON/array wrappers | OID travels with each value |
| `onNotice` | Ordered notices on results and errors | Data rather than a side-effect callback |
| `blob` | No equivalent | PGlite-specific COPY/blob device |

PGlite also permits mutable instance-level parser and serializer maps.
Oliphaunt keeps codec maps immutable and operation-scoped so concurrent callers
cannot observe registry mutation. A driver may retain its own immutable map and
supply it to each call.

Important default-decoding differences remain migration concerns:

- PGlite treats `undefined` as SQL null; Oliphaunt rejects it.
- PGlite has a general `toString()` serialization fallback; Oliphaunt rejects
  unsupported or OID-incompatible values.
- PGlite may return `int8` as `number` or `bigint`; Oliphaunt JavaScript keeps
  `int8` as a decimal string.
- PGlite returns JavaScript `Date` for date/timestamp defaults; Oliphaunt keeps
  PostgreSQL date/time text as strings.
- Both decode common booleans, numeric types, JSON/JSONB, `bytea`, and known
  arrays. Oliphaunt requires an explicit decoder for nonstandard enum, domain,
  or extension arrays.

These stricter defaults prevent silent precision loss and accidental
stringification but must be covered by migration tests.

### Native languages

Rust, Swift, and Kotlin do not manufacture JavaScript object maps. They expose
ordered raw rows, complete field metadata, and OID-validating typed access:

- native and WASIX Rust use `FromSql`, `IntoParameter`, `TypeOid`, and
  `ValueFormat`;
- Swift uses `OliphauntPostgresDecodable`, `Data`, and native optional values;
  and
- Kotlin uses `PostgresDecoder<T>`, `ByteArray`, and Kotlin nullability.

This is conceptual parity with the JavaScript codec contract expressed in each
language's normal conventions.

## Rust `Sql` is not PGlite tagged SQL

Both Rust products expose the same fluent statement concept:

```rust,ignore
let rows = database
    .sql("select $1::int4 as value")
    .bind(41_i32)
    .query()?;
```

The builder is available on native Rust and WASIX Rust databases and callback
transactions. It accumulates typed parameters and result format, then ends in
`query`, `execute`, or `describe`. Both root `Oliphaunt` types run terminals
synchronously with exclusive mutable borrowing. Their root `AsyncOliphaunt`
types expose the same fluent terminals as futures executed by retained owner
threads.

PGlite's tagged template instead interprets JavaScript template substitutions
and supplies helpers such as raw SQL and quoted identifiers. The two APIs solve
adjacent ergonomics problems but are not substitutes. Oliphaunt does not copy
the Rust builder into JavaScript, Swift, or Kotlin, and does not describe it as
tagged SQL.

## Result-shape differences

| PGlite `Results` | Oliphaunt structured result |
| --- | --- |
| `rows` | `rows` |
| `fields[].dataTypeID` | `fields[].typeOid` plus full wire metadata |
| `command` | complete `commandTag` |
| `affectedRows` / `rowCount` | nullable `rowCount` derived from the command tag |
| optional `blob` | no structured blob result |
| notice callback | ordered `notices` in the result or error |
| no result discriminator | explicit command/rows kind where the language needs it |

PGlite `exec()` resolves directly to an array of results. Oliphaunt JavaScript
returns a wrapper containing ordered `statements` and operation-level
`notices`. An exact `PGliteInterface` adapter must project these names and
shapes even though the database semantics are already available.

## Description

PGlite `describeQuery` returns parameter descriptions and result fields that
include the JavaScript serializer/parser functions selected by its mutable
codec registry. Oliphaunt `describe` returns stable PostgreSQL facts: resolved
parameter OIDs, optional complete field metadata, and notices. It validates the
terminal readiness state before returning rather than exposing it as result
data, and deliberately does not return executable codec objects.

Both operations use Parse/Describe without executing. Oliphaunt's result is
more portable across languages and does not become stale when an application
changes an adapter-owned codec map.

## Transactions and ownership

Both products commit when the callback returns normally, roll back when it
throws, support explicit early rollback, and expose a closed transaction state.
Their transaction handles provide `query`, `exec`, and rollback. PGlite
additionally exposes tagged SQL and notification listening.

Oliphaunt's transaction handle adds the structured `execute` and `describe`
operations while deliberately omitting buffered and streamed raw protocol.
PGlite likewise keeps `execProtocolRaw` on its database rather than its
transaction interface. Oliphaunt's ownership contract is stronger:

- the physical session is pinned for the callback;
- database-level operations cannot interleave with the callback;
- structured operations validate the final `ReadyForQuery` status;
- explicit rollback is one-shot and suppresses the later commit;
- callback and rollback failures are retained together; and
- uncertain rollback or commit outcomes poison the database rather than claim
  recovery.

Oliphaunt derives managed ownership from every exact backend command tag and
the single terminal readiness status before high-level result parsing. Manual
lifecycle SQL and `AND CHAIN` are unsupported inside the callback, while
savepoints and `ROLLBACK TO` remain valid. Because PostgreSQL makes `ROLLBACK
AND CHAIN` indistinguishable from `ROLLBACK TO` at this protocol boundary,
Oliphaunt lexically rejects `ROLLBACK`/`ABORT ... AND CHAIN` before dispatch. A
proven or uncertain ownership escape makes the database close-only and
suppresses speculative SDK control.

There is no public `runExclusive`. One structured call already owns its entire
Parse/Describe/Bind/Execute/Sync cycle, and a callback transaction is the
public multi-call ownership boundary. This is sufficient for ORM drivers
without exposing the scheduler lock as application API.

## Raw protocol

Every embedded database/root SDK surface exposes the canonical pair;
transaction and server-lifecycle handles do not:

- `execProtocolRaw` / `exec_protocol_raw` buffers one complete backend response;
- `execProtocolRawStream` / `exec_protocol_raw_stream` delivers bounded raw
  backend chunks to a callback.

The stream name includes `Raw` because neither method parses responses and
callback chunk boundaries are transport-dependent. In particular, callers
must not assume that one callback equals one PostgreSQL backend message.

PGlite JavaScript passes an options object containing `onRawData` and optional
filesystem-sync policy. Oliphaunt JavaScript takes the callback directly and
owns persistence publication at its runtime operation boundary. Matching the
method name therefore improves migration clarity but does not make the
signature structurally identical.

PGlite's concrete class also has `execProtocolRawSync`. Oliphaunt deliberately
does not promise a synchronous-return JavaScript result. The WASIX root means
guest computation runs in the caller realm; loading, persistence publication,
and the public result remain promise-shaped. This keeps the calling shape and
execution owner independently explicit without pretending durable I/O is
synchronous.

PGlite additionally exposes structured `execProtocol`, which parses supported
backend messages while retaining the raw data. Oliphaunt intentionally has no
general parser for arbitrary raw-protocol exchanges. Its structured SQL
methods parse only the exchanges they own.

## Backup, restore, storage, and persistence

PGlite `dumpDataDir` and `loadDataDir` move a PGlite-version-specific filesystem
image. Oliphaunt provides a validated physical archive through `backup` and a
separate restore operation into a new or empty destination. Native and WASIX
archive families are deliberately distinct, and neither is PGlite-compatible.
Logical SQL dump/restore through ordinary tools is the portability path.

WASIX TypeScript publishes persistent state after successful operations and
once after a confirmed callback transaction. A newly created persistent direct
OPFS database also uses an internal full-publication boundary after startup so
an incomplete initialization cannot become a ready namespace. That full-flush
selector and the initializing/ready phase are provider implementation details;
they are not database methods or public configuration.

PostgreSQL `CHECKPOINT` remains ordinary SQL. Calling
`execute("CHECKPOINT")` receives the same normal operation-level persistence
boundary as any other successful mutating statement. No public checkpoint
convenience is required to make persistent storage correct.

Extension selection is also deliberately separate from database-local SQL.
Oliphaunt selection makes exact artifacts, dependencies, and required pre-start
preload/GUC settings available, but never executes `CREATE EXTENSION`, `ALTER
EXTENSION`, `LOAD`, schema setup, or post-create SQL. Applications and ORM
migrations retain ordinary PostgreSQL ownership of installation and upgrades.

## Capabilities PGlite retains

The meaningful PGlite-only embedded capabilities are:

- JavaScript tagged-template SQL and helper fragments;
- idle `LISTEN`/`NOTIFY` callbacks and a background notification pump;
- structured arbitrary-protocol message execution;
- PGlite's Blob/COPY device;
- dynamic array-type refresh and mutable instance codec registries;
- `runExclusive`, `clone`, and filesystem/Emscripten escape hatches;
- client extensions that install JavaScript namespaces;
- live and incremental query packages and framework hooks; and
- multi-tab worker leadership and failover.

Only notifications, a bounded typed COPY API, and multi-tab shared ownership
represent likely database/product work. Tagged SQL, live queries, framework
hooks, and a strict PGlite facade can remain optional packages above the stable
core. Mutable registries, runtime internals, and public mutexes should remain
outside it.

## Capabilities Oliphaunt adds

Oliphaunt's public product family goes beyond PGlite core with:

- native direct and broker execution;
- native Rust, Swift, Kotlin, React Native, and desktop TypeScript SDKs;
- WASIX Rust plus browser/Node/Bun/Deno TypeScript execution;
- lifecycle-and-URI-only native and WASIX server products where sockets are
  honest;
- ordinary PostgreSQL driver interoperability through connection strings;
- native and WASIX PostgreSQL tools;
- exact packaged PostgreSQL extension availability without implicit
  database-local installation;
- richer field metadata and raw-row fallbacks;
- out-of-band native cancellation; and
- validated physical backup/restore, explicit storage ownership, and poisoned
  session semantics.

## Per-runtime summary

| Surface | Public database shape | Deliberate difference |
| --- | --- | --- |
| Native TypeScript | Promise database API in direct/broker mode: decoded `query`, `queryRaw`, `execute`, `exec`, `describe`, transactions, raw protocol, cancellation, backup/restore; separate server facade | Server exposes only `connectionString` and lifecycle; direct and broker keep one session |
| WASIX TypeScript | Same JavaScript database shape through the caller-realm root or explicit `/worker`; separate Node/Bun/Deno server subpaths; memory, IndexedDB, OPFS, and managed directories | Both database surfaces are Promise-shaped; root guest CPU work runs in the caller realm while `/worker` adds RPC isolation; server is URI/lifecycle only; no cancellation; browsers have no server sockets |
| React Native | Same JavaScript SQL and codec shape over Swift/Kotlin | Direct mobile only; JSI carries binary batches and raw chunks |
| Native Rust | Synchronous exclusive `Oliphaunt` plus root `AsyncOliphaunt`; fluent `Sql`; typed ordered rows; direct/broker; separate sync/async server builders | Sync database is `Send + !Sync`; async database is cloneable `Send + Sync`; server handle is URI/lifecycle only; direct PostgreSQL uses liboliphaunt's backend pthread |
| WASIX Rust | Synchronous exclusive `Oliphaunt` plus root `AsyncOliphaunt`; fluent `Sql`; typed ordered rows; memory/directory storage; separate sync/async server builders | Sync database is `!Send + !Sync`; async database is cloneable `Send + Sync`; server is single-client and URI/lifecycle only; no cancellation |
| Swift | Actor-isolated async database; typed ordered rows and Foundation byte/path types | Direct Apple runtime; no server product |
| Kotlin | Coroutine database; typed ordered rows and Kotlin byte/path types | Android is the current application facade; no server product |

Rust also has two stable value-shape decisions with no useful PGlite analogue.
Both Rust products expose an opaque cloneable `Error` classified by a root
non-exhaustive `ErrorKind` (`InvalidConfiguration`, `Lifecycle`,
`TransactionActive`, `Postgres`, or `Other`) while retaining PostgreSQL and
composite transaction detail through accessors. Their opaque root `Extension`
uses uppercase associated constants, `Extension::ALL`,
`Extension::by_sql_name`, and `sql_name`; WASIX exposes only extensions enabled
by Cargo features. These are intentionally Rust-shaped APIs rather than copies
of PGlite JavaScript error objects or extension objects.

## Migration assessment

For PGlite users, the ordinary mental model now transfers directly:

- await open, issue `query` or `exec`, select object/array rows, and use a
  callback transaction;
- use per-query OID codecs for application-specific types; and
- close an owned database while leaving a borrowed database to its owner.

The remaining exact-adapter work is bounded:

1. map lifecycle compatibility fields if the consuming library insists on
   `PGliteInterface` rather than a driver abstraction;
2. translate parser/serializer and notice option names;
3. project Oliphaunt field/result names to PGlite names;
4. choose PGlite-compatible default conversions only when exact migration is
   more important than Oliphaunt's precision-preserving defaults; and
5. define whether the adapter owns or borrows the supplied database.

An Oliphaunt-native ORM integration should use the stable API directly. A
strict PGlite compatibility facade, if shipped, should remain a thin optional
JavaScript package rather than reopen the cross-language core.

## Test obligations

Driver and compatibility qualification must cover:

- object and array rows, duplicate names, nulls, empty results, and commands
  returning rows;
- `int8`, arbitrary numeric, date/time, JSON/JSONB, `bytea`, UUID, arrays,
  extension OIDs, NaN, and infinities;
- typed null, OID inference, encoder mismatch, unsupported values, and binary
  parameters;
- zero, one, and many `exec` results with mid-batch PostgreSQL errors;
- statement description without execution and ordered notices;
- commit, callback failure, explicit rollback, expired transaction handles,
  manual lifecycle/`AND CHAIN` misuse, protocol-derived ownership escape, and
  rollback/commit uncertainty;
- direct, broker, worker, browser, and React Native ownership boundaries; and
- streamed raw chunks split at arbitrary offsets rather than only backend
  message boundaries.

## Sources

- [PGlite API documentation](https://pglite.dev/docs/api)
- [PGlite public interface](https://github.com/electric-sql/pglite/blob/faa505ad2ea0d14dfb1c99ab9614361c39d2c7e2/packages/pglite/src/interface.ts)
- [PGlite concrete implementation](https://github.com/electric-sql/pglite/blob/faa505ad2ea0d14dfb1c99ab9614361c39d2c7e2/packages/pglite/src/pglite.ts)
- [Oliphaunt stable database API](stable-database-api.md)
- [Oliphaunt SDK parity policy](../maintainers/sdk-parity-policy.md)
