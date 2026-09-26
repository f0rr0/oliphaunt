# oliphaunt-tools

Optional endpoint-oriented runner for target-specific Oliphaunt native
PostgreSQL client tool artifacts.

It selects the matching `oliphaunt-tools-*` artifact crate for the Cargo target
and exposes thin `pg_dump` and non-interactive `psql` functions. The core
`oliphaunt` SDK does not depend on this crate. Set `OLIPHAUNT_TOOLS_DIR` only
when overriding packaged tool discovery during development.
