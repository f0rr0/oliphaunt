# Oliphaunt TypeScript SDK

`@oliphaunt/ts` is the Oliphaunt SDK for JavaScript runtimes outside React
Native: Node.js, Bun, and Deno. It keeps PostgreSQL protocol bytes as
`Uint8Array` and defaults to `nativeDirect` everywhere for npm installs.
Node.js and Bun direct mode use Oliphaunt's prebuilt Node-API adapter package,
while Deno uses its nonblocking runtime FFI surface. Broker mode is available when
an app wants
process isolation, crash restart, or multiple-instance supervision, but it is explicit
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
contains the matching native library plus the base PostgreSQL runtime
(`postgres`, `initdb`, and `pg_ctl`), while `@oliphaunt/tools-*` carries
`pg_dump` and `psql`. Node, Bun, and Deno package-managed native startup
validate the split tools package and use a merged runtime tree from the
installed packages; startup never downloads GitHub release assets.
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
`@oliphaunt/ts`, validate the target package's versioned
`extension-contract.json`, and materialize a runtime tree containing exactly
the SQL, data, and native-module files frozen by that independently versioned
extension release. When `runtimeDirectory` is supplied
explicitly, Node, Bun, and Deno validate that the prepared runtime contains the
selected extension control files, install SQL, data files, and native modules
before opening. Deno nativeDirect does not yet materialize extension packages
automatically; pass an explicit prepared `runtimeDirectory`, or use Node/Bun
for registry-managed extension resolution. Deno nativeServer has the same
limitation for package-managed extension resolution; pass a prepared
`serverToolDirectory` when server mode needs extension assets. Do not copy
extension release assets into the application bundle by hand.

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
  storage: { kind: 'directory', path: '/var/lib/my-app/oliphaunt' },
  extensions: ['pg_textsearch'],
});

const result = await db.query('SELECT $1::text AS value', ['hello']);
console.log(result.getText(0, 'value'));

const backup = await db.backup('physicalArchive');
await db.close();

await Oliphaunt.restore({
  destination: '/var/lib/my-app/restored',
  artifact: backup,
  destinationPolicy: 'replaceExisting',
});
```

Restore is an offline native operation. It always uses the runtime's detected
native binding, regardless of the engine that produced the physical archive.
`libraryPath` is the only restore-specific runtime override.

`storage` is either `{ kind: 'directory', path }` for caller-owned persistence
or `{ kind: 'temporaryDirectory' }` for an SDK-owned host directory. Omitting it
selects `temporaryDirectory`. Failures before runtime open clean that directory
immediately. Once native-direct open has entered the native adapter, the SDK
retains it for a coherent retry because the process-resident backend may already
own PGDATA. Broker and server modes clean temporary storage after their engine
process stops.

Native-direct close is a logical detach from a process-resident PostgreSQL
backend. Its temporary directory therefore cannot be removed safely on close
and lives for the native process lifetime; later temporary opens through the
same client reopen that resident instance. Temporary storage has one resident
identity, so changing `libraryPath` between equivalent path spellings does not
allocate a competing database. Choose `directory` when data must survive, or
broker/server mode when close-time temporary cleanup is required. A failed
logical detach leaves the database open so `close()` can be retried safely.
Close rejects new work, lets work already in flight finish, and only then
detaches the logical session. Close is rejected while a transaction is active.
The resolved filesystem layout, including the internal `pgdata` child, is not
part of the public storage API.

## Runtime Selection

The package has one consumer entrypoint and detects the JavaScript runtime:

```ts
import { Oliphaunt } from '@oliphaunt/ts';
```

Node.js, Bun, and Deno select their matching native adapter internally. There
are no runtime-specific binding factories or `node`, `bun`, and `deno` package
subpaths to configure. Select an explicit `engine` only when the application
needs broker or server semantics.

## Capabilities

`Oliphaunt.supportedModes()` returns the same mode-support shape as the other
SDKs. For this SDK:

- `nativeDirect` is available when liboliphaunt can be loaded. Node.js and Bun
  resolve the matching prebuilt Node-API adapter from installed optional
  packages; Deno uses nonblocking FFI calls so `cancel()` remains usable while
  a query is running.
- `nativeBroker` is available when the matching broker helper and
  `liboliphaunt` release assets can be resolved.
- `nativeServer` is available when the PostgreSQL server executable can be
  resolved. Server mode initializes empty storage directories with matching `initdb`, exposes
  a connection string, and supports both SQL and physical-archive backup.

Native-server physical archives are assembled in a private temporary directory
through a fixed-size source buffer; PGDATA files and the growing tar are not
retained in JavaScript memory during assembly. `backup()` still returns one
contiguous `Uint8Array`, so the closed tar must be read once at the end. The
default maximum is **536,870,912 bytes (512 MiB)**. Set
`OLIPHAUNT_PHYSICAL_ARCHIVE_MAX_BYTES` to a decimal byte count to raise or lower
that limit; values above 2,147,483,647 are rejected because they are outside the
portable contiguous-`Uint8Array` compatibility boundary. Set
`OLIPHAUNT_PHYSICAL_ARCHIVE_TEMP_DIR` to an existing private directory when the
operating-system temporary volume does not have enough space. The staging
directory must be outside PGDATA so the growing archive cannot include itself.
Invalid limits and unsafe staging paths fail before `pg_backup_start`; an
assembly failure after backup starts still attempts `pg_backup_stop`, closes
the staging file, and removes staging state, with any cleanup failure reported
to the caller.

Opened `OliphauntDatabase` instances expose `capabilities()`,
`supportsBackupFormat()`, `supportsRestoreFormat()`, raw protocol execution,
query helpers, cancellation, `checkpoint()`, background preparation,
transactions, `backup()`, and logical `close()`.
