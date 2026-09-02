# Changelog

## [0.2.0](https://github.com/f0rr0/oliphaunt/compare/oliphaunt-extension-postgis-v0.1.1...oliphaunt-extension-postgis-v0.2.0) (2026-09-02)


### ⚠ BREAKING CHANGES

* Rust WASIX removes temporary/application-data storage variants, and browser IndexedDB uses the new per-database v3 layout without migrating prior generations.
* **release:** simplify releases and make contrib runtime-owned ([#127](https://github.com/f0rr0/oliphaunt/issues/127))

### Features

* unify native and WASIX runtimes and SDKs ([#129](https://github.com/f0rr0/oliphaunt/issues/129)) ([fae2bd7](https://github.com/f0rr0/oliphaunt/commit/fae2bd7bde00ae436d9b62ba6a37d919679ac790))


### Code Refactoring

* **release:** simplify releases and make contrib runtime-owned ([#127](https://github.com/f0rr0/oliphaunt/issues/127)) ([c45082d](https://github.com/f0rr0/oliphaunt/commit/c45082dc522f04ed0f020464282ed79150f83ecc))

## [0.1.1](https://github.com/f0rr0/oliphaunt/compare/oliphaunt-extension-postgis-v0.1.0...oliphaunt-extension-postgis-v0.1.1) (2026-08-08)


### Bug Fixes

* **runtime:** close mobile package and readiness gaps [skip ci] ([60b9df9](https://github.com/f0rr0/oliphaunt/commit/60b9df9de1d710d6faeb34114ac66409b689cf22))

## 0.1.0 (2026-07-28)


### Features

* introduce oliphaunt ([a4f438c](https://github.com/f0rr0/oliphaunt/commit/a4f438c3b2770a841efc8eb9864b474eb76e6114))
