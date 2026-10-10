# Oliphaunt WASIX TypeScript SDK

Run [WebAssembly PostgreSQL](https://oliphaunt.dev/docs/sdk#postgresql-as-webassembly) in browsers, Node.js, Bun, Deno, or Electron through the same query API. Use the Worker entrypoint in a browser to keep database execution off the UI thread.

## Install

```sh
npm install @oliphaunt/wasix-ts
```

Node.js, Bun, Deno, and Electron load a platform-specific native addon that hosts WebAssembly PostgreSQL; the root import uses a dedicated Rust owner thread. Check [host requirements](https://oliphaunt.dev/docs/reference/capabilities#supported-webassembly-hosts).

Browser execution requires cross-origin isolation. The current source supports `initdb` in both root and Worker placements. The [quickstart](https://oliphaunt.dev/docs/sdk/wasix-typescript) covers headers, bundling, and an initialization recipe that also works with the published 0.2.2 package.

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
