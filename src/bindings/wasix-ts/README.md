# `@oliphaunt/wasix-ts`

Portable PostgreSQL 18 for TypeScript, backed by the canonical
`liboliphaunt-wasix` guest. The same API runs in browsers, Node.js, Bun, and
Deno. Worker execution is the default; direct execution is available when
blocking the caller's JavaScript realm is acceptable.

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
console.log(result.getText(0, 'title'));
```

`execute` accepts commands that do not return rows and produces a
`CommandResult`. `query` accepts one row-producing statement and produces a
typed `QueryResult`. Both support PostgreSQL positional parameters. Binary
values remain `Uint8Array`; text decoding is explicit through `row.text()` or
`result.getText()`.

`execProtocolRaw` is the buffered PostgreSQL frontend-protocol escape hatch.
`execProtocolStream` delivers the same response through a synchronous callback
with bounded backpressure, so COPY-sized responses need not be retained as one
JavaScript value. Neither method interprets responses for the caller.

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
boundary. Use the callback handle inside it; database-level operations reject
while the transaction is active.

Callback failures trigger a best-effort `ROLLBACK`. Once `COMMIT` has been
sent, the binding never sends a second rollback. PostgreSQL's clean `ROLLBACK`
response is a known aborted outcome; a transport failure or malformed response
after `COMMIT` makes the outcome unknown and poisons the handle until close.
Persistent publication completes before a successful transaction resolves.

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
in one transaction. OPFS uses direct synchronous backing files in worker
execution and the same opaque format through a copy-on-write portable path
elsewhere. Both OPFS paths flush or publish in PostgreSQL-safe order. A
publication failure rejects with `WasixStorageError`; an uncertain state
poisons the live database handle.

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
identity.

## Extensions

Import package-authored WASIX extension descriptors and pass them at open:

<!-- liboliphaunt-doc-example:wasix-typescript-extensions -->
```ts
import Oliphaunt from '@oliphaunt/wasix-ts';
import pgtap from '@oliphaunt/extension-pgtap-wasix';

await using database = await Oliphaunt.open({ extensions: [pgtap] });
const version = await database.query('select pgtap_version()');
```

The binding verifies each carrier and its declared dependencies, installs
artifacts before startup, applies required startup settings, and runs declared
setup SQL. It does not infer extension upgrades or migrations for an existing
database.

## Execution placement

<!-- liboliphaunt-doc-example:wasix-typescript-direct-placement -->
```ts
const direct = await Oliphaunt.open({ execution: 'direct' });
```

`worker` and `direct` return the same public database interface. Direct mode
blocks its JavaScript realm during PostgreSQL work. Browser direct mode also
requires cross-origin isolation; large synchronous side-module compilation may
require worker placement.

## Optional PostgreSQL tools

Install `@oliphaunt/wasix-tools` when the application needs standard plain
`pg_dump` or non-interactive `psql`:

<!-- liboliphaunt-doc-example:wasix-typescript-tools -->
```ts
import Oliphaunt from '@oliphaunt/wasix-ts';
import { pgDump, psql } from '@oliphaunt/wasix-tools';

await using source = await Oliphaunt.open();
const sql = await pgDump(source, { args: ['--schema-only'] });
await using target = await Oliphaunt.open();
await psql(target, { script: sql });
```

`pgDump()` runs in the database's existing realm, so it supports both direct
and worker placement, including browsers. `psql()` requires worker placement
because restoring COPY input is full duplex. The package preserves
PostgreSQL's normal plain SQL and COPY output. It does not support interactive
psql, custom dump archives, parallel jobs, or pg_restore.

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
embedded backend at a time; concurrent connections are rejected. The listener
and storage lease persist, while each admitted client receives a fresh backend.
Use the separate WASIX postmaster product for concurrent PostgreSQL sessions.

## Scope

The core database surface remains limited to open, execute/query, buffered and
callback-streamed raw protocol, checkpoint, callback transaction, physical
backup/restore, and close. Tools and local sockets stay in optional packages or
host-only subpaths. Cancellation and a dedicated typed COPY reader/writer are
not exposed today.

## Qualification

```sh
pnpm --dir src/bindings/wasix-ts typecheck
pnpm --dir src/bindings/wasix-ts test
pnpm --dir src/bindings/wasix-ts package:check
```

Runtime carrier and browser/Node/Bun/Deno host smokes are defined in the package's
Moon tasks.
