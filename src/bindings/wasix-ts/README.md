# `@oliphaunt/wasix-ts`

Portable PostgreSQL 18 for TypeScript, backed by the canonical
`liboliphaunt-wasix` guest. The same API runs in browsers, Node.js, Bun, and
Deno. Worker execution is the default; direct execution is available when
blocking the caller's JavaScript realm is acceptable.

## Install

```sh
pnpm add @oliphaunt/wasix-ts
```

The runtime and PGDATA template come from the matching
`@oliphaunt/liboliphaunt-wasix` carrier. Applications do not configure raw
runtime assets.

## Query PostgreSQL

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
It does not add streaming or interpret responses for the caller.

PostgreSQL `ErrorResponse` values reject with `PostgresError`, including the
SQLSTATE and structured diagnostic fields.

## Transactions

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
in one transaction. OPFS applies the same PostgreSQL-safe ordering. A
publication failure rejects with `WasixStorageError`; an uncertain state
poisons the live database handle.

## Backup and restore

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

```ts
const direct = await Oliphaunt.open({ execution: 'direct' });
```

`worker` and `direct` return the same public database interface. Direct mode
blocks its JavaScript realm during PostgreSQL work. Browser direct mode also
requires cross-origin isolation; large synchronous side-module compilation may
require worker placement.

## Scope

The public WASIX TypeScript surface is deliberately limited to open,
execute/query, raw buffered protocol, checkpoint, callback transaction,
physical backup/restore, and close. PostgreSQL tools, a socket server,
cancellation, and COPY streaming are not exposed by this binding today.

## Qualification

```sh
pnpm --dir src/bindings/wasix-ts typecheck
pnpm --dir src/bindings/wasix-ts test
pnpm --dir src/bindings/wasix-ts package:check
```

Runtime carrier and browser/Node/Bun/Deno host smokes are defined in the package's
Moon tasks.
