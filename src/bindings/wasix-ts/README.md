# `@oliphaunt/wasix-ts`

Portable PostgreSQL 18 for TypeScript, backed by the canonical
`liboliphaunt-wasix` guest. The same API runs in browsers, Node.js, Bun, and
Deno. The root entrypoint runs PostgreSQL directly in the importing JavaScript
realm. The explicit `@oliphaunt/wasix-ts/worker` entrypoint owns PostgreSQL in
one package Worker so database work does not block the importing realm.

## Install

```sh
pnpm add @oliphaunt/wasix-ts
```

The runtime and `standard` cluster seed come from the matching
`@oliphaunt/liboliphaunt-wasix` carrier. Applications do not configure raw
runtime assets.

Optional ICU data and its matching `icu` seed are selected explicitly:

<!-- liboliphaunt-doc-example:wasix-typescript-icu -->
```ts
import Oliphaunt from '@oliphaunt/wasix-ts';
import icu from '@oliphaunt/wasix-icu';

await using database = await Oliphaunt.open({ icu });
```

## Query PostgreSQL

<!-- liboliphaunt-doc-example:wasix-typescript-query -->
```ts
import Oliphaunt from '@oliphaunt/wasix-ts';

await using database = await Oliphaunt.open();

await database.execute('create table todo (title text not null)');
await database.execute('insert into todo values ($1)', ['ship it']);

const result = await database.query(
  'select title from todo where title = $1',
  ['ship it'],
);
console.log(result.rows[0]?.title);
```

`execute` asserts one command with no rows. `query` accepts command-only or
row-producing SQL and defaults to decoded object rows; array rows, text value
mode, and immutable per-query OID codecs are available. Object mode rejects
duplicate field names; use `rowMode: 'array'` to preserve them positionally.
`queryRaw` retains ordered nullable bytes and complete field metadata. `exec` returns ordered
simple-query results, while `describe` resolves parameter OIDs and optional
result fields without executing. Structured operations preserve command
metadata and ordered notices.

Safe scalar parameters are resolved and encoded inside one owned operation.
Use `text`, `binary`, `typedNull`, `json`, or `array` with `postgresOids` for a
deterministic type, or an immutable per-query encoder for an extension OID.
Unsupported and mismatched values fail rather than being guessed.

`execProtocolRaw` is the buffered PostgreSQL frontend-protocol escape hatch.
`execProtocolRawStream` delivers the same response through a synchronous callback
with bounded backpressure, so COPY-sized responses need not be retained as one
JavaScript value. The callback is invoked serially and must return before the
next chunk can be produced. A thrown callback, including the deterministic
error for returning a Promise or thenable, is rethrown unchanged only after the
guest confirms recovery to `ReadyForQuery`; the recovered database remains
reusable. An asynchronous callback cannot provide this backpressure contract.
The callback also cannot reenter the same database or transaction;
fire-and-forget calls are rejected instead of being queued behind the stream.
Neither method interprets responses for the caller. A buffered raw rejection,
or a streamed execution, transport, or recovery failure, poisons the handle and
takes precedence over a simultaneous callback error; close it and open a new
database instead of assuming the physical session recovered.

PostgreSQL `ErrorResponse` values reject with `PostgresError`, including the
SQLSTATE and structured diagnostic fields.

## Transactions

<!-- liboliphaunt-doc-example:wasix-typescript-transaction -->
```ts
await database.transaction(async (transaction) => {
  await transaction.execute('insert into todo values ($1)', ['inside transaction']);
  return transaction.query('select count(*)::int4 as count from todo');
});
```

The callback exclusively owns the session from `BEGIN` through its final
boundary. It mirrors query/raw query, execute, exec, and describe; database-level
operations reject while it is active. One-shot `rollback()` closes the
transaction and lets the callback return without a later commit.

Raw protocol is database-only and deliberately absent from the callback handle.
Do not issue manual `BEGIN`, `START TRANSACTION`, `COMMIT`, `END`, `ABORT`,
`PREPARE TRANSACTION`, or `AND CHAIN` inside the callback; return/throw or call
`rollback()` instead. `SAVEPOINT` and `ROLLBACK TO` are supported. `ROLLBACK AND
CHAIN` is unsupported contract misuse and has the same PostgreSQL wire
tag/readiness state as `ROLLBACK TO`, so the SDK rejects `ROLLBACK`/`ABORT ...
AND CHAIN` before dispatch and still validates every actual protocol boundary.
A proven ownership escape makes the database close-only and never causes a
speculative SDK `COMMIT` or `ROLLBACK`.

Callback failures trigger a best-effort `ROLLBACK`. Once `COMMIT` has been
sent, the binding never sends a second rollback. PostgreSQL's clean `ROLLBACK`
response is a known aborted outcome; a transport failure or malformed response
after `COMMIT` makes the outcome unknown and poisons the handle until close.
Persistent publication completes before a successful transaction resolves.
After rollback and its required publication succeed, the original callback
failure is rethrown unchanged. If the callback and rollback both fail, an
`AggregateError` preserves the callback failure followed by the rollback
failure. If an earlier independent database or protocol failure has already
poisoned or expired transaction ownership and the callback then throws a
different value, an `AggregateError` preserves the callback failure followed by
that database failure; the database is close-only. Ordinary PostgreSQL statement
errors that remain safely rollbackable are not automatically aggregated.

## Storage

Omitting `storage` creates a fresh true-memory database. Persistent adapters
are explicit, host-specific imports:

<!-- liboliphaunt-doc-example:wasix-typescript-storage-node -->
```ts
import Oliphaunt from '@oliphaunt/wasix-ts';
import { directory } from '@oliphaunt/wasix-ts/storage/node';

const storage = directory('./data/todos');
let database = await Oliphaunt.open({ storage });
await database.execute('create table if not exists todo (title text not null)');
await database.close();

database = await Oliphaunt.open({ storage });
await database.close();
```

Use `storage/bun` or `storage/deno` for those runtimes, and
`storage/indexed-db` or `storage/opfs` in browsers.

A Node, Bun, or Deno directory is a managed root with exactly:

```text
.oliphaunt.json
pgdata/
```

The descriptor records the shared database-root schema, PostgreSQL major, and
WASIX physical format. Runtime source fingerprints and package hashes validate
the asset graph; they are not physical-reopen identity. Native and WASIX roots
are not rejected merely because of the originating family.

Rust and WASIX TypeScript bindings use the same root and physical-archive
contracts. Their locks are binding-local and only prevent competing opens
within that binding. Cross-binding root or archive transfer is not a supported
or qualified workflow.

Node publication writes WAL before ordinary files and `global/pg_control`,
then fsyncs changed files and parent directories. IndexedDB publishes a delta
in one transaction. OPFS uses synchronous backing files for `/worker` and when
the root entrypoint is imported inside an application-owned Dedicated Worker.
The root entrypoint in a browser Window uses the same opaque format through a
copy-on-write portable path. Both OPFS paths flush or publish in
PostgreSQL-safe order. A
publication failure rejects with `WasixStorageError`; an uncertain state
poisons the live database handle.

Both entrypoints may be used inside an application-owned Node Worker, including
with directory storage. Close the database before terminating that Worker.
Abruptly terminating a caller-owned realm can leave the fail-closed filesystem
lock behind; remove that lock only after establishing that no thread or process
still owns the database. `/worker` can recover its own child-Worker lock while
its importing realm remains alive.

`close()` is one terminal, idempotent teardown attempt. It stops admitting new
work and lets work already accepted by the database FIFO finish. `/worker`
applies a bounded orderly-shutdown deadline; after it expires, close requests
forced Worker termination and waits for it to settle before releasing other
owned resources. The direct root closes its caller-realm guest and storage
lease without a transport to terminate. Concurrent and later calls return the
same promise. Provider, host, and Worker termination failures are preserved.
If teardown rejects, `closed` still becomes `true`: cleanup was attempted and
a destroyed Worker or guest is never treated as a retryable live session.
An unexpected `/worker` crash also makes `closed` true as soon as the transport
observes ownership loss. Later operations fail without posting more work;
`close()` remains idempotent and reports that terminal transport failure while
finishing any remaining package-owned cleanup.

Forgetting a database handle schedules generation-guarded best-effort cleanup.
The root entrypoint closes only that caller-realm guest and its storage lease;
`/worker` force-terminates only that handle's Worker generation. A stale
finalizer cannot affect a later open. Finalizers are not prompt or observable,
so applications must still use `close()` or `await using` when ownership
release matters.

## Backup and restore

<!-- liboliphaunt-doc-example:wasix-typescript-backup-restore -->
```ts
const backup = await database.backup();
await database.close();

await Oliphaunt.restore(directory('./data/restored'), backup);
```

`backup()` performs PostgreSQL online physical backup without replacing the
session. The archive is the shared strict ustar format containing
`pgdata/**` and `.oliphaunt/backup-manifest.properties`. `restore` accepts only
an absent or empty persistent destination, validates the complete archive
before publication, and creates the receiving storage provider's outer
identity. The root entrypoint performs restore in the importing realm;
`/worker` uses a temporary package Worker.

## Extensions

Import package-authored WASIX extension descriptors and pass them at open:

<!-- liboliphaunt-doc-example:wasix-typescript-extensions -->
```ts
import Oliphaunt from '@oliphaunt/wasix-ts';
import pgtap from '@oliphaunt/extension-pgtap-wasix';

await using database = await Oliphaunt.open({ extensions: [pgtap] });
await database.execute('CREATE EXTENSION pgtap');
const version = await database.query('select pgtap_version()');
```

The binding verifies each carrier and its declared dependencies, installs
artifacts before startup, and applies required startup/preload settings. It does
not run database-local `CREATE EXTENSION`, `LOAD`, schema, post-create, upgrade,
or migration SQL. Applications and ORM migrations own those ordinary PostgreSQL
statements explicitly; selecting a carrier makes its code available but leaves
the extension uninstalled in the database.

## Calling shape and execution placement

The normal import executes PostgreSQL directly in the importing realm:

<!-- liboliphaunt-doc-example:wasix-typescript-direct-entrypoint -->
```ts
import Oliphaunt from '@oliphaunt/wasix-ts';

await using database = await Oliphaunt.open();
```

Use the explicit Worker import when the importing realm must remain responsive:

<!-- liboliphaunt-doc-example:wasix-typescript-worker-entrypoint -->
```ts
import WorkerOliphaunt from '@oliphaunt/wasix-ts/worker';

await using database = await WorkerOliphaunt.open();
```

Both imports expose the same PostgreSQL interface and return Promises because
asset loading and persistence are asynchronous. On the root entrypoint, the
guest portion of each operation nevertheless runs in the importing realm and
can monopolize that JavaScript agent while it is active. A Promise does not
imply off-thread execution. Importing the root from an application Worker blocks
only that Worker; importing it in a Window can block the page. `/worker`
uses a Web Worker in browsers and `node:worker_threads` in Node, Bun, and Deno.
Browser use requires cross-origin isolation. Chromium Window compilation of
native side modules larger than 8 MiB requires `/worker`.

## Optional PostgreSQL tools

Install `@oliphaunt/wasix-tools` when the application needs standard plain
`pg_dump` or non-interactive `psql`:

<!-- liboliphaunt-doc-example:wasix-typescript-tools -->
```ts
import Oliphaunt from '@oliphaunt/wasix-ts';
import WorkerOliphaunt from '@oliphaunt/wasix-ts/worker';
import { pgDump, psql } from '@oliphaunt/wasix-tools';

await using source = await Oliphaunt.open();
const sql = await pgDump(source, { args: ['--schema-only'] });
await using target = await WorkerOliphaunt.open();
await psql(target, { script: sql });
```

`pgDump()` runs in the database's existing realm, so it supports the root and
`/worker` entrypoints, including browsers. `psql()` requires a database opened
through `/worker` because restoring COPY input is full duplex. The package
preserves PostgreSQL's normal plain SQL and COPY output. It does not support
interactive psql, custom dump archives, parallel jobs, or pg_restore.

## Optional local server

Node, Bun, and Deno may import `openServer` from the matching server subpath:

<!-- liboliphaunt-doc-example:wasix-typescript-server -->
```ts
import { openServer } from '@oliphaunt/wasix-ts/server/node';

await using server = await openServer({
  listen: { transport: 'tcp' },
});
console.log(server.connectionString);
```

The lightweight compatibility endpoint binds IPv4 loopback with an automatic
port when `port` is omitted. Unix hosts may instead pass
`{ transport: 'unix', directory, port? }`; the socket follows PostgreSQL's
`.s.PGSQL.<port>` convention. One complete client connection owns the single
embedded backend at a time; concurrent connections are rejected. Server
subpaths own their required managed Worker independently of the root database
entrypoint. The listener
and storage lease persist, while each admitted client receives a fresh backend.
Use the separate WASIX postmaster product for concurrent PostgreSQL sessions.
The server's read-only `closed` property remains `false` while terminal teardown
is running and becomes `true` when that memoized attempt settles, including when
cleanup rejects.

## Scope

The core database surface remains limited to open, execute/query/queryRaw,
exec/describe, buffered and callback-streamed raw protocol, callback
transaction, physical backup/restore, read-only `closed`, and close.
Tools and local sockets stay in optional packages or host-only subpaths.
Cancellation and a dedicated typed COPY reader/writer are not exposed today.

## Qualification

```sh
pnpm --dir src/bindings/wasix-ts typecheck
pnpm --dir src/bindings/wasix-ts test
pnpm --dir src/bindings/wasix-ts package:check
```

Runtime carrier and browser/Node/Bun/Deno host smokes are defined in the package's
Moon tasks.
