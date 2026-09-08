# Oliphaunt React Native SDK

Embed PostgreSQL in an iOS or Android app using React Native's New Architecture. The package requires React Native 0.85+ and React 19+; Expo integration requires Expo 56+ and a native build.

## Install

```sh
npm install @oliphaunt/react-native
```

For Expo, add `"@oliphaunt/react-native"` to `expo.plugins` in `app.json`, then build with `npx expo run:ios` or `npx expo run:android`. Expo Go does not include this native module. For bare projects, follow the [native integration guide](https://oliphaunt.dev/docs/sdk/react-native/architecture).

The [quickstart](https://oliphaunt.dev/docs/sdk/react-native) covers prerequisites and the versions documented by the current site. Pin dependencies in your application manifest or lockfile.

## First query

Call `firstQuery()` from application initialization or a user action.

```ts
import Oliphaunt from '@oliphaunt/react-native';

export async function firstQuery() {
  const db = await Oliphaunt.open();
  try {
    const result = await db.query('SELECT $1::int4 AS answer', [42]);
    console.log(result.rows[0]?.answer); // 42
  } finally {
    await db.close();
  }
}
```

Default storage is a disposable temporary directory. Direct mode stays bound to its first root and configuration for the lifetime of the process, even after closing a handle. Use the quickstart's persistent-storage example for application data; run it as an alternative to this disposable example. Always close database handles explicitly.

## Build your integration

- [Guide](https://oliphaunt.dev/docs/sdk/react-native/guide): parameters, transactions, extensions, backups, and shutdown.
- [API reference](https://oliphaunt.dev/docs/sdk/react-native/api-reference): methods, configuration, results, and errors.
- [Runtime support](https://oliphaunt.dev/docs/reference/capabilities): platforms, storage, and concurrency.
- [Releases and upgrades](https://oliphaunt.dev/docs/reference/releases): dependency and database upgrades.
