<p align="center">
  <img src="docs/assets/oliphaunt.png" alt="Oliphaunt" width="240">
</p>

# PostgreSQL inside your application

Oliphaunt embeds PostgreSQL 18 in desktop, mobile, and browser applications. Use PostgreSQL SQL, types, transactions, and extensions through an SDK for your language, without setting up a separate database service.

## Get started

Choose the SDK for your application. Each quickstart covers installation, a complete query, and persistent storage.

| Application | SDK | Package |
| --- | --- | --- |
| Rust and Tauri | [Rust](https://oliphaunt.dev/docs/sdk/rust) | `oliphaunt` |
| Node.js, Bun, Deno, Electron | [TypeScript](https://oliphaunt.dev/docs/sdk/typescript) | `@oliphaunt/ts` |
| iOS and macOS | [Swift](https://oliphaunt.dev/docs/sdk/swift) | `Oliphaunt` |
| Android | [Kotlin](https://oliphaunt.dev/docs/sdk/kotlin) | `dev.oliphaunt:oliphaunt-android` |
| React Native and Expo native builds | [React Native](https://oliphaunt.dev/docs/sdk/react-native) | `@oliphaunt/react-native` |
| Browsers and JavaScript runtimes using WebAssembly | [WASIX TypeScript](https://oliphaunt.dev/docs/sdk/wasix-typescript) | `@oliphaunt/wasix-ts` |
| Rust using WebAssembly | [WASIX Rust](https://oliphaunt.dev/docs/sdk/wasix-rust) | `oliphaunt-wasix` |
| C, C++, and language bindings | [C ABI](https://oliphaunt.dev/docs/sdk/c-abi) | `liboliphaunt` |

## How it works

An embedded handle owns one PostgreSQL session. Bind parameters, query rows, and use callback transactions through the SDK. Choose persistent storage to keep data between application runs.

Native Rust and desktop TypeScript also offer a broker process and a local PostgreSQL server. Server mode supports standard drivers, ORMs, and independent client sessions. Browser applications use the WASIX TypeScript Worker integration.

Select extensions before opening a database, then enable them with SQL such as `CREATE EXTENSION vector`. Package only the native resources your application needs. Runtime and extension versions have their own compatibility requirements.

## Documentation

- [Get started](https://oliphaunt.dev/docs/start)
- [Runtime and platform support](https://oliphaunt.dev/docs/reference/capabilities)
- [Extensions](https://oliphaunt.dev/docs/reference/extensions)
- [Moving from SQLite](https://oliphaunt.dev/docs/learn/sqlite-upgrade)
- [Releases and upgrades](https://oliphaunt.dev/docs/reference/releases)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and the [maintainer index](docs/maintainers/README.md) for architecture, testing, and release procedures.

Oliphaunt is licensed under [MIT](LICENSE).
