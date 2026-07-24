# liboliphaunt Third-Party Notices

`liboliphaunt` ships native embedded PostgreSQL runtime artifacts, selected SQL
extensions, and supporting runtime resources.

The PostgreSQL runtime is derived from PostgreSQL 18 source pinned under
`src/postgres/versions/18/` and built with the native patch stack owned by
`src/runtimes/liboliphaunt/native/`. Selected runtime and extension carriers
also embed ICU 76.1 and OpenSSL 3.5.6.

Every carrier that embeds these components includes their exact pinned license
bytes under `THIRD_PARTY_LICENSES/`:

- `PostgreSQL-COPYRIGHT` — PostgreSQL 18.4, source SHA-256
  `81a81ec695fb0c7901407defaa1d2f7973617154cf27ba74e3a7ab8e64436094`.
- `ICU-LICENSE` — ICU commit `8eca245c7484ac6cc179e3e5f7c1ea7680810f39`.
- `OpenSSL-LICENSE.txt` — OpenSSL commit
  `286ddeaac037533bbdce65b3c689e3f7ffebf0f6`.

Third-party source pins for optional external extensions and supporting native
libraries are maintained in `src/sources/third-party/`. Exact SQL extension selection is
modeled in `src/extensions/`; release artifacts must include only the extension
artifacts explicitly selected by the application developer.
