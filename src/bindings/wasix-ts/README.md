# Oliphaunt WASIX TypeScript SDK

Run PostgreSQL as WebAssembly in browsers, Node.js, Bun, Deno, or Electron. Use the Worker entrypoint in a browser to keep database execution off the UI thread.

## Install

```sh
npm install @oliphaunt/wasix-ts
```

Browser Workers require cross-origin isolation. Follow the [quickstart](https://oliphaunt.dev/docs/sdk/wasix-typescript) to configure the required response headers and bundler.

The [quickstart](https://oliphaunt.dev/docs/sdk/wasix-typescript) covers prerequisites and the versions documented by the current site. Pin dependencies in your application manifest or lockfile.

## First query

```ts
import Oliphaunt from '@oliphaunt/wasix-ts';

const db = await Oliphaunt.open();
try {
  const result = await db.query('SELECT $1::int4 AS answer', [42]);
  console.log(result.rows[0]?.answer); // 42
} finally {
  await db.close();
}
```

Default storage is a memory filesystem and is discarded on close. Use the quickstart's persistent-storage example for application data; run it as an alternative to this disposable example. Always close database handles explicitly.

## Build your integration

- [Guide](https://oliphaunt.dev/docs/sdk/wasix-typescript/guide): parameters, transactions, extensions, backups, and shutdown.
- [API reference](https://oliphaunt.dev/docs/sdk/wasix-typescript/api-reference): methods, configuration, results, and errors.
- [Runtime support](https://oliphaunt.dev/docs/reference/capabilities): platforms, storage, and concurrency.
- [Releases and upgrades](https://oliphaunt.dev/docs/reference/releases): dependency and database upgrades.
