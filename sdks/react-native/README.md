# Oliphaunt React Native SDK

`@oliphaunt/react-native` embeds PostgreSQL 18 on the React Native New
Architecture. It presents the same deliberate database vocabulary as the other
native SDKs while using platform-native storage and lifecycle adapters.

## Setup and use

Install the package, run CocoaPods for iOS, and apply the package's Expo config
plugin when using Expo prebuild. The supported platforms and packaged targets
are declared by the repository SDK manifest; the package does not advertise
future platform targets.

Enable PostgreSQL ICU collations through the Expo plugin only when the app needs
them:

```json
{
  "expo": {
    "plugins": [["@oliphaunt/react-native", { "seedProfile": "icu", "icu": true }]]
  }
}
```

Initialization seeds are optional dependencies owned by `database-resources`.
On Android, `seedProfile` selects the standard or ICU Maven seed; omit it when
opening an existing database or supplying application-owned seed resources.
On iOS, install exactly one `@oliphaunt/seed-native-ios-datum64-standard` or
`@oliphaunt/seed-native-ios-datum64-icu` npm package. Its resource-only CocoaPod
is autolinked into the application. `seedProfile` declares the selected resource
dependency in the app-owned podspec; omit it when using an existing database or
application-owned resources. An ICU profile also requires the separately installed
`@oliphaunt/icu` package. Its data bundle stays separate from the runtime payload;
the Swift initializer validates and uses it with the selected seed.
These are build-time choices and do not add a database-open option.

```typescript
import Oliphaunt from '@oliphaunt/react-native';

const db = await Oliphaunt.open({
  storage: { kind: 'applicationData', name: 'primary' },
  startupGUCs: { application_name: 'my-app' },
});

await db.execute('CREATE TABLE events(value text)');
await db.execute('INSERT INTO events(value) VALUES ($1)', ['ready']);
const result = await db.query('SELECT value FROM events');
console.log(result.rows[0]?.value);

const bytes = await db.backup();
await db.close();
await Oliphaunt.restore(
  { kind: 'applicationData', name: 'restored' },
  bytes,
);
```

`username` selects an existing PostgreSQL role. New roots are bootstrapped with
`postgres`; create other roles before reopening the root as them.

Storage is `temporaryDirectory`, an explicit `directory`, or an
`applicationData` name resolved by the native platform adapter. Restore accepts
only persistent directory/application-data destinations.

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

## Working on this package

After installing the workspace's pinned tools and workspace dependencies, run
from this directory:

```sh
moon run oliphaunt-react-native:build
bun run format-check
bun run lint
bun run typecheck
bun run codegen:check
bun run test
```

Moon builds the independently versioned query dependency before the SDK.
`moon run oliphaunt-react-native:package` assembles its distributable archive
and requires Apple carrier inputs. `moon run oliphaunt-react-native:test-consumer`
separately verifies packaged ICU autolinking. Neither is a prerequisite for
TypeScript tests. `bun run package` runs assembly against already built inputs.
Installed Android/iOS app tests live in the Expo example and require their
platform tools and runtime artifacts.

The platform bridges share JSI marshalling, promise settlement and stream acknowledgement code in `cpp/`. An installed runtime owns its pending callbacks and waits; invalidating or replacing that runtime releases blocked producers and prevents queued callbacks from touching its JavaScript objects. JNI and Objective-C conversions, storage, and platform process isolation stay in their respective adapters.

`bun run test-cpp` checks acknowledgement delivery and teardown races with a local C++17 compiler. `bun run typecheck`, `bun run test`, and `bun run build` cover the source package. These checks do not replace the installed Android/iOS Hermes and lifecycle tests; final release packaging also requires the prepared iOS carrier assets declared by its Moon task.
