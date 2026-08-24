# Oliphaunt TypeScript SDK

`@oliphaunt/ts` embeds PostgreSQL 18 on Node.js, Bun, and Deno through the native
`liboliphaunt` runtime. It is the native TypeScript SDK; browser and WASIX hosts
use the separate WASIX TypeScript package.

## Open and query

<!-- liboliphaunt-doc-example:typescript-open-query -->
```ts
import Oliphaunt from '@oliphaunt/ts';

const db = await Oliphaunt.open({
  storage: { kind: 'directory', path: '.oliphaunt' },
  startupGUCs: { application_name: 'my-app' },
});

await db.execute('CREATE TABLE events(value text)');
await db.execute('INSERT INTO events(value) VALUES ($1)', ['ready']);
const result = await db.query('SELECT value FROM events');
console.log(result.rows[0]?.text(0));
await db.close();
```

Direct execution is the default. Set `execution: 'broker'` to place the embedded
backend in a helper process while keeping the same database API.

The deliberate public vocabulary is:

- `Oliphaunt.open(config)` for direct or broker databases.
- `execute`, `query`, callback `transaction`, `checkpoint`, `cancel`, and
  `close`.
- `execProtocolRaw` as the buffered escape hatch for protocol flows the typed
  helpers cannot represent.
- `execProtocolStream` for callback delivery of raw backend protocol chunks,
  including COPY responses, without buffering the complete response.
- `backup()` returning the one physical backup format as `Uint8Array`.
- `Oliphaunt.restore(destination, bytes)` for an absent or empty destination.
- `Oliphaunt.openServer(config)` for the distinct local-server handle.

`execute` returns a `CommandResult`; `query` returns fields and rows in a
`QueryResult`. Both expose the PostgreSQL command tag and row count reported by
PostgreSQL. Parameter values may be text, binary bytes, `null`, numbers, or
booleans. PostgreSQL ErrorResponse fields are exposed through `PostgresError`.

Transactions pin the one SDK-owned session. Callback failure rolls back. A
failed rollback poisons the handle. A transport failure at COMMIT is uncertain,
so the SDK never follows it with a misleading ROLLBACK and requires close.
PostgreSQL's explicit `COMMIT` → `ROLLBACK` command tag is the known idle-session
exception.

## Backup and restore

<!-- liboliphaunt-doc-example:typescript-backup-restore -->
```ts
const source = await Oliphaunt.open({
  storage: { kind: 'directory', path: '.oliphaunt-source' },
});
const bytes = await source.backup();
await source.close();

await Oliphaunt.restore('.oliphaunt-restored', bytes);
```

Backup bytes are a PostgreSQL physical initialization payload containing PGDATA
and backup metadata. They do not contain the outer `.oliphaunt.json` descriptor.
Restore stages and validates PGDATA, then creates the receiving root identity.
There is no archive selector and no replace-existing option.

## Local server

<!-- liboliphaunt-doc-example:typescript-open-server -->
```ts
const server = await Oliphaunt.openServer({
  storage: { kind: 'directory', path: '.oliphaunt-server' },
  listen: { transport: 'tcp' },
});
console.log(server.connectionString);
await server.close();
```

The server handle has the same execute, query, transaction, raw protocol,
checkpoint, cancellation, and close methods, but no SDK backup method. TCP is
fixed to IPv4 loopback; omit `port` for automatic assignment. Unix hosts may
instead pass `{ transport: 'unix', directory, port? }`, which uses
`.s.PGSQL.<port>` and never removes the caller's directory.

Use `pg_basebackup` for a standard server physical backup. Plain `pg_dump` and
non-interactive `psql` are available from the optional endpoint-oriented
`@oliphaunt/tools` package. `@oliphaunt/ts` does not depend on or install client
tools.

```js
import { pgDump, psql } from '@oliphaunt/tools';

const sql = await pgDump(server.connectionString, {
  args: ['--schema-only'],
});
await psql(server.connectionString, { script: sql });
```

Pass the server's `connectionString` to the standard PostgreSQL tool:

```sh
pg_basebackup --dbname "$CONNECTION_STRING" --pgdata ./server-backup --wal-method=stream
```

## Storage contract

A persistent managed root contains:

```text
.oliphaunt.json
pgdata/
```

The descriptor's exact five fields record its schema, engine family, PGDATA
directory name, PostgreSQL major, and physical format. It is shared contract
vocabulary, not a TypeScript or Node marker. Root validation occurs before
mutation, rejects symlink structural directories, requires complete PostgreSQL
18 PGDATA, and publishes the descriptor last.

Direct and broker share the native C sibling lease. The server provider prevents
duplicate server ownership separately. These are provider-local lifecycle
safeguards, not a public cross-provider lock protocol. Simultaneous
direct/broker/server mutation of one root is application error.

If server open reports an existing sibling owner directory, first confirm that
no native server owns the root. Only then remove the exact reported directory;
the SDK deliberately does not guess that an owner is stale.

## Runtime and extensions

Platform native runtime, Node addon, broker, and ICU packages are optional
dependencies selected for the installed host. Explicit library, runtime, addon,
broker, or server paths exist for packaging and development scenarios. Native
client-tool packages remain separate products and are not SDK dependencies.

Extensions are selected by exact PostgreSQL SQL name through `extensions`.
Runtime artifact discovery remains internal. The package intentionally does not
publish capability profiles, supported-mode introspection, package-size reports,
generic streams, protocol parsers, or backup format helpers.

The package has one public code entrypoint, `@oliphaunt/ts`, plus
`@oliphaunt/ts/package.json` for package metadata.
