# libpglite-oxide

Native-first embedded PostgreSQL for application developers.

This repository now has two product lanes:

- `libpglite`: the C ABI boundary over embedded PostgreSQL 18.
- `libpglite-oxide`: the Rust SDK built on that native boundary.

The existing `pglite-oxide` WASIX release lane is preserved in
`crates/pglite-oxide` while native parity is built out. It remains separate from
the native SDK so we can keep the legacy release path stable without shaping the
new architecture around it.

## Layout

- `libpglite/`: C ABI, PostgreSQL 18 source pin, patch stack, native build and
  smoke harnesses.
- `crates/libpglite-oxide/`: native Rust SDK surface.
- `crates/pglite-oxide/`: existing WASIX-based Rust package.
- `crates/assets/` and `crates/aot/`: packaged WASIX release assets.
- `sdks/`: future Swift, Kotlin, and React Native SDKs.
- `tools/`: repo automation, including `xtask` and validation scripts.
- `benchmarks/`: benchmark plans and future cross-engine harnesses.
- `docs/`: architecture, release, development, and internal progress notes.

See `docs/REPO_STRUCTURE.md` for the repository policy and the evidence behind
the layout.

## Common Commands

```sh
just --list
just check
just test-compile
just native-smoke
tools/scripts/validate.sh dev
```

`just` is a convenience command runner. The underlying Cargo and shell commands
remain first-class and are what CI uses.
