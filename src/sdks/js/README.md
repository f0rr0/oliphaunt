# Oliphaunt TypeScript SDK

`@oliphaunt/ts` is the Oliphaunt SDK for JavaScript runtimes outside React
Native: Node.js, Bun, and Deno. It keeps PostgreSQL protocol bytes as
`Uint8Array` and defaults to `nativeDirect` everywhere. Node.js direct mode uses
Oliphaunt's prebuilt Node-API adapter release asset, while Bun and Deno use
their runtime-owned FFI surfaces. Broker mode is available when an app wants
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

For Deno or pnpm projects that prefer JSR:

```sh
deno add jsr:@oliphaunt/ts
pnpm add jsr:@oliphaunt/ts
```

Node.js, Bun, and Deno use `nativeDirect` by default. The Node/Bun registry
artifact is `@oliphaunt/ts`; the Deno-native registry target is JSR at
`jsr:@oliphaunt/ts`. Deno can consume packages from the npm registry too, but
JSR is the preferred Deno install path because it publishes TypeScript source
and validates the Deno-native entrypoint directly.

On supported desktop targets, the SDK downloads the compatible `liboliphaunt-native-v*`
GitHub release asset and, for Node.js, the compatible prebuilt Node direct
adapter on first native use. It verifies both against release checksum
manifests, extracts them into the Oliphaunt cache, and reuses that install on
later opens. Set `OLIPHAUNT_CACHE_DIR` to choose the cache location.
There is no `postinstall` native compilation step and no package-manager native
addon approval in the normal path: Node, Bun, and Deno consumers do not install
Rust, run Cargo, build PostgreSQL, or copy Oliphaunt native artifacts. The
package resolves prebuilt release assets at runtime.
Deno native use requires the corresponding runtime permissions, including
`--allow-ffi`, `--allow-read`, `--allow-write`, `--allow-net`, and
`--allow-env`.

## Compatibility

| Package | Compatible release |
| --- | --- |
| `@oliphaunt/ts` | `0.1.0` |
| `liboliphaunt` | `0.1.0` |
| Rust broker helper | `oliphaunt` `0.1.0` / `oliphaunt-broker` |

The normal install path resolves the matching liboliphaunt release asset
automatically. Advanced consumers can still pass `libraryPath` and
`runtimeDirectory`, or set `LIBOLIPHAUNT_PATH` and `OLIPHAUNT_RUNTIME_DIR`, when
using a custom local native build.

The normal Node.js path resolves the matching prebuilt Node direct adapter from
the `@oliphaunt/ts` release and never asks app developers to install Rust,
Cargo, node-gyp, or a third-party FFI package. Advanced consumers can still pass
`libraryPath`, `runtimeDirectory`, or `OLIPHAUNT_NODE_ADDON` for custom local
native builds.

Broker mode uses the published `oliphaunt-broker` helper and resolves the
matching helper automatically from the `brokerVersion` pinned in
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
  has an FFI surface. Bun and Deno provide one; Node.js direct mode requires an
  explicit app-provided FFI dependency.
- `nativeBroker` is available when the matching broker helper and
  `liboliphaunt` release assets can be resolved.
- `nativeServer` is available when the PostgreSQL server executable can be
  resolved. Server mode initializes empty roots with matching `initdb`, exposes
  a connection string, and supports both SQL and physical-archive backup.

Opened `OliphauntDatabase` instances expose `capabilities()`,
`supportsBackupFormat()`, `supportsRestoreFormat()`, raw protocol execution,
query helpers, cancellation, `checkpoint()`, background preparation,
transactions, `backup()`, and logical `close()`.
