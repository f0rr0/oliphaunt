# Changelog

## 0.1.0 (2026-09-02)


### ⚠ BREAKING CHANGES

* Rust WASIX removes temporary/application-data storage variants, and browser IndexedDB uses the new per-database v3 layout without migrating prior generations.

### Features

* unify native and WASIX runtimes and SDKs ([#129](https://github.com/f0rr0/oliphaunt/issues/129)) ([fae2bd7](https://github.com/f0rr0/oliphaunt/commit/fae2bd7bde00ae436d9b62ba6a37d919679ac790))
