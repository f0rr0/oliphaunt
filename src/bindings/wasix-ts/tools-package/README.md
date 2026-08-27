# @oliphaunt/wasix-tools

Optional standard PostgreSQL `pg_dump` and non-interactive `psql` runners for
an open `@oliphaunt/wasix-ts` database. Tool binaries are carried separately;
the core database package does not download them.

`pgDump()` returns PostgreSQL's ordinary plain SQL dump, including normal
`COPY` data. `psql()` accepts a command or script and can restore that output.
Both operations exclusively own the database session until they finish.
They reset PostgreSQL session state before and after running, so raw-protocol
callers must not expect prepared statements or session settings to survive.

```sh
pnpm add @oliphaunt/wasix-ts @oliphaunt/wasix-tools
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

`pgDump()` supports databases from the root and `/worker` entrypoints.
`psql()` requires `/worker` because COPY restore is full duplex.
Ordinary PostgreSQL
arguments are passed through, except connection, input/output, encoding, dump
format, compression, and parallel-job arguments owned by the runner.
`pgDump()` always uses plain UTF-8 output and rejects custom formats; it does
not force `--inserts` or rewrite valid dump SQL. `psql()` accepts `command` or
`script`, uses no user psqlrc, and stops on the first SQL error. Interactive
input and `pg_restore` are not part of this package.

Tool failures throw `PostgresToolError` with `tool`, `exitCode`, `stdout`, and
`stderr` fields.
