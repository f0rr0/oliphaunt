<p align="center">
  <img src="src/docs/assets/oliphaunt.png" alt="Oliphaunt" width="240">
</p>

# PostgreSQL inside your application

Oliphaunt embeds PostgreSQL 18 in iOS, Android, React Native, browser, and desktop applications. Use PostgreSQL SQL, types, transactions, and extensions through an SDK for your language, without setting up a separate database service.

## Get started

Choose the SDK for your application. Each quickstart covers installation, a complete query, and persistent storage.

| Application | PostgreSQL runtime | SDK / package |
| --- | --- | --- |
| Browsers, Node.js, Bun, Deno, Electron | WebAssembly | [WASIX TypeScript](https://oliphaunt.dev/docs/sdk/wasix-typescript) · `@oliphaunt/wasix-ts` |
| iOS and macOS | Native | [Swift](https://oliphaunt.dev/docs/sdk/swift) · `Oliphaunt` |
| Android | Native | [Kotlin](https://oliphaunt.dev/docs/sdk/kotlin) · `dev.oliphaunt:oliphaunt-android` |
| React Native and Expo native builds on iOS/Android | Native | [React Native](https://oliphaunt.dev/docs/sdk/react-native) · `@oliphaunt/react-native` |
| Rust desktop and Tauri | WebAssembly | [WASIX Rust](https://oliphaunt.dev/docs/sdk/wasix-rust) · `oliphaunt-wasix` |
| Rust desktop and Tauri | Native | [Native Rust](https://oliphaunt.dev/docs/sdk/rust) · `oliphaunt` |
| Node.js, Bun, Deno, Electron | Native | [Native TypeScript](https://oliphaunt.dev/docs/sdk/typescript) · `@oliphaunt/ts` |
| C, C++, and language bindings | Native | [C ABI](https://oliphaunt.dev/docs/sdk/c-abi) · `liboliphaunt` |

The WASIX SDKs run [PostgreSQL as WebAssembly](https://oliphaunt.dev/docs/sdk#postgresql-as-webassembly). They also fit native desktop apps: your application keeps its usual language and build tools while the SDK hosts the database. Check [host requirements](https://oliphaunt.dev/docs/reference/capabilities) for the supported platforms.

## How it works

An embedded handle owns one PostgreSQL session. Bind parameters, query rows, and use callback transactions through the SDK. Choose persistent storage to keep data between application runs.

Swift, Kotlin, and React Native integrate native PostgreSQL with mobile app storage and async execution. See the [mobile guide](https://oliphaunt.dev/docs/learn/mobile-stability) for lifecycle and broker setup.

Native Rust and native TypeScript also offer a broker process and a local PostgreSQL server with independent client sessions. WASIX Rust and WASIX TypeScript offer local endpoints for one connected client at a time. Browser applications use the WASIX TypeScript Worker integration to keep database execution off the UI thread.

Select extensions before opening a database, then enable them with SQL such as `CREATE EXTENSION vector`. Package the runtime assets and extension resources your application needs. Runtime and extension versions have their own compatibility requirements.

## Documentation

- [Get started](https://oliphaunt.dev/docs/start)
- [Runtime and platform support](https://oliphaunt.dev/docs/reference/capabilities)
- [Extensions](https://oliphaunt.dev/docs/reference/extensions)
- [Moving from SQLite](https://oliphaunt.dev/docs/learn/sqlite-upgrade)
- [Releases and upgrades](https://oliphaunt.dev/docs/reference/releases)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and the [maintainer index](src/docs/maintainers/README.md) for architecture, testing, and release procedures.

Oliphaunt is licensed under [MIT](LICENSE).
