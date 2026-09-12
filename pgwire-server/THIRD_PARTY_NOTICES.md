# Third-Party Notices

Oliphaunt source code in this repository is licensed under the MIT license in
`LICENSE`.

This file is the repository-level notice index. Product-specific runtime and
packaging notices live next to the product that ships the relevant artifacts:

- `runtimes/liboliphaunt-native/THIRD_PARTY_NOTICES.md`
- `sdks/rust-wasix/THIRD_PARTY_NOTICES.md`

Shared PostgreSQL source pins, third-party source pins, and extension metadata
are maintained in `third-party/postgres/`, `third-party/`, and
`extensions/`. Generated release artifacts must include the notices and
exact pinned license bytes for every product and third-party component they
ship.

Canonical runtime license snapshots live in
`third-party/`; their source pins and digests are
enforced by `tools/packaging/release-notices.mts`.
