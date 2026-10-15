# @oliphaunt/tools

Optional `pg_dump` and non-interactive `psql` runners for local Oliphaunt
PostgreSQL endpoints. The package resolves the matching native tool carrier for
the current host and preserves ordinary PostgreSQL command-line semantics.

```js
import { pgDump, psql } from '@oliphaunt/tools';

const sql = await pgDump(server.connectionString, { args: ['--schema-only'] });
await psql(server.connectionString, { script: sql });
```

`pgDump` returns PostgreSQL's default plain SQL. Connection, file input/output,
format, encoding, compression, and parallel-job flags are managed. `psql` is
non-interactive and accepts `command`, `script`, or ordinary passthrough
arguments.
Failures reject with `PostgresToolError`, including the exit code or signal and
captured standard output and standard error.

`pgDump` and `psql` capture complete stdout and stderr in memory, subject to available
memory and host Buffer/string-size limits. A capture failure rejects the
invocation and discards both partial outputs; the child pipes are still drained
until it exits.

Use `pgDumpToFile(connectionString, path, options)` or `psqlToFile` to write a new
host file without retaining stdout. Output is staged beside the destination and
published create-only after successful tool completion and file close. Existing
files are preserved; Unix permissions are `0600`. A publication failure can occur
after SQL effects have completed: check the error's exit code before deciding
what to do next. Ordinary writes and publication do not promise power-loss durability.

`pgDumpToStream` and `psqlToStream` accept a `WritableStream<Uint8Array>` in place
of the path. Each write is awaited and receives an owned chunk of at most 64 KiB.
The caller owns stream closing and publication; a failed stream may contain
partial output. Node streams can be adapted with
[`Writable.toWeb`](https://nodejs.org/api/stream.html#streamwritabletowebstreamwritable).

Destination methods return `{ stdoutBytes, stderr, stderrTruncated }`, retaining
the latest 8 KiB of diagnostics. Supply `options.stderr` with another writable
stream for complete diagnostics. Both child pipes drain concurrently, including
after a sink failure, before reporting the real tool exit. Supply `options.signal`
to terminate the owned frontend process and interrupt a stalled destination wait.
Cancellation implies no SQL retry or rollback. `psql` script input remains buffered.
