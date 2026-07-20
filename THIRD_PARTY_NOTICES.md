# Third-Party Notices

Oliphaunt source code in this repository is licensed under the MIT license in
`LICENSE`.

This file is the repository-level notice index. Product-specific runtime and
packaging notices live next to the product that ships the relevant artifacts:

- `src/runtimes/liboliphaunt/native/THIRD_PARTY_NOTICES.md`
- `src/bindings/wasix-rust/THIRD_PARTY_NOTICES.md`

Shared PostgreSQL source pins, third-party source pins, and extension metadata
are maintained in `src/postgres/versions/18/`, `src/sources/third-party/`, and
`src/extensions/`. Generated release artifacts must include the notices for
every product they ship.

- PostgreSQL license: https://www.postgresql.org/about/licence/
- ICU / Unicode License v3: https://github.com/unicode-org/icu/blob/main/LICENSE
