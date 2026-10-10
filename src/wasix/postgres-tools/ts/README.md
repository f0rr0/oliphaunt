# @oliphaunt/wasix-tools

Optional standard PostgreSQL `pg_dump` and non-interactive `psql` runners for
an open `@oliphaunt/wasix-ts` database. This package remains the public opt-in
facade on every supported host. The tools package supplies the selected portable
and host-AOT tool inputs. Node.js, Bun, Deno, and Electron run them through the
Node-API host; the base addon does not include the optional PostgreSQL frontends.

`pgDump()` returns PostgreSQL's ordinary plain SQL dump, including normal
`COPY` data. `psql()` accepts a command or script and can restore that output.
Both operations exclusively own the database session until they finish.
They reset PostgreSQL session state before and after running, so raw-protocol
callers must not expect prepared statements or session settings to survive.

```sh
bun add @oliphaunt/wasix-ts @oliphaunt/wasix-tools
```

```ts
import Oliphaunt from '@oliphaunt/wasix-ts';
import WorkerOliphaunt from '@oliphaunt/wasix-ts/worker';
import { pgDump, psql } from '@oliphaunt/wasix-tools';
import { indexedDB } from '@oliphaunt/wasix-ts/storage/indexed-db';

await using source = await Oliphaunt.open();
const sql = await pgDump(source, { args: ['--schema-only'] });
const storage = indexedDB('import-' + crypto.randomUUID());
const initial = await Oliphaunt.open({ storage });
await initial.close();
await using target = await WorkerOliphaunt.open({ storage });
await psql(target, { script: sql });
```

This browser example initializes fresh storage with the root client, closes it,
then reopens it in the package-owned Worker. Root initialization can block its
calling realm. The current SDK source can also initialize directly in the
package-owned Worker. The example retains compatibility with the published
SDK 0.2.2; see [browser initialization and seed compatibility](https://oliphaunt.dev/docs/sdk/wasix-typescript/guide#initialize-browser-worker-storage).

On Node.js, Bun, Deno, and Electron, omit the IndexedDB import and storage
preparation and use `await using target = await Oliphaunt.open()` instead.
Those hosts can initialize fresh storage and run `psql` directly.

`pgDump()` supports databases from the root, `/direct`, and `/worker` entrypoints.
In browsers, `psql()` requires `/worker` because COPY restore is full duplex.
On Node.js, Bun, Deno, and Electron the Rust tool bridge supports `psql()` on
all three entrypoints.
Ordinary PostgreSQL
arguments are passed through, except connection, input/output, encoding, dump
format, compression, and parallel-job arguments owned by the runner.
`pgDump()` always uses plain UTF-8 output and rejects custom formats; it does
not force `--inserts` or rewrite valid dump SQL. `psql()` accepts `command` or
`script`, uses no user psqlrc, and stops on the first SQL error. Interactive
input and `pg_restore` are not part of this package.

Tool failures throw `PostgresToolError` with `tool`, `exitCode`, `stdout`, and
`stderr` fields.

## Maintainer commands

After installing the pinned workspace tools and dependencies, run these from
this directory:

```sh
moon run oliphaunt-wasix-tools-ts:build
moon run oliphaunt-wasix-tools-ts:typecheck
moon run oliphaunt-wasix-tools-ts:test
moon run oliphaunt-wasix-tools-ts:package
```

Build and typecheck first build the SDK's actual declarations; they do not
compile PostgreSQL, Wasmer or the Node addon. Packaging depends on this build
and stages only the facade. `bun run build` and `bun run typecheck` consume an
already built SDK. The separate `postgres-tools-wasix:test-consumer` and
`postgres-tools-wasix:test-browser` tasks produce the runtime/tool dependencies
and exercise the installed packages on their respective hosts.
