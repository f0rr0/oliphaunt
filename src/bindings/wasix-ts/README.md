# `@oliphaunt/wasix-ts`

Portable PostgreSQL 18 for TypeScript. Browser conditions run the canonical
`liboliphaunt-wasix` guest through the patched Wasmer JavaScript host. Node.js,
Bun, Deno, and Electron conditions run the same WASIX runtime through a Rust
Oliphaunt Node-API addon. The public TypeScript API is shared by both hosts.

In browsers the root owns PostgreSQL in the importing JavaScript realm. On
native hosts the root uses a dedicated Rust owner thread. The explicit
`/direct` import runs synchronously in the importing realm, while `/worker`
uses a separate JavaScript Worker on every runtime.

## Install

```sh
pnpm add @oliphaunt/wasix-ts
```

The published SDK is one universal browser-and-server package. Its browser host
files and exact `@oliphaunt/liboliphaunt-wasix` dependency are therefore
installed on Node.js, Bun, Deno, and Electron too, although native export
conditions never load them. The matching target-filtered optional platform
package embeds the runtime, both cluster profiles, tools, and qualified
extension catalog used on those hosts. Carrier packages have no install scripts
and do not download a binary at install or first use. Applications do not
configure raw runtime assets.

Published Node-API 8 carriers currently cover:

- macOS arm64;
- Linux arm64 and x64 with glibc; and
- Windows x64 with MSVC.

There is no published carrier yet for macOS x64, Linux musl, or Windows arm64.
The native loader detects Linux libc before resolving a carrier and explicitly
rejects musl or an unidentifiable libc; it cannot load a `-gnu` carrier through
an override on an unsupported host. Opening a database on another server target
fails with an explicit unsupported-platform error rather than falling back to
the browser Wasmer host.

Deno must resolve the npm package through a local `node_modules` directory and
must be granted `--allow-ffi`, `--allow-read`, and `--allow-env` in addition to any filesystem
permissions the application needs. The `/worker` entrypoint uses Deno's
Node-compatible Worker implementation and does not spawn a process. The package
smoke uses explicit host permissions. The qualified Deno surface is
the Deno CLI version declared by this package; managed Deno Deploy is not
currently a qualified distribution target.

Electron applications that use ASAR should leave `**/prebuilds/**` unpacked and
ship the generated `app.asar.unpacked` directory beside `app.asar`. This keeps
the addon and any platform loader companions, including the Windows app-local
VC runtime, in one loadable directory. Electron can temporarily extract a
packed native module, but the unpacked layout avoids that startup overhead and
antivirus interaction. Carrier qualification loads the addon from this
packaged layout and proves that a missing unpacked companion fails explicitly.

Optional ICU data and its matching `icu` seed are selected explicitly:

<!-- liboliphaunt-doc-example:wasix-typescript-icu -->
```ts
import Oliphaunt from '@oliphaunt/wasix-ts';
import icu from '@oliphaunt/wasix-icu';

await using database = await Oliphaunt.open({ icu });
```

Browser conditions load the ICU assets from their portable carrier. Each
native platform carrier contains one addon with both `standard` and `icu`
profiles, and the existing `icu` option selects the database profile. The loader checks
the exact SDK/carrier version, WASIX runtime version, addon ABI, Node-API level,
target, and ICU profile before running native code.

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
`execProtocolRawStream` delivers the same response through a synchronous
callback. Every surface invokes it serially with at most 64 KiB per chunk and
waits for it to return before producing the next chunk. Direct sessions invoke
the callback inline; the native actor and Worker paths use bounded
acknowledgements across their existing thread boundary. COPY-sized responses
therefore need not be retained as one JavaScript value. A thrown callback, including
the deterministic error for returning a Promise or thenable, is rethrown
unchanged only after the guest confirms recovery to `ReadyForQuery`; the
recovered database remains reusable. An asynchronous callback cannot provide
this backpressure contract.
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

A Node, Bun, Deno, or Electron directory is a managed root with exactly:

```text
.oliphaunt.json
pgdata/
```

The descriptor records the shared database-root schema, PostgreSQL major, and
WASIX physical format. Runtime source fingerprints and package hashes validate
the asset graph; they are not physical-reopen identity. Native and WASIX roots
are not rejected merely because of the originating family.

Rust and WASIX TypeScript bindings use the same root and physical-archive
contracts. On Node.js, Bun, Deno, and Electron the Rust runtime holds the managed
root's OS advisory lock for the database lifetime. The same lock protects actor,
direct, Worker, and Rust owners. Always close the current owner before handing a
root to another process, Worker, or binding.

The Rust host owns directory durability for Node.js, Bun, Deno, and Electron. IndexedDB
publishes a delta in one transaction. OPFS uses synchronous backing files for
`/worker` and when the root entrypoint is imported inside an application-owned
Dedicated Worker.
The root entrypoint in a browser Window uses the same opaque format through a
copy-on-write portable path. Both OPFS paths flush or publish in
PostgreSQL-safe order. A
publication failure rejects with `WasixStorageError`; an uncertain state
poisons the live database handle.

All native-host entrypoints may be used inside an application-owned Worker,
including with directory storage. Close the database before terminating that
Worker. The lock is owned by the Rust runtime rather than a JavaScript marker
directory, and an orderly package Worker close waits for native quiescence,
posts its terminal reply, and then lets the Worker exit itself.

`close()` is one terminal, idempotent teardown attempt. It stops admitting new
work and lets work already accepted by the database FIFO finish. The root actor
and `/server` await their Rust owner teardown. `/direct` closes synchronously at
the native boundary. `/worker` closes its direct native session at quiescence,
replies, and self-exits; it is never force-terminated across an active Node-API
frame. Concurrent and later calls return the same promise. Provider, host, and
Worker transport failures are preserved.
If teardown rejects, `closed` still becomes `true`: cleanup was attempted and
a destroyed isolated owner or guest is never treated as a retryable live session.
An unexpected `/worker` crash also makes `closed` true as soon as the transport
observes ownership loss. Later operations fail without posting more work;
`close()` remains idempotent and reports that terminal transport failure while
finishing any remaining package-owned cleanup.

Forgetting a database handle schedules generation-guarded best-effort cleanup
of only that handle's actor, direct session, or Worker generation. A stale
finalizer cannot affect a later open. Finalizers are not prompt or observable,
so applications must still use `close()` or `await using` when ownership release
matters.

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
identity. Browser root restores in its importing realm. On native hosts the
root uses the Rust owner actor, `/direct` restores on the importing JavaScript
thread, and `/worker` uses a temporary package-owned Worker.

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

The call shape and lifecycle ownership are host-independent. A browser verifies
the selected carrier and its dependency closure, installs its artifacts before
startup, and applies required startup/preload settings. Node.js, Bun, Deno, and Electron
validate the same descriptor but resolve its SQL name against the extension
catalog compiled into the platform addon. Release addons contain the complete
currently supported extension catalog; they do not load arbitrary side-module
bytes from npm at runtime. Adding or upgrading a server extension therefore
requires a matching N-API carrier release. This increases the carrier size in
exchange for eliminating runtime archive expansion and dynamic linking on the
native path.

Neither host runs database-local `CREATE EXTENSION`, `LOAD`, schema,
post-create, upgrade, or migration SQL. Applications and ORM migrations own
those ordinary PostgreSQL statements explicitly; selecting a descriptor makes
its code available but leaves the extension uninstalled in the database.

## Calling shape and execution placement

The normal import keeps the public API consistent while selecting the safest
default placement for the host:

<!-- liboliphaunt-doc-example:wasix-typescript-root-entrypoint -->
```ts
import Oliphaunt from '@oliphaunt/wasix-ts';

await using database = await Oliphaunt.open();
```

On Node.js, Bun, Deno, and Electron, use `/direct` only when the lowest-hop path
is more important than keeping the importing event loop responsive:

<!-- liboliphaunt-doc-example:wasix-typescript-direct-entrypoint -->
```ts
import DirectOliphaunt from '@oliphaunt/wasix-ts/direct';

await using database = await DirectOliphaunt.open();
```

Use the explicit Worker import when a separate JavaScript realm is part of the
application's isolation or placement model:

<!-- liboliphaunt-doc-example:wasix-typescript-worker-entrypoint -->
```ts
import WorkerOliphaunt from '@oliphaunt/wasix-ts/worker';

await using database = await WorkerOliphaunt.open();
```

All imports expose the same PostgreSQL interface and retain the promise-shaped
public API. A Promise does not itself imply off-thread execution. In a browser,
the root steps the Wasmer guest in the importing realm. On native hosts, the
root uses one Rust owner actor so PostgreSQL does not block the importing event
loop. `/direct` calls the synchronous Rust database on the importing thread and
removes that actor hop. `/worker` uses a real package-owned JavaScript Worker on
every runtime and loads the direct implementation inside it.

Importing the browser root or `/direct` from an application Worker blocks only
that Worker; importing the browser root in a Window can block the page. Browser
Worker use requires cross-origin isolation. Chromium Window compilation
of native side modules larger than 8 MiB requires `/worker`.

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

`pgDump()` runs with the database's existing owner, so it supports root,
`/direct`, and `/worker` entrypoints where available. In browsers, `psql()` requires `/worker`
because restoring COPY input is full duplex. Node.js, Bun, Deno, and Electron route both
tools through the frontend binaries compiled into the native carrier, so
`psql()` works with root, `/direct`, and `/worker` on those hosts. The optional
`@oliphaunt/wasix-tools` package remains the public opt-in API even though the
native carrier includes the tool code at build time. Adding or changing a tool
requires a matching N-API carrier release.

The package preserves PostgreSQL's normal plain SQL and COPY output. It does
not support interactive psql, custom dump archives, parallel jobs, or
pg_restore.

## Optional local server

Node, Bun, Deno, and Electron may import `openServer` from the shared host-only server
subpath. Package export conditions select the runtime; browsers cannot resolve
this entrypoint:

<!-- liboliphaunt-doc-example:wasix-typescript-server -->
```ts
import { openServer } from '@oliphaunt/wasix-ts/server';

await using server = await openServer({
  listen: { transport: 'tcp' },
});
console.log(server.connectionString);
```

The lightweight compatibility endpoint binds IPv4 loopback with an automatic
port when `port` is omitted. Unix hosts may instead pass
`{ transport: 'unix', directory, port? }`; the socket follows PostgreSQL's
`.s.PGSQL.<port>` convention. One complete client connection owns the single
embedded backend at a time; another connection may wait in the operating-system
backlog, so configure client pools with a maximum size of one. The server
entrypoint wraps the Rust `OliphauntServer` directly; it does not create a
JavaScript socket relay or managed Worker. The listener and storage lease
persist, while each admitted client receives a fresh backend.
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
pnpm --dir src/runtimes/wasix-napi check
```

Runtime carrier and browser/Node/Bun/Deno/Electron host smokes are defined in the
packages' Moon tasks. Native-host smokes install the packed SDK and matching
packed optional carrier into a fresh external project; they never use a
developer-machine adjacent addon as the release proof.
