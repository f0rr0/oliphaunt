# Changelog

## [0.2.0](https://github.com/f0rr0/oliphaunt/compare/liboliphaunt-wasix-v0.1.1...liboliphaunt-wasix-v0.2.0) (2026-09-05)


### ⚠ BREAKING CHANGES

* **wasix-ts:** run host runtimes through Rust Node-API ([#156](https://github.com/f0rr0/oliphaunt/issues/156))
* Rust WASIX removes temporary/application-data storage variants, and browser IndexedDB uses the new per-database v3 layout without migrating prior generations.
* **release:** simplify releases and make contrib runtime-owned ([#127](https://github.com/f0rr0/oliphaunt/issues/127))

### Features

* unify native and WASIX runtimes and SDKs ([#129](https://github.com/f0rr0/oliphaunt/issues/129)) ([fae2bd7](https://github.com/f0rr0/oliphaunt/commit/fae2bd7bde00ae436d9b62ba6a37d919679ac790))
* **wasix-ts:** run host runtimes through Rust Node-API ([#156](https://github.com/f0rr0/oliphaunt/issues/156)) ([28e07be](https://github.com/f0rr0/oliphaunt/commit/28e07be782388915b28ad3fd30e3e78143710d28))


### Bug Fixes

* **wasix:** align WAL sync patch identity ([#163](https://github.com/f0rr0/oliphaunt/issues/163)) ([1708ef4](https://github.com/f0rr0/oliphaunt/commit/1708ef43aa092645cac57564c20bbd40e89d3894))
* **wasix:** reject unsupported WAL open-sync modes ([#159](https://github.com/f0rr0/oliphaunt/issues/159)) ([6e9f903](https://github.com/f0rr0/oliphaunt/commit/6e9f9032ef802a970dc1d763e29b66b8e5d17f2f))


### Performance Improvements

* **wasix:** cache JSONB constructor metadata ([#164](https://github.com/f0rr0/oliphaunt/issues/164)) ([31bb5e1](https://github.com/f0rr0/oliphaunt/commit/31bb5e19b13ea002b311dfb57f110dfc54cf563e))


### Code Refactoring

* **ci:** align product and release task boundaries ([#170](https://github.com/f0rr0/oliphaunt/issues/170)) ([009a5f5](https://github.com/f0rr0/oliphaunt/commit/009a5f5ec0659d70f6a22902c071a81e0806fabe))
* **ci:** model independent product dependencies ([#173](https://github.com/f0rr0/oliphaunt/issues/173)) ([2d5f90c](https://github.com/f0rr0/oliphaunt/commit/2d5f90c837ef7ecd8b43c2547e4b3c9b04767121))
* **release:** simplify releases and make contrib runtime-owned ([#127](https://github.com/f0rr0/oliphaunt/issues/127)) ([c45082d](https://github.com/f0rr0/oliphaunt/commit/c45082dc522f04ed0f020464282ed79150f83ecc))

## [0.1.1](https://github.com/f0rr0/oliphaunt/compare/liboliphaunt-wasix-v0.1.0...liboliphaunt-wasix-v0.1.1) (2026-08-08)


### Bug Fixes

* **runtime:** close mobile package and readiness gaps [skip ci] ([60b9df9](https://github.com/f0rr0/oliphaunt/commit/60b9df9de1d710d6faeb34114ac66409b689cf22))

## 0.1.0 (2026-07-28)


### Features

* introduce oliphaunt ([a4f438c](https://github.com/f0rr0/oliphaunt/commit/a4f438c3b2770a841efc8eb9864b474eb76e6114))
