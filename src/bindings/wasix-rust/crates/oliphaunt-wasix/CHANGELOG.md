# oliphaunt-wasix Changelog

This changelog tracks the Rust WASIX binding crate.

## Unreleased

## [0.7.0](https://github.com/f0rr0/oliphaunt/compare/oliphaunt-wasix-rust-v0.6.0...oliphaunt-wasix-rust-v0.7.0) (2026-06-18)


### Features

* introduce oliphaunt ([#38](https://github.com/f0rr0/oliphaunt/issues/38)) ([f8f23a3](https://github.com/f0rr0/oliphaunt/commit/f8f23a3eda17586b1756a7d307028dda59c550d3))

## [0.6.0] - 2026-06-12

### Added

- Split runtime artifact ownership from the Rust WASIX binding package.

### Changed

- Depend on the product-scoped `liboliphaunt-wasix` runtime crates at `0.6.0`.
- Rename the public Cargo package, binaries, and Rust import path to
  `oliphaunt-wasix`/`oliphaunt_wasix`.
