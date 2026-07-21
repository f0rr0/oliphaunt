# oliphaunt-wasix Third-Party Notices

`oliphaunt-wasix` ships WASIX PostgreSQL runtime assets, selected SQL extensions,
and target-specific Wasmer AOT artifacts.

The PostgreSQL runtime is derived from PostgreSQL 18 source pinned under
`src/postgres/versions/18/` and built with the WASM/WASIX patch stack owned by
`src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/`.

- PostgreSQL license: https://www.postgresql.org/about/licence/
- ICU / Unicode License v3: https://github.com/unicode-org/icu/blob/main/LICENSE

Third-party source pins for optional external extensions are maintained in
`src/sources/third-party/`, and WASIX toolchain inputs are maintained in
`src/sources/toolchains/`. Exact SQL extension selection is modeled in
`src/extensions/`; generated WASM assets must include only the
extension artifacts explicitly selected for the release payload.
