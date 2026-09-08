# Oliphaunt TypeScript SDK

Run native PostgreSQL in Node.js, Bun, Deno, or Electron. For browsers, choose [WASIX TypeScript](https://oliphaunt.dev/docs/sdk/wasix-typescript).

## Install

```sh
npm install @oliphaunt/ts
```

The [quickstart](https://oliphaunt.dev/docs/sdk/typescript) covers prerequisites and the versions documented by the current site. Pin dependencies in your application manifest or lockfile.

## First query

```ts
import { Oliphaunt } from '@oliphaunt/ts';

const db = await Oliphaunt.open();
try {
  const result = await db.query('SELECT $1::int4 AS answer', [42]);
  console.log(result.rows[0]?.answer); // 42
} finally {
  await db.close();
}
```

Default storage is a disposable temporary directory. Direct mode stays bound to its first root and configuration for the lifetime of the process, even after closing a handle. Use the quickstart's persistent-storage example for application data; run it as an alternative to this disposable example. Always close database handles explicitly.

## Build your integration

- [Guide](https://oliphaunt.dev/docs/sdk/typescript/guide): parameters, transactions, extensions, backups, and shutdown.
- [API reference](https://oliphaunt.dev/docs/sdk/typescript/api-reference): methods, configuration, results, and errors.
- [Runtime support](https://oliphaunt.dev/docs/reference/capabilities): platforms, storage, and concurrency.
- [Releases and upgrades](https://oliphaunt.dev/docs/reference/releases): dependency and database upgrades.

Native 0.2.0 currently fails fresh-database initialization on Linux x64 under Node.js and Bun with a data-directory permission error. See the [current quickstart](https://oliphaunt.dev/docs/sdk/typescript) and the working [WASIX alternative](https://oliphaunt.dev/docs/sdk/wasix-typescript).
