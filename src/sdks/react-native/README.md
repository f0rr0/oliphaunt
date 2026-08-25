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
    "plugins": [["@oliphaunt/react-native", { "icu": true }]]
  }
}
```

The plugin packages ICU data with the matching platform cluster seed; this is a
build-time choice and does not add a database-open option.

<!-- liboliphaunt-doc-example:react-native-open-query -->
```typescript
import { Oliphaunt } from '@oliphaunt/react-native';

const db = await Oliphaunt.open({
  storage: { kind: 'applicationData', name: 'primary' },
  startupGUCs: { application_name: 'my-app' },
});

await db.execute('CREATE TABLE events(value text)');
await db.execute('INSERT INTO events(value) VALUES ($1)', ['ready']);
const result = await db.query('SELECT value FROM events');
console.log(result.rows[0]?.text(0));

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

`execute` returns `CommandResult`; `query` returns `QueryResult` fields and rows.
Both expose PostgreSQL's command tag and nullable row count. Parameter values
use the language-native TypeScript union and SQL errors are structured
`PostgresError` instances.

The database also exposes callback `transaction`, `checkpoint`, out-of-band
`cancel`, buffered `execProtocolRaw`, callback `execProtocolStream`, byte
`backup`, idempotent `close`, and `Symbol.asyncDispose`. The stream contains raw
PostgreSQL backend frames; there is no separate public protocol parser,
capability object, supported-mode list, package-size report, or runtime profile.

Transactions pin the one physical session. Callback failure rolls back and a
failed rollback poisons the handle. COMMIT uncertainty is never followed by a
misleading ROLLBACK. PostgreSQL's explicit `COMMIT` → `ROLLBACK` command tag is
the known idle-session exception.

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

Apps own mobile lifecycle policy. Use ordinary `checkpoint`, `cancel`, and
`close` where the application lifecycle requires them; the SDK does not expose a
background/resume state machine.

## Native boundaries and extensions

The TurboModule owns configuration, open, cancellation, and close. A small JSI
object owns synchronous byte transfer for raw protocol, backup, and restore so
large binary payloads do not cross the JSON bridge. Raw protocol streaming uses
the same JSI boundary with one callback in flight: native production resumes
only after the JavaScript callback returns, and a thrown callback error rejects
the stream.

iOS delegates to the Swift SDK and Android delegates to the Kotlin `Oliphaunt`
facade. Both use exact generated PostgreSQL extension names and selected package
artifacts. Runtime manifests, static registries, package reports, and link
evidence remain internal packaging concerns.

Run `pnpm typecheck`, `pnpm test`, and the platform package checks before
publishing. The Expo example is an executable smoke application, not an
additional public API layer.
