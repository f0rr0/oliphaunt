# @oliphaunt/wasix-tools

Optional standard PostgreSQL `pg_dump` and non-interactive `psql` runners for
an open `@oliphaunt/wasix-ts` database. This package remains the public opt-in
facade on every host. Browsers load separately carried portable tool binaries;
Node.js, Bun, Deno, and Electron call the copies compiled into the matching Node-API
platform carrier.

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

await using source = await Oliphaunt.open();
const sql = await pgDump(source, { args: ['--schema-only'] });
await using target = await WorkerOliphaunt.open();
await psql(target, { script: sql });
```

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
`stderr` fields. `stderrTruncated` identifies a bounded diagnostic tail.

## Write output to a host file

On Node.js, Bun, Deno, and Electron, use `pgDumpToFile()` or `psqlToFile()` to
write output without collecting it in JavaScript. Both support root, `/direct`,
and `/worker` databases. Browser databases reject host file destinations before
execution.

```ts
import Oliphaunt from '@oliphaunt/wasix-ts';
import { pgDumpToFile } from '@oliphaunt/wasix-tools';

await using db = await Oliphaunt.open();
const output = await pgDumpToFile(db, './new-dump.sql');
console.log(output.stdoutBytes);
```

The destination must be a new file in an existing host directory. The runner
stages output beside it, uses private `0600` permissions on Unix, and publishes
only after tool execution, database cleanup, flush and close succeed. Existing
files are preserved. Ordinary flush does not guarantee persistence across power
loss.

The result contains `stdoutBytes`, an 8 KiB diagnostic tail in `stderr`, and
`stderrTruncated`. If publication fails after PostgreSQL completes, the error
retains `exitCode: 0`; SQL effects remain committed and are not retried or rolled
back. `psql({ script })` still accepts buffered input.

## Write output to an asynchronous stream

`pgDumpToStream()` and `psqlToStream()` accept a standard
`WritableStream<Uint8Array>`. Desktop root and `/worker` databases support them;
browser databases require `/worker`. `/direct` rejects asynchronous destinations
before execution and supports host files instead.

```ts
import OliphauntWorker from '@oliphaunt/wasix-ts/worker';
import { pgDumpToStream } from '@oliphaunt/wasix-tools';

async function dumpTo(destination: WritableStream<Uint8Array>) {
  const db = await OliphauntWorker.open();
  try {
    return await pgDumpToStream(db, destination);
  } finally {
    await db.close();
  }
}
```

Each owned chunk is at most 64 KiB, and the producer waits for its write to
finish. The caller owns the streams; the API releases writer locks without
closing them. Options accept a full `stderr` destination and an `AbortSignal`.
Summaries retain the same marked 8 KiB diagnostic tail as file output.

Sink failure or cancellation stops destination writes and drains the tool before
reporting its actual exit code. Already committed SQL remains committed. The
signal releases stalled output writes; it does not interrupt CPU-bound SQL.
Destination callbacks must not await another operation on the same database.
`psql({ script })` remains buffered input. Existing `pgDump()` and `psql()`
convenience methods collect complete output.

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
