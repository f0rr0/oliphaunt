# oliphaunt-tools

Cargo facade for target-specific Oliphaunt native PostgreSQL client tool
artifacts.

Applications normally receive this crate through `oliphaunt`. It selects the
matching `oliphaunt-tools-*` artifact crate for the Cargo target and relays the
resolved `pg_dump` and `psql` payload manifest to `oliphaunt-build`.
