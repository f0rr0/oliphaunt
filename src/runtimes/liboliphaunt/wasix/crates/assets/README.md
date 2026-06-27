# liboliphaunt-wasix-portable

Portable runtime artifact crate for `oliphaunt-wasix`.

Applications depend on `oliphaunt-wasix`, not on this crate directly.
`oliphaunt-wasix` depends on this artifact crate at the matching
`liboliphaunt-wasix` runtime version. Release packaging publishes this crate
directly from staged WASIX release assets so Cargo resolves the packaged WASIX
runtime without a runtime download step.

The published root runtime crate carries `postgres` and `initdb` only. Standalone
client tools are split into `oliphaunt-wasix-tools`, which carries `pg_dump` and
`psql`; WASIX has no `pg_ctl` payload.
