# Oliphaunt React Native SDK

`@oliphaunt/react-native` embeds PostgreSQL 18 on the React Native New
Architecture. It presents the same deliberate database vocabulary as the other
native SDKs while using platform-native storage and lifecycle adapters.

## Setup and use

Install the SDK and any external extension dependencies, then rebuild the native app:

```sh
npm install @oliphaunt/react-native @oliphaunt/extension-vector
```

React Native shares `@oliphaunt/extension-vector` with native Node. With Expo,
add the config plugin; it reads installed dependencies and versions:

```json
{
  "expo": {
    "plugins": ["@oliphaunt/react-native"]
  }
}
```

Use the directory supplied by your platform filesystem API. For example, with
Expo FileSystem:

```typescript
import { Directory, Paths } from 'expo-file-system';
import Oliphaunt, { directory, extensions } from '@oliphaunt/react-native';
import vector from '@oliphaunt/extension-vector';

const db = await Oliphaunt.open({
  storage: directory(new Directory(Paths.document, 'postgres').uri),
  startupGUCs: { application_name: 'my-app' },
  extensions: [vector, extensions.hstore],
});
try {
  await db.execute('CREATE EXTENSION vector');
  await db.execute('CREATE EXTENSION hstore');
} finally {
  await db.close();
}
```

`directory` accepts a native path or local file URI. Omit storage for an SDK-owned
temporary directory. Restore accepts a persistent directory destination, such as
`Oliphaunt.restore(directory(restoredDirectoryUri), bytes)`.

Contrib ships with the SDK but must be selected explicitly. For ICU collations,
install `@oliphaunt/icu`, import its default `icu` value, and pass `icu` when
opening. The plugin packages installed resources; each database selects its own
extensions and ICU option. There is no repeated plugin extension list or ICU flag.
Native dependency changes require a native rebuild, including when using Metro.

`username` selects an existing PostgreSQL role. New roots start with `postgres`;
create other roles before reopening the root as them.

## API contract

`execute` returns command metadata. `query` defaults to decoded object rows,
supports positional array rows and per-query OID codecs, and retains fields,
notices, PostgreSQL's command tag, and nullable row count. `queryRaw` exposes
ordered nullable bytes and complete field metadata. Object mode rejects
duplicate field names; use `rowMode: 'array'` to preserve them positionally.
Parameter values use the
language-native TypeScript union, typed helpers, or immutable per-query
encoders; SQL errors are structured `PostgresError` instances.

The database also exposes ordered multi-statement `exec`, non-executing
`describe`, callback `transaction`, out-of-band `cancel`, buffered
`execProtocolRaw`, callback `execProtocolRawStream`, byte `backup`, a
read-only `closed` state, idempotent `close`, and `Symbol.asyncDispose`. The
stream contains raw PostgreSQL backend frames; there is no capability object,
supported-mode list, package-size report, or runtime profile.
Chunk callbacks are synchronous backpressure boundaries: they must not return
a Promise or thenable and must not reenter the same database or transaction.
Use `cancel()` for the one supported out-of-band callback action.

Transactions pin the one physical session and mirror query, raw query, execute,
exec, and describe. Explicit `rollback()` is one-shot, closes the transaction
handle, and lets the callback return without a later commit. Callback failure
rolls back and a failed rollback poisons the database. COMMIT uncertainty is
never followed by a misleading ROLLBACK.

After a successful automatic rollback, the original callback value is rethrown
unchanged. If the callback and rollback both fail, an `AggregateError` preserves
the callback failure followed by the rollback failure. If an earlier independent
database or protocol failure has already poisoned or expired transaction
ownership and the callback then throws a different value, an `AggregateError`
preserves the callback failure followed by that database failure; the database
is close-only. An ordinary PostgreSQL statement error that remains safely
rollbackable is not automatically aggregated.

Raw protocol is database-only and deliberately absent from a callback
transaction. Do not issue manual `BEGIN`, `START TRANSACTION`, `COMMIT`, `END`,
`ABORT`, `PREPARE TRANSACTION`, or `AND CHAIN` inside the callback; return/throw
or call `rollback()` instead. `SAVEPOINT` and `ROLLBACK TO` are supported.
`ROLLBACK AND CHAIN` is unsupported contract misuse and has the same PostgreSQL
wire tag/readiness state as `ROLLBACK TO`, so the SDK rejects `ROLLBACK`/`ABORT
... AND CHAIN` before dispatch and still validates every actual wire boundary.
A proven ownership escape makes the database close-only and never causes a
speculative SDK `COMMIT` or `ROLLBACK`.

## Backup and storage

Backup has one representation: PostgreSQL physical initialization bytes.
Restore requires an absent or empty destination and never replaces an existing
root. The payload contains PGDATA and backup metadata, not the outer
`.oliphaunt.json` descriptor. The receiving adapter validates PGDATA and creates
the descriptor last.

A persistent managed root contains `.oliphaunt.json` and `pgdata/`. The
descriptor's five fields are schema, engine family, PGDATA directory name,
PostgreSQL major, and physical format. It is not a platform marker or lock file.
Native admission rejects symlink structural directories and descriptorless
nonempty roots before mutation.

Apps own mobile lifecycle policy. Use `cancel` and `close` where the application
lifecycle requires them; the SDK does not expose a
background/resume state machine.

## Native boundaries and extensions

The TurboModule owns configuration and handle lifecycle. Every database and
archive operation returns a JavaScript promise; the JSI object only copies
`ArrayBuffer` bytes and registers completion callbacks, then delegates runtime
work to the Swift or Kotlin SDK's serial native owner. No PostgreSQL, filesystem,
close, or invalidation work runs synchronously on the JavaScript, iOS main, or
Android UI thread. Raw protocol streaming keeps one callback in flight: native
production resumes only after the JavaScript callback returns, and a thrown
callback error rejects the stream unchanged after native recovery reaches a
known PostgreSQL protocol boundary. If execution, transport, or recovery also
fails, that native failure is authoritative instead and poisons the database.
The recovered callback-only case leaves the handle reusable; a buffered raw
protocol rejection likewise poisons it because the session outcome is unknown.

Module invalidation stops callback delivery to the retiring JSI runtime and
schedules SDK close asynchronously. It does not wait synchronously for an open
or query to finish. A forgotten JavaScript database schedules best-effort close
for its exact process-unique native generation; stale cleanup cannot close a
newer session, and module invalidation remains the fallback. Explicit `close()`
is still the deterministic lifecycle API. `cancel()` remains available after
the close admission cutoff while earlier FIFO work drains and becomes
unavailable when native teardown starts. It is the explicit out-of-band interrupt;
cancelling a JavaScript promise by itself does not interrupt PostgreSQL.

iOS delegates to the Swift SDK and Android delegates to the Kotlin `Oliphaunt`
facade. Both use exact generated PostgreSQL extension names and selected package
artifacts. Runtime manifests, static registries, package reports, and link
evidence remain internal packaging concerns.

Run `pnpm typecheck`, `pnpm test`, and the platform package checks before
publishing. The Expo example is an executable smoke application, not an
additional public API layer.
