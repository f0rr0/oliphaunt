# oliphaunt-wasix Changelog

This changelog tracks the Rust WASIX binding crate.

## Unreleased

## [0.6.0] - 2026-06-12

### Added

- Split runtime artifact ownership from the Rust WASIX binding package.

### Changed

- Depend on the product-scoped `liboliphaunt-wasix` runtime crates at `0.6.0`.
- Rename the public Cargo package, binaries, and Rust import path to
  `oliphaunt-wasix`/`oliphaunt_wasix`.
