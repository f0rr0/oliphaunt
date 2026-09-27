# oliphaunt-tools

Optional endpoint-oriented runner for target-specific Oliphaunt native
PostgreSQL client tool artifacts.

It selects the matching `oliphaunt-tools-*` artifact crate for the Cargo target
and exposes thin `pg_dump` and non-interactive `psql` functions. The core
`oliphaunt` SDK does not depend on this crate. Set `OLIPHAUNT_TOOLS_DIR` only
when overriding packaged tool discovery during development.

Captured stdout and stderr share an inclusive 64 MiB raw-byte limit per
invocation. Overflow returns an error with both partial outputs discarded while
the child pipes are drained and the child is reaped. Larger dumps require an
external file/stream-output tool; this capture-only API has no limit override.
