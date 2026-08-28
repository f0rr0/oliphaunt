# TypeScript SDK architecture

The TypeScript SDK is a thin native binding with one public entrypoint. It keeps
JavaScript ergonomics at the API boundary and delegates PostgreSQL lifecycle and
physical backup to `liboliphaunt`.

## Public shape

The default `Oliphaunt` client exposes `open`, `openServer`, and static
`restore`. `open` returns the direct/broker database interface. `openServer`
returns a distinct handle with a required connection string and no backup
or database-connection methods.

Typed execute/query results, callback transactions, cancellation, buffered and
callback-streamed raw protocol, and close are common where meaningful. Backup
is one byte format and only belongs to direct/broker databases. Runtime modes,
capability objects, archive formats, parsers, stream primitives, packaging
reports, and resource profiles are internal or absent.

## Adapter boundaries

- Native direct uses the platform Node addon on Node/Bun and the Deno FFI
  adapter on Deno.
- Native broker owns one authenticated helper process per database. Helper or
  IPC failure permanently fails that database handle; recovery is an explicit
  close plus new open, never transparent session replacement or request replay.
- Native server starts PostgreSQL, closes its private readiness probe before
  publication, and exposes a connection string for caller-owned ORMs, drivers,
  and tools.

All three adapters implement the internal runtime binding. Its server adapter
uses only open/connection-string/close/finalizer slots; required database slots
reject internally and never appear on the public server facade. The Node addon and C ABI
may have lower-level symbols for other consumers; the SDK does not mirror unused
symbols into its own interface.

The private close boundary returns a discriminated `closed`, `retryable`, or
`terminal` outcome. Direct adapters may report retryable only when logical
deactivation did not occur. Broker and server adapters cross a destructive
cutoff before fallible process/filesystem cleanup and therefore classify those
failures as terminal without inspecting error text.

The public database contract is promise-based in every JavaScript runtime, and
PostgreSQL open, query, backup, restore, and detach work runs through async native
work (Node/Bun addon jobs or Deno `nonblocking` FFI). Loading the native module is
the narrow exception: Node/Bun `require()` and Deno `dlopen()` are synchronous
platform operations during first adapter resolution. They do not run a database
operation or create an alternate synchronous database surface.

Direct and broker databases have the same public methods. Server differs
structurally instead of returning runtime-dependent failures: it exposes only
`connectionString`, `closed`, `close`, and async disposal. External connections
own SQL, transactions, raw protocol, cancellation, and backup. Standard
PostgreSQL tools own server backup and logical import/export; applications
provide those tools through their ordinary environment.

## Lifecycle and concurrency

Direct runtime admission prevents two active direct owners in one process.
Broker supervision prevents duplicate roots and uses a separate cancellation
endpoint so cancellation is not queued behind query output. The server handle
does not control independent external connections.

The database handle tracks close and active transaction state. A transaction
pins the one SDK connection. Body failure rolls back; failed rollback poisons.
COMMIT transport/protocol uncertainty poisons without a later ROLLBACK. An
explicit PostgreSQL `ROLLBACK` command tag returned for COMMIT is the known-idle
exception. Close waits for admitted operations. A pre-teardown direct failure
may be retried; after success or a destructive broker/server failure, the one
terminal close attempt is retained and later calls replay its exact outcome.
The read-only `closed` state becomes true for either terminal result.

Managed transaction handles expose structured SQL only. They reject ownership
escape based on exact `CommandComplete` tags and the terminal `ReadyForQuery`
frame before high-level parsing, then make the database close-only without a
speculative SDK control command. Manual transaction lifecycle SQL and `AND
CHAIN` are unsupported; `SAVEPOINT` and `ROLLBACK TO` remain supported.
Closing stops ordinary session admission immediately, but keeps out-of-band
cancel admission open while already-admitted work drains. Runtime teardown
closes that cancel gate only after every admitted cancellation request settles.

Raw-stream callbacks provide synchronous backpressure. While a callback runs,
same-handle database work, transaction work, backup, close, and nested streams
are rejected at admission rather than silently queued. Out-of-band `cancel()`
remains available.

Explicit close unregisters forgotten-handle cleanup before releasing the
JavaScript direct owner. Node/Bun register the public object with a
`FinalizationRegistry` whose held record contains an opaque, exact-generation
addon token. The registry only releases the matching JavaScript admission lease
if the addon safely marks that generation for recovery by the next asynchronous
open. Deno registers the public database object with a `FinalizationRegistry`
whose held record contains only the logical generation and an idempotent ownership-release
callback, never the object or opaque pointer. The finalizer only starts a
`nonblocking` generation-guarded terminal FFI close and swallows its unobservable
outcome. This makes stale cleanup harmless without running PostgreSQL teardown
on the JavaScript finalizer job. Broker and server registries likewise hold only
an exact private runtime handle and private lease generation, never the public
facade or its release callback. Their finalizers schedule asynchronous teardown;
explicitly unregistered and superseded generations are no-ops. Registration is
the last step of facade publication: if it throws, the opened handle is retired,
any partial registration is unregistered, and the exact JavaScript ownership
lease is released before `open()` rejects. None of these guards make garbage
collection a supported replacement for explicit close.

## Storage

Storage resolution maps temporary or caller-owned roots to `pgdata/`. Root
preparation and restore validate before mutation. Initialization creates PGDATA
first and publishes the exact shared `.oliphaunt.json` descriptor last. Symlink
roots and structural directories are rejected.

Direct and broker share the native C sibling lease. The server provider prevents
duplicate server ownership separately. Neither mechanism coordinates across
providers, so simultaneous direct/broker/server mutation of one root is
application error. The descriptor records the root schema, family/format pair,
PGDATA directory name, and PostgreSQL major; it does not record JavaScript or
Node ownership and does not reject another valid runtime family merely because
cross-family reuse is undocumented.

Direct/broker backup bytes contain the PostgreSQL physical initialization
payload. Restore stages those bytes in a sibling directory, validates PGDATA,
and creates the outer receiving identity. Existing nonempty destinations are
rejected. No replacement mode exists.

## Packaging

Optional platform packages carry the native library/runtime, Node addon, broker
helper, and ICU data. Resolution validates package versions and target identity
before loading. Split native client-tool packages are independent products, not
dependencies or locators of `@oliphaunt/ts`. Development path overrides are
normalized internally but do not create alternate public runtime profiles.

Extension selection uses the generated exact-name PostgreSQL 18 catalog. The
adapter resolves only selected artifacts and required preload libraries. Package
metadata, resource manifests, and materialization details remain outside the
public SDK contract.
