# TypeScript SDK architecture

The TypeScript SDK is a thin native binding with one public entrypoint. It keeps
JavaScript ergonomics at the API boundary and delegates PostgreSQL lifecycle and
physical backup to `liboliphaunt`.

## Public shape

The default `Oliphaunt` client exposes `open`, `openServer`, and static
`restore`. `open` returns the direct/broker database interface. `openServer`
returns a distinct handle with a required connection string and no backup
method.

Typed execute/query results, callback transactions, checkpoint, cancellation,
buffered raw protocol, and close are common where meaningful. Backup is one byte
format and only belongs to direct/broker databases. Runtime modes, capability
objects, archive formats, parsers, stream primitives, packaging reports, and
resource profiles are internal or absent.

## Adapter boundaries

- Native direct uses the platform Node addon on Node/Bun and the Deno FFI
  adapter on Deno.
- Native broker supervises one authenticated helper process per database.
- Native server starts PostgreSQL and owns one wire connection while exposing a
  libpq connection string for external clients.

All three adapters implement the internal buffered runtime binding. The binding
contains only operations required by the public handle. The Node addon and C ABI
may have lower-level symbols for other consumers; the SDK does not mirror unused
symbols into its own interface.

Direct and broker databases have the same public methods. Server differs
structurally instead of returning runtime-dependent failures: it exposes
`connectionString` and omits `backup`. Standard PostgreSQL tools own server
backup and logical import/export; applications provide those tools through their
ordinary environment.

## Lifecycle and concurrency

Direct runtime admission prevents two active direct owners in one process.
Broker supervision prevents duplicate roots and uses a separate cancellation
endpoint so cancellation is not queued behind query output. Server cancellation
uses PostgreSQL CancelRequest.

The database handle tracks close and active transaction state. A transaction
pins the one SDK connection. Body failure rolls back; failed rollback poisons.
COMMIT transport/protocol uncertainty poisons without a later ROLLBACK. An
explicit PostgreSQL `ROLLBACK` command tag returned for COMMIT is the known-idle
exception. Close waits for admitted operations and is idempotent after success.

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
