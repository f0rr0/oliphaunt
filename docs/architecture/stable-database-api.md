# Stable public database API

Status: locked implemented contract, updated 2026-08-27.

This document defines the smallest database and callback-transaction contract
that Oliphaunt keeps conceptually stable across native Rust, Rust WASIX, Swift,
Kotlin, React Native, native TypeScript, and WASIX TypeScript. The
[SDK parity policy](../maintainers/sdk-parity-policy.md) records product and
runtime exceptions.

## Decision

The shared unit is a PostgreSQL concept and its observable behavior, not an
identical method signature or a universal implementation. Each SDK keeps its
normal async model, naming, errors, byte buffers, typed-value protocols, and
resource-lifetime conventions. A difference is acceptable only when this
document or the parity policy identifies the language idiom or runtime limit;
an undocumented missing concept is a parity defect.

PGlite is useful migration evidence for JavaScript users. In particular, its
decoded `query`, ordered `exec` results, statement description, transaction
rollback, and closed-state APIs show what existing ORM integrations expect.
PGlite is not Oliphaunt's architectural north star: Oliphaunt does not depend
on PGlite types, copy implementation-only APIs, or force JavaScript object-row
shapes into Rust, Swift, or Kotlin. PostgreSQL protocol behavior and honest
runtime ownership remain authoritative.

## Lifecycle

`open` settles only when the database is ready for an ordinary operation.
Every database publishes a read-only closed state, spelled idiomatically as
`closed`, `isClosed`, or `is_closed`. It requires no I/O, becomes true once the
handle is terminally retired, and never becomes false. Closing rejects new work, settles
already admitted work according to the runtime's scheduler contract, and is
idempotent after success. A validation failure before teardown starts, such as
an active callback transaction, leaves the handle open so the caller can fix
the condition and retry. If teardown has already irreversibly destroyed the
transport or runtime owner, a reported cleanup failure is terminal: the handle
also becomes closed, rejects work, and repeated close returns that same outcome
instead of pretending the destroyed owner is reusable.

Native cancellation is the one admission exception after `close` has stopped
accepting ordinary SQL. It remains available while already-admitted work drains,
so callers can interrupt the operation that `close` is waiting for. The cancel
gate closes atomically only when destructive teardown begins, and teardown waits
for every admitted cancellation request to settle. This does not make
cancellation query-scoped: without operation IDs it still targets the runtime's
active operation.

Language finalizers and cleaners are only best-effort forgotten-handle safety
nets. They capture an exact private handle generation, never retain the public
facade, and cannot retire a later handle that reused the same process-level
owner. Explicit `close` remains the deterministic lifecycle API and unregisters
its cleanup token before releasing ownership.

Closed and poisoned are different states. A closed handle was deliberately
released. A poisoned handle cannot be trusted after an uncertain transaction,
storage publication, or transport outcome and continues to report the
specific lifecycle or storage error. The public core does not add `ready` or
`waitReady`; callers await `open`.

## Encoded parameters

An encoded non-null parameter has three wire properties:

- an optional PostgreSQL type OID, where absent is encoded as OID zero in
  `Parse` and lets PostgreSQL infer the type;
- a text or binary wire format; and
- owned bytes.

Null has no value representation in PostgreSQL's Bind message: its length is
`-1`, so a text-versus-binary format is not observable. Oliphaunt therefore
canonicalizes null parameters to text format while preserving their optional
OID. The public SDKs do not expose a meaningless binary-null distinction.

All SDKs retain the familiar untyped null, text, and binary constructors. They
also provide a typed-null form and language-native constructors or conversions
for common Boolean, integer, floating-point, string, and byte values. A typed
null retains its OID; it must not collapse into an untyped null.

JavaScript accepts safe scalar values directly and can resolve an otherwise
ambiguous value inside the same owned operation: it parses and describes the
statement, selects an encoder from the resolved parameter OID, and then binds
without releasing the session. This permits `bigint` and `Date`, a plain object
only when PostgreSQL resolves JSON or JSONB, and a plain array only when it
resolves a supported array OID. An immutable per-query encoder map handles
extension OIDs. If the OID is unresolved or incompatible, encoding fails
instead of guessing or stringifying. Plain `undefined` always fails. Explicit
typed-null, JSON, array, text, and binary wrappers remain the deterministic
fast path when the caller already knows the type.

OID and format travel with the value into `Parse` and `Bind`. Adding an OID
does not authorize coercion: an encoder must produce the PostgreSQL
representation for that OID, and a decoder must reject an incompatible OID.
Unknown or extension-defined values remain usable through explicit text or
binary bytes. Typed, OID-bearing parameter construction is the serializer
extension point in every language; JavaScript additionally supports immutable
per-query OID encoders. The core does not add a mutable global serializer
registry.

## Single-statement operations

`query`, `execute`, and `describe` each admit one extended-protocol operation
to the database scheduler. Parse, bind or describe, execute when applicable,
and recovery through `ReadyForQuery` cannot interleave with another caller.
JavaScript's inferred-OID Parse/Describe/Bind cycle is one such operation, not
two public calls with an interleaving window.

| Operation | Contract |
| --- | --- |
| `query` | Executes one statement and returns its zero-or-one row set plus command metadata. Command-only SQL is represented by empty fields and rows so an ORM need not classify arbitrary SQL; `execute` remains the stricter no-rows assertion. Native-language rows retain raw values and add typed access; JavaScript returns decoded rows and keeps the byte-preserving operation as `queryRaw`. |
| `execute` | Executes one statement that must not return rows. It returns the PostgreSQL command tag and a host-representable affected-row count when PostgreSQL supplied one. |
| `describe` | Uses `Parse`, `Describe`, and `Sync` without executing the statement. It returns resolved parameter OIDs, optional result fields, and notices. Caller-supplied parameter OIDs are permitted. |

The PostgreSQL command tag is authoritative. A row count is optional because
not every tag has one and a valid PostgreSQL count may exceed a host integer.
`execute` remains distinct from `exec`: it is the command-only assertion for a
single extended-query statement.

There is no public checkpoint convenience. PostgreSQL already exposes
`CHECKPOINT` as SQL, so a caller with a concrete need uses
`execute("CHECKPOINT")` or the language-equivalent call. Runtime persistence
and first-open publication boundaries remain internal.

`describe` reports wire facts, not inferred SQL syntax or promised codec
objects. An unsuccessful description still drains to the readiness boundary
before the handle can be reused. Named prepared-statement caching is not part
of this API.

Structured database operations verify the transaction status in
`ReadyForQuery`. Outside a callback transaction they must not silently settle
with an open or failed transaction (`T` or `E`) for the next borrower. They
recover to idle when that outcome is provable and otherwise poison the handle.
Inside a callback, successful operations preserve its active transaction;
statement errors remain owned by the callback's rollback path. Raw protocol is
the explicit bypass and does not promise this structured ownership guard.

## Rows and decoding

The portable row representation preserves:

- field order and duplicate field names;
- every field's name, table OID, table attribute number, type OID, type size,
  type modifier, and text/binary format; and
- each cell as null or owned raw bytes.

Native Rust, Rust WASIX, Swift, and Kotlin expose typed access by index and
name over that representation. New typed name lookup rejects a missing or
ambiguous name; index access is the lossless choice when names repeat. A legacy
field-index convenience may retain first-match behavior for source
compatibility, but it is not the typed name-lookup contract. A typed getter
validates the field OID before decoding, represents null through the language's
optional value convention, and reports incompatible OIDs, invalid encoding,
and numeric overflow rather than silently coercing values. Callers can always
fall back to the raw value and metadata.

Decoder extension stays local to a read and retains the raw field context:
Rust uses `FromSql`, Swift uses `OliphauntPostgresDecodable`, and Kotlin uses
`PostgresDecoder<T>`. JavaScript accepts an immutable per-query map from OID
to decoder. A JavaScript override receives the text value and field metadata,
runs before the selected value mode and built-in decoder, and rejects the
operation if it throws; null bypasses it. There is no mutable global parser
registry in the core.

The three JavaScript surfaces share a different, familiar presentation:

- `query` defaults to decoded object rows;
- `rowMode: 'array'` returns decoded positional arrays and preserves duplicate
  columns;
- object mode uses the last field when names repeat;
- `valueMode: 'text'` returns strict UTF-8 strings for text-format cells while
  retaining binary-format cells as `Uint8Array`; and
- `queryRaw` returns the portable byte rows and complete field metadata.

The JavaScript SDKs own their codec types and OID constants. An ORM adapter
must not need `@electric-sql/pglite` merely for types or constants. Object rows
cannot represent duplicate names losslessly, so callers that select duplicate
columns use array or raw mode.

The stable JavaScript defaults decode Boolean, `int2`, `int4`, OID, `float4`,
and `float8` into JavaScript numbers or booleans; keep `int8` and arbitrary
precision numeric values as strings; parse JSON and JSONB; return `bytea` as
`Uint8Array`; and retain date, time, interval, UUID, text, and unknown text
values as strings. PostgreSQL `NaN` and infinities remain valid floating-point
values. Known built-in arrays recurse through the same element rules. A custom
or domain array remains text unless the query supplies an OID decoder.

## Simple-query execution

`exec(sql)` uses PostgreSQL's simple-query protocol, accepts zero or more SQL
statements, and returns their completed results in wire order. A row-producing
statement returns fields and rows; a command returns its command tag and
optional affected-row count. JavaScript uses its selected decoded row mode;
native languages use an idiomatic command-or-rows result value.

`exec` accepts no bind parameters. Every structured executing operation
rejects a top-level COPY statement before buffered dispatch instead of waiting
for an interactive `COPY FROM STDIN` or materializing an unbounded `COPY TO`
response. `describe` remains safe because it does not execute. Raw protocol
and the existing bounded raw-response stream remain the escape hatches. On a
PostgreSQL error, the call rejects after recovery to `ReadyForQuery`; it does
not return a misleading partial-success value.

## Raw protocol escape hatches

Every app-facing SDK exposes one buffered and one callback-streamed raw
protocol operation. Their canonical names are `execProtocolRaw` and
`execProtocolRawStream`, or `exec_protocol_raw` and
`exec_protocol_raw_stream` in Rust. Neither parses the response. Callback
chunks are transport-dependent and callers must not assume that one chunk is
one PostgreSQL message. Callback delivery is synchronous for backpressure; a
callback cannot reenter the same database or transaction handle. The low-level
C boundary enforces this explicitly while its mutex is released: same-handle
query, backup, detach, close, and nested stream calls fail busy, while
out-of-band cancellation remains permitted.

## Notices and errors

`query`, `queryRaw`, `execute`, `exec`, and `describe` preserve structured
`NoticeResponse` values emitted while that operation owns the session. A
notice uses the PostgreSQL error-field vocabulary, including severity,
SQLSTATE, message, optional detail and hint, source location, object names, and
unknown raw fields where the runtime received them. Notices remain ordered and
query-scoped; they are data associated with an operation, not a global event
subscription.

PostgreSQL errors preserve the same available fields and stay distinct from
transport, storage, lifecycle, decoding, and unsupported-operation errors.
The ordinary `severity` property represents protocol field `S`, falling back
to `V` only when `S` is absent; the localized and nonlocalized (`V`) values
remain separately available.
Idle `LISTEN`/`NOTIFY` delivery needs a correct background pump and is not
implied by query-scoped notices. Raw protocol execution continues to expose the
original backend bytes rather than dispatching a second notice channel.

## Callback transactions

A transaction owns the physical session for the callback. Its handle mirrors
the database's `query`, raw-query access, `execute`, `exec`, and `describe`
concepts and publishes a read-only closed state. Database-level operations
that would interleave with the owned session fail while the transaction is
active.

The control flow is:

1. issue `BEGIN` and invoke the callback with an active handle;
2. on a normal callback return, issue `COMMIT` unless the callback explicitly
   rolled back;
3. on a callback error while active, issue `ROLLBACK` and rethrow the callback
   error after confirmed recovery; and
4. expire the transaction handle before the outer transaction call settles.

Explicit `rollback` is one-shot. It issues and confirms `ROLLBACK`, marks the
transaction closed, and causes the outer transaction call to skip `COMMIT`.
The callback may then return a value, and the outer call returns that value.
Further transaction operations, including another rollback, fail
deterministically. A later callback error is still propagated without sending
a second rollback.

A callback error is rethrown unchanged only after an exact `ROLLBACK` completion
and idle `ReadyForQuery`. If the automatic rollback also fails, the SDK throws
an idiomatic composite lifecycle error that retains both failures and poisons
the database. An uncertain commit outcome likewise poisons the database; the
SDK must not claim recovery or send a second transaction-control command.
Manual commit is deliberately absent because it conflicts with callback
ownership. Nested transactions and savepoints can be expressed in SQL where
an adapter owns their policy, but they are not a second core transaction API.

## Runtime and language exceptions

| Difference | Exact scope and behavior |
| --- | --- |
| Calling contract and ownership | App-facing defaults are asynchronous and keep PostgreSQL work off the caller's main/UI/executor thread: the Rust products retain dedicated owners, WASIX TypeScript retains a package Worker, Swift and Kotlin retain serial owners, and React Native delegates to those platform owners. Caller-blocking execution is opt-in only through `oliphaunt_wasix::blocking` or `@oliphaunt/wasix-ts/blocking`; it never hides behind a direct-topology option. The TypeScript blocking entry point still returns promises for loading and persistence, but synchronous guest work runs in and blocks the importing realm. The low-level C ABI remains synchronous. |
| JavaScript decoded rows | Native TypeScript, WASIX TypeScript, and React Native expose decoded object/array modes plus `queryRaw`. Rust, Swift, and Kotlin expose typed getters over raw ordered rows and do not manufacture JavaScript-shaped maps. |
| React Native transport | Swift and Kotlin own database behavior. The TurboModule transports complete results; JavaScript owns decoded row shaping. Operations remain FIFO. |
| WASIX persistence | A successful logical operation does not settle before its provider publication boundary. A callback transaction publishes once after confirmed `COMMIT` or `ROLLBACK`; publication failure retains its WASIX storage and commit-state error. A new persistent direct-OPFS root has one private initialization/full-publication boundary that is not public API. |
| Cancellation | Native SDKs may cancel the runtime's active operation and must recover through readiness. WASIX has no public direct-query cancellation contract. Cancellation is not presented as query-scoped until operation IDs exist. |
| Server handles | Server products exist only where local sockets are honest. Rust WASIX dedicates its one backend to the listener; applications query it with a PostgreSQL client. Browser TypeScript has no server API. |
| Physical backup | Embedded database handles use their runtime-family archive. Native server handles have no SDK backup method. Native and WASIX archives are not interchangeable. |
| Raw streaming | All SDKs provide bounded callback response streaming as `execProtocolRawStream` or `exec_protocol_raw_stream`. Native streaming starts from complete frontend input; stronger WASIX guest streaming does not raise the native guarantee. |

Storage selectors, extension carriers, server and tool products, and archive
compatibility remain governed by the parity and storage policies. They are not
configuration fields on this query contract.

## Compatibility and stability

Native-language APIs retain raw query, command, raw-protocol, and transaction
entry points. Untyped null/text/binary parameter construction remains valid
while typed forms add OID information. Public OID, format, and byte accessors
keep encoded values extensible without requiring callers to match a closed
internal representation.

JavaScript's byte-row operation is explicitly `queryRaw`; ordinary `query` is
decoded with object rows by default. Native TypeScript, WASIX TypeScript, and
React Native share that implementation and its fixtures. Adapters expecting
decoded rows therefore do not need an Oliphaunt-specific decoding layer.

After that transition, stable names do not acquire incompatible semantics.
New codecs, row views, and execution controls are additive. Public protocol
values remain Oliphaunt-owned and PostgreSQL-shaped rather than nominally tied
to another client library.

## Maintenance obligations

Protocol and behavior fixtures remain locked across encoded values, fields,
rows, multi-results, notices, readiness, and transaction state. All three
JavaScript surfaces continue to consume the shared decoded-query core. ORM
adapters qualify against this contract; adapter-owned policy does not reopen
the core unless executable evidence exposes a cross-runtime semantic gap.

## Deliberate omissions

The stable core does not currently include:

- `ready`, `waitReady`, or implementation debug fields;
- JavaScript tagged-template SQL, a model mapper, or an ORM-owned pool; both
  Rust products instead expose their native fluent `Sql` statement builder;
- a public checkpoint convenience or persistence-flush selector;
- manual transaction commit or a second long-lived transaction handle;
- global notice callbacks, idle notifications, or `LISTEN` helpers;
- named prepared statements, a public statement cache, or codec objects in
  `describe` results;
- a mutable global parser or serializer registry;
- a public exclusive-session primitive;
- typed COPY readers/writers or pull-based row streaming; or
- a structured parser for arbitrary raw-protocol exchanges.

An ORM adapter can add ownership rules, migrations, savepoint conventions, and
model mapping without changing the database core. A future core addition needs
cross-runtime semantics and executable evidence; similarity to a PGlite member
alone is not sufficient.

## DRY and conformance boundary

The contract is shared; runtime ownership stays local:

- neutral fixtures define parameter OIDs/formats, descriptions, raw and typed
  rows, multi-results, notices, errors, readiness recovery, transaction state,
  and closed-state cases;
- the shared JavaScript query core owns encoding, decoding, and object/array
  shaping, including the owned inferred-OID cycle, for native TypeScript,
  WASIX TypeScript, and React Native;
- React Native crosses the native bridge in complete typed or raw result
  batches rather than decoding cells independently in Swift and Kotlin;
- native SDKs implement the contract above the existing C protocol-byte ABI;
  typed host-language values do not expand that ABI; and
- native Rust and Rust WASIX may share runtime-independent codec code, but
  scheduler, error, storage, and ownership state remain product-owned.

Parity tests must cover at least typed and untyped nulls, text and binary
formats, explicit and inferred JavaScript encoders, unresolved or mismatched
OIDs, duplicate columns, null and overflow decoding, zero/one/many `exec`
results, description without execution, ordered notices, statement error
recovery, unexpected `T`/`E` ownership, explicit and callback rollback,
rollback/commit uncertainty, expired transaction use, close during admitted
work, and every exception in the table above.

## Related evidence

- [PGlite and Oliphaunt public API comparison](pglite-public-api-comparison.md)
- [ORM integration report](orm-integration-report.md)
- [Database storage contract](database-storage.md)
- [Native runtime contract](../maintainers/native-runtime-contract.md)

The comparison and integration report explain migration demand and sequencing;
this decision and the parity policy remain authoritative for the stable core.
