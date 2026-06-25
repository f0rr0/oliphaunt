# oliphaunt-wasix-tools

Cargo artifact crate for Oliphaunt WASIX PostgreSQL command-line tools.
Applications do not depend on this crate directly; SDK crates select it when
they need the WASIX `pg_dump` or `psql` modules.
