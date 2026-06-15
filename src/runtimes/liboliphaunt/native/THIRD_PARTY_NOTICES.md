# liboliphaunt Third-Party Notices

`liboliphaunt` ships native embedded PostgreSQL runtime artifacts, selected SQL
extensions, and supporting runtime resources.

The PostgreSQL runtime is derived from PostgreSQL 18 source pinned under
`src/postgres/versions/18/` and built with the native patch stack owned by
`src/runtimes/liboliphaunt/native/`.

- PostgreSQL license: https://www.postgresql.org/about/licence/
- ICU / Unicode License v3: https://github.com/unicode-org/icu/blob/main/LICENSE

Third-party source pins for optional external extensions and supporting native
libraries are maintained in `src/sources/third-party/`. Exact SQL extension selection is
modeled in `src/extensions/`; release artifacts must include only the extension
artifacts explicitly selected by the application developer.
