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
