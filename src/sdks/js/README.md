# Oliphaunt TypeScript SDK

`@oliphaunt/ts` is the Oliphaunt SDK for JavaScript runtimes outside React
Native: Node.js, Bun, and Deno. It keeps PostgreSQL protocol bytes as
`Uint8Array` and defaults to `nativeDirect` everywhere for npm installs.
Node.js direct mode uses Oliphaunt's prebuilt Node-API adapter package, while
Bun and Deno use their runtime-owned FFI surfaces. Broker mode is available when
an app wants
process isolation, crash restart, or multi-root supervision, but it is explicit
rather than a hidden runtime-specific default. Server mode
starts a local PostgreSQL server when
`serverExecutable`, `serverToolDirectory`, or `OLIPHAUNT_POSTGRES` is
configured.
The broker/server architecture and implementation gates are documented in
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## Install

```sh
pnpm add @oliphaunt/ts
```

For Deno or pnpm projects that only need protocol/query helpers:

```sh
deno add jsr:@oliphaunt/ts
pnpm add jsr:@oliphaunt/ts
```

Node.js, Bun, and Deno use `nativeDirect` by default. The Node/Bun registry
artifact is `@oliphaunt/ts`; Deno native applications import
`npm:@oliphaunt/ts`. Deno can consume packages from the npm registry, and that
is the native-runtime install path. JSR publishes protocol/query helpers only.

On supported desktop targets, package managers install the matching
`@oliphaunt/liboliphaunt-*`, `@oliphaunt/tools-*`, `@oliphaunt/broker-*`, and
`@oliphaunt/node-direct-*` packages. Each `@oliphaunt/liboliphaunt-*` package
contains the matching native library plus the root PostgreSQL runtime
(`postgres`, `initdb`, and `pg_ctl`), while `@oliphaunt/tools-*` carries
`pg_dump` and `psql`. Runtime startup uses those installed packages and never
downloads GitHub release assets.
There is no `postinstall` native compilation step and no package-manager native
addon approval in the normal path: Node, Bun, and Deno consumers do not install
Rust, run Cargo, build PostgreSQL, or copy Oliphaunt native artifacts. The
package resolves prebuilt artifacts from installed registry packages. Do not
install `@oliphaunt/ts` with optional dependencies disabled, such as
`--omit=optional`, `--no-optional`, or pnpm `ignoredOptionalDependencies`; those
flags remove the platform packages that carry the runtime artifacts.
Deno native use requires the corresponding runtime permissions, including
`--allow-ffi`, `--allow-read`, `--allow-write`, `--allow-net`, and
`--allow-env`.

Base native installs do not include full ICU data. Applications that need
PostgreSQL ICU collations install the matching ICU sidecar package through the
same package manager:

```sh
pnpm add @oliphaunt/icu
deno add npm:@oliphaunt/icu
```

Node, Bun, and Deno native modes discover `@oliphaunt/icu` when it is installed
and set the runtime ICU data environment before opening liboliphaunt. Do not add
`@oliphaunt/icu` for applications that do not use ICU collations. JSR remains
protocol/query-only and does not expose native runtime or ICU packages.

PostgreSQL extensions follow the same registry-driven model in Node and Bun.
Applications add the extension meta package for every extension they pass to
`Oliphaunt.open({ extensions })`; that package installs the matching target
payload as an optional dependency.

```sh
pnpm add @oliphaunt/extension-hstore @oliphaunt/extension-pg-trgm
```

At startup the Node and Bun bindings resolve the current platform package,
validate that it was built for the same liboliphaunt version as
`@oliphaunt/ts`, and materialize a runtime tree containing the selected
extension SQL files and native modules. Deno nativeDirect does not yet
materialize extension packages automatically; pass an explicit
`runtimeDirectory` that already contains the selected extension assets, or use
Node/Bun for registry-managed extension resolution. Do not copy extension
release assets into the application bundle by hand.

## Compatibility

| Package | Compatible release |
| --- | --- |
| `@oliphaunt/ts` | `0.1.0` |
| `liboliphaunt` | `0.1.0` |
| Rust broker helper | `oliphaunt` `0.1.0` / `oliphaunt-broker` |

The normal install path resolves the matching liboliphaunt package
automatically. Advanced consumers can still pass `libraryPath` and
`runtimeDirectory`, or set `LIBOLIPHAUNT_PATH` and `OLIPHAUNT_RUNTIME_DIR`, when
using a custom local native build.

The normal Node.js path resolves the matching prebuilt Node direct adapter from
installed optional packages and never asks app developers to install Rust,
Cargo, node-gyp, or a third-party FFI package. Advanced consumers can still pass
`libraryPath`, `runtimeDirectory`, or `OLIPHAUNT_NODE_ADDON` for custom local
native builds.

Broker mode uses the published `@oliphaunt/broker-*` helper package and resolves
the matching helper automatically from the `brokerVersion` pinned in
this package. Advanced consumers can still pass `brokerExecutable` or set
`OLIPHAUNT_BROKER` to test a custom local helper.

## Quickstart

```ts
import { Oliphaunt } from '@oliphaunt/ts';

const db = await Oliphaunt.open({
  root: '/var/lib/my-app/oliphaunt',
  extensions: ['pg_search'],
});

const result = await db.query('SELECT $1::text AS value', ['hello']);
console.log(result.getText(0, 'value'));

const backup = await db.backup('physicalArchive');
await db.close();

await Oliphaunt.restore({
  root: '/var/lib/my-app/restored',
  artifact: backup,
  replaceExisting: true,
});
```

The configured `root` is the Oliphaunt root directory; PostgreSQL files live
under `root/pgdata`, matching the Rust, Swift, Kotlin, and React Native SDKs.
When `root` is omitted, the SDK creates a process temporary root. Native-direct
close is a logical detach, so the temporary root is not deleted while the
resident native backend may still own `root/pgdata`.

## Runtime Entry Points

The default entrypoint detects the JavaScript runtime:

```ts
import { Oliphaunt, createOliphauntClient } from '@oliphaunt/ts';
```

Runtime-specific native bindings are also exported:

```ts
import { createNodeNativeBinding } from '@oliphaunt/ts/node';
import { createBunNativeBinding } from '@oliphaunt/ts/bun';
import { createDenoNativeBinding } from '@oliphaunt/ts/deno';
```

## Capabilities

`Oliphaunt.supportedModes()` returns the same mode-support shape as the other
SDKs. For this SDK:

- `nativeDirect` is available when liboliphaunt can be loaded and the runtime
  has an FFI surface. Bun and Deno provide one; Node.js resolves the matching
  prebuilt Node-API adapter from installed optional packages.
- `nativeBroker` is available when the matching broker helper and
  `liboliphaunt` release assets can be resolved.
- `nativeServer` is available when the PostgreSQL server executable can be
  resolved. Server mode initializes empty roots with matching `initdb`, exposes
  a connection string, and supports both SQL and physical-archive backup.

Opened `OliphauntDatabase` instances expose `capabilities()`,
`supportsBackupFormat()`, `supportsRestoreFormat()`, raw protocol execution,
query helpers, cancellation, `checkpoint()`, background preparation,
transactions, `backup()`, and logical `close()`.
