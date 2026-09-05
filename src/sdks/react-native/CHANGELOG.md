# Changelog

## [0.2.0](https://github.com/f0rr0/oliphaunt/compare/oliphaunt-react-native-v0.1.1...oliphaunt-react-native-v0.2.0) (2026-09-05)


### ⚠ BREAKING CHANGES

* **sdk:** unify embedded PostgreSQL public APIs ([#153](https://github.com/f0rr0/oliphaunt/issues/153))
* Rust WASIX removes temporary/application-data storage variants, and browser IndexedDB uses the new per-database v3 layout without migrating prior generations.
* **release:** simplify releases and make contrib runtime-owned ([#127](https://github.com/f0rr0/oliphaunt/issues/127))

### Features

* **sdk:** unify embedded PostgreSQL public APIs ([#153](https://github.com/f0rr0/oliphaunt/issues/153)) ([4384d1b](https://github.com/f0rr0/oliphaunt/commit/4384d1bdfafee07e4e1963ac68027b4bcf002a1e))
* unify native and WASIX runtimes and SDKs ([#129](https://github.com/f0rr0/oliphaunt/issues/129)) ([fae2bd7](https://github.com/f0rr0/oliphaunt/commit/fae2bd7bde00ae436d9b62ba6a37d919679ac790))


### Bug Fixes

* **ios:** preserve valid framework and cache layouts ([#152](https://github.com/f0rr0/oliphaunt/issues/152)) ([a8cc597](https://github.com/f0rr0/oliphaunt/commit/a8cc597eee58a925c0c23423d9f8360deb0f31da))


### Performance Improvements

* **js:** streamline exec response handling ([#158](https://github.com/f0rr0/oliphaunt/issues/158)) ([5eaf05b](https://github.com/f0rr0/oliphaunt/commit/5eaf05b8a8d21bd974b9fcb6d618103be5689151))


### Code Refactoring

* **ci:** align product and release task boundaries ([#170](https://github.com/f0rr0/oliphaunt/issues/170)) ([009a5f5](https://github.com/f0rr0/oliphaunt/commit/009a5f5ec0659d70f6a22902c071a81e0806fabe))
* **ci:** model independent product dependencies ([#173](https://github.com/f0rr0/oliphaunt/issues/173)) ([2d5f90c](https://github.com/f0rr0/oliphaunt/commit/2d5f90c837ef7ecd8b43c2547e4b3c9b04767121))
* **release:** simplify releases and make contrib runtime-owned ([#127](https://github.com/f0rr0/oliphaunt/issues/127)) ([c45082d](https://github.com/f0rr0/oliphaunt/commit/c45082dc522f04ed0f020464282ed79150f83ecc))

## [0.1.1](https://github.com/f0rr0/oliphaunt/compare/oliphaunt-react-native-v0.1.0...oliphaunt-react-native-v0.1.1) (2026-08-08)


### Bug Fixes

* **runtime:** close mobile package and readiness gaps [skip ci] ([60b9df9](https://github.com/f0rr0/oliphaunt/commit/60b9df9de1d710d6faeb34114ac66409b689cf22))

## 0.1.0 (2026-07-28)


### Features

* introduce oliphaunt ([a4f438c](https://github.com/f0rr0/oliphaunt/commit/a4f438c3b2770a841efc8eb9864b474eb76e6114))
