# oliphaunt-tools

Optional endpoint-oriented runner for target-specific Oliphaunt native
PostgreSQL client tool artifacts.

It selects the matching `oliphaunt-tools-*` artifact crate for the Cargo target
and exposes thin `pg_dump` and non-interactive `psql` functions. The core
`oliphaunt` SDK does not depend on this crate. Set `OLIPHAUNT_TOOLS_DIR` only
when overriding packaged tool discovery during development.

The `pg_dump` and `psql` convenience functions capture complete stdout and stderr in memory, subject to available
memory and host string-size limits. A capture failure discards both partial
outputs while the child pipes are drained and the child is reaped.

Use `pg_dump_to_writer` or `psql_to_writer` for a borrowed `Write + Send` destination.
These functions drain stdout and stderr concurrently and retain only the latest
8 KiB of diagnostics, with an explicit truncation flag. A writer failure drains
the child before returning an error; the destination may contain partial output.
The optional fourth argument receives complete stderr through another borrowed
`Write + Send` writer; pass `None` to retain only the diagnostic tail. The caller
owns borrowed writers' flushing and publication.

`pg_dump_to_file` and `psql_to_file` stage a new host file beside its destination,
flush and close it after tool completion, then publish without replacing an
existing file. Unix output permissions are `0600`. Failed tool execution leaves
the destination untouched. Ordinary flushing and atomic publication do not
promise power-loss durability. Script input remains buffered.
