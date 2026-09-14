# Oliphaunt TypeScript SDK

`@oliphaunt/ts` embeds PostgreSQL 18 on Node.js, Bun, and Deno through the native
`liboliphaunt` runtime. It is the native TypeScript SDK; browser and WASIX hosts
use the separate WASIX TypeScript package.

## Open and query

```ts
import Oliphaunt from '@oliphaunt/ts';

const db = await Oliphaunt.open({
  storage: { kind: 'directory', path: '.oliphaunt' },
  startupGUCs: { application_name: 'my-app' },
});

await db.execute('CREATE TABLE events(value text)');
await db.execute('INSERT INTO events(value) VALUES ($1)', ['ready']);
const result = await db.query('SELECT value FROM events');
console.log(result.rows[0]?.value);
await db.close();
```

Direct topology is the default. Set `topology: 'broker'` to place the embedded
backend in a helper process while keeping the same database API. If that helper
fails, the database object fails permanently; close it and explicitly open a new
object on persistent storage for PostgreSQL WAL recovery. The SDK never swaps a
new session under an existing object or replays uncertain work.

Runtime packages contain neither cluster seeds nor ICU data. A new database
uses the runtime's `initdb` unless you select a seed explicitly. Existing roots
do not read the selected seed again. Native seed packages expose an unpacked
directory; the SDK verifies its receipt and contents before initializing PGDATA:

```ts
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const seedPackage = '@oliphaunt/seed-native-linux-x64-gnu-standard';
const db = await Oliphaunt.open({
  seed: {
    directory: dirname(require.resolve(`${seedPackage}/pgdata/PG_VERSION`)),
    manifestPath: require.resolve(`${seedPackage}/manifest.json`),
  },
});
```

Choose the seed package for the host target. For an ICU catalog, select its
`-icu` seed and pass `icuData: { directory:
dirname(require.resolve('@oliphaunt/icu/data')), manifestPath:
require.resolve('@oliphaunt/icu/manifest') }`. The same ICU data may be selected
without a seed. Both direct and broker topology accept these inputs. Server mode
accepts ICU data and uses PostgreSQL `initdb`; embedded seeds are not server seeds.

The database API is promise-based on Node.js, Bun, and Deno. Native PostgreSQL
work runs in Rust addon jobs on Node/Bun and nonblocking FFI on Deno. Deno's
addon path passes ordinary database operations but still fails Worker teardown
with a queued stream callback, so its FFI adapter remains until that is fixed.
First adapter resolution performs a synchronous native-module load
(`require()` on Node/Bun, `dlopen()` on Deno); that narrow
startup step is not a synchronous database execution mode.

The deliberate public vocabulary is:

- `Oliphaunt.open(config)` for direct or broker databases.
- `execute`, decoded `query`, byte-preserving `queryRaw`, ordered `exec`,
  non-executing `describe`, callback `transaction`, `cancel`, and `close`.
- `execProtocolRaw` as the buffered escape hatch for protocol flows the typed
  helpers cannot represent.
- `execProtocolRawStream` for callback delivery of raw backend protocol chunks,
  including COPY responses, without buffering the complete response.
- `backup()` returning the one physical backup format as `Uint8Array`.
- `Oliphaunt.restore(destination, bytes)` for an absent or empty destination.
- `Oliphaunt.openServer(config)` for the distinct local-server handle.

`execute` asserts one command with no rows. `query` accepts command-only or
row-producing SQL and defaults to decoded object rows; use `rowMode: 'array'`
for positional rows or duplicate column names, `valueMode: 'text'` for
text-format strings, or per-query OID decoders. Object mode rejects duplicate
names rather than discarding a value. `queryRaw` retains ordered nullable bytes
and complete field metadata. `exec` returns each simple-query statement in wire order, and
`describe` returns resolved parameter OIDs and optional result fields without
executing. All structured results preserve notices and command metadata.

Safe scalar parameters are inferred inside one owned Parse/Describe/Bind
operation. Use the exported `text`, `binary`, `typedNull`, `json`, and `array`
helpers with `postgresOids` when the type must be deterministic, and immutable
per-query encoders for extension OIDs. Unsupported or mismatched values fail
instead of being guessed or stringified; `undefined` is never a SQL null.
PostgreSQL errors are structured `PostgresError` instances with query notices.

The read-only `closed` property becomes true whenever the owner is terminally
retired, including after a broker/server teardown error that occurs past its
destructive cutoff. Transactions pin the session and mirror query/raw query, execute, exec,
and describe. One-shot `rollback()` closes the transaction and lets the callback
return without committing. Failed rollback or COMMIT uncertainty poisons the
database and never triggers a misleading second control command.

When a callback throws, Oliphaunt waits for a successful automatic rollback and
then rethrows the original value unchanged. If the callback and rollback both
fail, the transaction rejects with an `AggregateError` whose `errors` are the
callback failure followed by the rollback failure. If an earlier independent
database or protocol failure has already poisoned or expired transaction
ownership and the callback then throws a different value, an `AggregateError`
preserves the callback failure followed by that database failure; the database
is close-only. An ordinary PostgreSQL statement error that remains safely
rollbackable uses the first rule and is not automatically aggregated.

Raw protocol is intentionally database-only and absent from callback transaction
handles. Inside a transaction callback, do not issue manual `BEGIN`, `START
TRANSACTION`, `COMMIT`, `END`, `ABORT`, `PREPARE TRANSACTION`, or `AND CHAIN`;
return/throw from the callback or call `rollback()` instead. `SAVEPOINT` and
`ROLLBACK TO` remain ordinary supported SQL. `ROLLBACK AND CHAIN` is unsupported
contract misuse and cannot be distinguished from `ROLLBACK TO` by PostgreSQL's
wire tag and readiness status, so Oliphaunt rejects `ROLLBACK`/`ABORT ... AND
CHAIN` before dispatch and still validates every actual protocol boundary. A
proven ownership escape makes the database close-only and the SDK sends no
follow-up `COMMIT` or `ROLLBACK`.

Always `await db.close()` or use `await using` for deterministic lifecycle.
Garbage collection is only a best-effort leak guard: on Node/Bun a
`FinalizationRegistry` gives the addon an opaque exact-generation token and only
releases JavaScript admission after the addon queues recovery for the next
asynchronous open. Deno's registry enqueues nonblocking generation-guarded
terminal cleanup. Broker and server registries retain only their exact private
runtime handle plus a private lease generation; finalizers schedule
asynchronous teardown and an unregistered or superseded generation is a no-op.
A stale cleanup
cannot close a newer logical lease, but finalizer timing and errors are not
observable and an executed fallback spends the native database process
lifetime. Explicit close remains the path that resets the logical session for
reuse and reports failures.

In direct mode, that reuse is for the same database root and startup configuration:
the physical backend remains bound to them until the host process exits. Open a
restored database in a fresh host process, or use broker mode for independently
owned database processes.

A direct logical-detach failure is retryable only while the native owner proves
it remains active. Broker/server teardown failures are terminal: later work is
rejected and every repeated `close()` observes the same original outcome.
Raw-stream callbacks are synchronous, cannot reenter database or transaction
work on the same handle, and may only use `cancel()` out of band. Once `close()`
stops ordinary admission, `cancel()` remains available while previously
admitted work drains; runtime teardown begins only after admitted cancellation
requests settle. A thrown callback is returned unchanged only after the runtime
confirms that it recovered the PostgreSQL protocol boundary. An execution,
transport, or recovery failure is authoritative instead and poisons the
session when its state is unknown.

## Backup and restore

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

```ts
const server = await Oliphaunt.openServer({
  storage: { kind: 'directory', path: '.oliphaunt-server' },
  listen: { transport: 'tcp' },
});
console.log(server.connectionString);
await server.close();
```

The server handle owns only the PostgreSQL process/listener lifecycle and exposes
its `connectionString`, `closed`, and `close`. Connect an ORM, PostgreSQL driver,
or tool with that URI; the resulting connections own their own queries,
transactions, raw protocol, and cancellation. The server handle cannot cancel
or otherwise control work on external clients. TCP is fixed to IPv4 loopback;
omit `port` for automatic assignment. Unix hosts may
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

Direct and broker coordinate through the same native sibling-lock identity. The
server provider prevents duplicate server ownership separately. These are
provider-local lifecycle safeguards, not a public cross-provider lock protocol.
Simultaneous direct/broker/server mutation of one root is application error.

If server open reports an existing sibling owner directory, first confirm that
no native server owns the root. Only then remove the exact reported directory;
the SDK deliberately does not guess that an owner is stale.

## Runtime and extensions

Platform native runtime, Node addon and broker packages are optional
dependencies selected for the installed host. Seeds and ICU data are explicit,
separate resource dependencies. Explicit library, runtime, addon,
broker, or server paths exist for packaging and development scenarios. Native
client-tool packages remain separate products and are not SDK dependencies.

Extensions are selected by exact PostgreSQL SQL name through `extensions`.
Runtime artifact discovery remains internal. The package intentionally does not
publish capability profiles, supported-mode introspection, package-size reports,
generic streams, protocol parsers, or backup format helpers.

The package has one public code entrypoint, `@oliphaunt/ts`, plus
`@oliphaunt/ts/package.json` for package metadata.

## Working on this package

After installing the workspace's pinned tools and running `bun install` at the
repository root, these commands work from this directory:

```sh
moon run oliphaunt-js:build
bun run format-check
bun run lint
bun run typecheck
bun run test
```

The build compiles the shared query package first. It does not build
PostgreSQL or the optional Node addon. `moon run oliphaunt-js:package`
creates and checks the final archive directly from the built SDK.
`bun run package` runs that recipe against already built inputs; `bun run format`
rewrites formatting, while `format-check` only checks it.
Installed-runtime tests are separate from these source and package checks.
`moon run oliphaunt-js:test-native` builds its native dependencies and runs
the built SDK on Node, Bun and Deno, including broker isolation, typed queries,
backup/restore and persistent reopen. It also checks server connections with
the PostgreSQL driver. `bun run test-native` uses already built dependencies.

`src/__tests__/native-resources-smoke.mts` exercises selected resources through
the public package API. Run it in a consumer that has the SDK, host seed package,
and (for ICU) `@oliphaunt/icu` installed. Set `OLIPHAUNT_RESOURCE_PROFILE` to
`none`, `standard`, or `icu`, `OLIPHAUNT_RESOURCE_SEED_PACKAGE` to the installed
host seed identity, and `OLIPHAUNT_RESOURCE_TOPOLOGY` to `direct` or `broker`.
Use a fresh `OLIPHAUNT_RESOURCE_SMOKE_ROOT` for each process and remove it after
the host exits. Explicit `LIBOLIPHAUNT_PATH`, `OLIPHAUNT_INSTALL_DIR`,
`OLIPHAUNT_NODE_ADDON`, and `OLIPHAUNT_BROKER` paths can select local built
artifacts. The same test runs with Node TypeScript stripping, Bun, or Deno
`run --allow-all`; it verifies queries, persisted reopen, and rejection of a
corrupt seed without publishing PGDATA.
