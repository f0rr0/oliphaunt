# oliphaunt-wasix Third-Party Notices

`oliphaunt-wasix` ships WASIX PostgreSQL runtime assets, selected SQL extensions,
and target-specific Wasmer AOT artifacts.

The PostgreSQL runtime is derived from PostgreSQL 18 source pinned under
`src/third-party/postgres/` and built with the WASM/WASIX patch stack owned by
`src/wasix/runtime/assets/build/postgres/patches/`. Selected
runtime and extension carriers also embed ICU 76.1 and OpenSSL 3.5.6.

Every carrier that embeds these components includes their exact pinned license
bytes under `THIRD_PARTY_LICENSES/`:

- `PostgreSQL-COPYRIGHT` — PostgreSQL 18.6, source SHA-256
  `555610c24d53e4316da5b7d3fc25c279d96856d5e0e23ee308c328c5fa881d9f`.
- `ICU-LICENSE` — ICU commit `8eca245c7484ac6cc179e3e5f7c1ea7680810f39`.
- `OpenSSL-LICENSE.txt` — OpenSSL commit
  `286ddeaac037533bbdce65b3c689e3f7ffebf0f6`.
- `Wasmer-LICENSE` — Wasmer 7.5.0 and WASIX 0.705.0, with the compatibility
  patches owned by `src/wasix/runtime/engine/`.
- `V8-LICENSES.txt` — Windows wee8 11.9.7 / V8 13.6.233.17, including the
  licenses of the libraries bundled into that engine.

Third-party source pins for optional external extensions are maintained in
`src/third-party/`, and WASIX toolchain inputs are maintained in
`src/wasix/runtime/toolchain.toml` and `src/wasix/runtime/engine/source.toml`.
Exact SQL extension selection is modeled in
`src/extensions/`; generated WASM assets must include only the
extension artifacts explicitly selected for the release payload.
