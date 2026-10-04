# oliphaunt-tools

Optional endpoint-oriented runner for target-specific Oliphaunt native
PostgreSQL client tool artifacts.

It selects the matching `oliphaunt-tools-*` artifact crate for the Cargo target
and exposes thin `pg_dump` and non-interactive `psql` functions. The core
`oliphaunt` SDK does not depend on this crate. Set `OLIPHAUNT_TOOLS_DIR` only
when overriding packaged tool discovery during development.

The API captures complete stdout and stderr in memory, subject to available
memory and host string-size limits. A capture failure discards both partial
outputs while the child pipes are drained and the child is reaped. For dumps
that should not stay in memory, use an external file/stream-output tool; this
API does not yet offer a streaming sink.
