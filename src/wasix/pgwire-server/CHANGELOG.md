# Changelog

## [0.2.1]() (2026-10-07)


### Bug Fixes

* **build:** scope package-test inputs and honor compiler caching ([#254](https://github.com/f0rr0/oliphaunt/issues/254)) ([b0e90b2](https://github.com/f0rr0/oliphaunt/commit/b0e90b279077f0d40e9270512a11ada156818f87))

## [0.2.0]() (2026-09-29)


### ⚠ BREAKING CHANGES

* **mobile:** native runtime ABI advances to 12 for streaming archive APIs; rebuild native clients and workers with matching artifacts.
* **sdk:** Native extension lists use typed selections, and native TypeScript restore accepts a directory storage descriptor instead of a path.
* **sdk:** unify embedded PostgreSQL public APIs ([#153](https://github.com/f0rr0/oliphaunt/issues/153))
* Rust WASIX removes temporary/application-data storage variants, and browser IndexedDB uses the new per-database v3 layout without migrating prior generations.
* **release:** simplify releases and make contrib runtime-owned ([#127](https://github.com/f0rr0/oliphaunt/issues/127))

### Features

* introduce oliphaunt ([a4f438c](https://github.com/f0rr0/oliphaunt/commit/a4f438c3b2770a841efc8eb9864b474eb76e6114))
* **mobile:** add unified iOS and Android broker modes ([#219](https://github.com/f0rr0/oliphaunt/issues/219)) ([6f205e9](https://github.com/f0rr0/oliphaunt/commit/6f205e966c6ce404f252ddcc5c5c1b0b8da47e31))
* **sdk:** unify embedded PostgreSQL public APIs ([#153](https://github.com/f0rr0/oliphaunt/issues/153)) ([4384d1b](https://github.com/f0rr0/oliphaunt/commit/4384d1bdfafee07e4e1963ac68027b4bcf002a1e))
* unify native and WASIX runtimes and SDKs ([#129](https://github.com/f0rr0/oliphaunt/issues/129)) ([fae2bd7](https://github.com/f0rr0/oliphaunt/commit/fae2bd7bde00ae436d9b62ba6a37d919679ac790))


### Bug Fixes

* **ci:** serialize extension source acquisition ([#195](https://github.com/f0rr0/oliphaunt/issues/195)) ([c1fd04e](https://github.com/f0rr0/oliphaunt/commit/c1fd04e797f30c20289cb7d2dc2c62bb4a4e2e6e))
* **ci:** unify Bun test entrypoints and import Swift signing keys ([#214](https://github.com/f0rr0/oliphaunt/issues/214)) ([a7724ef](https://github.com/f0rr0/oliphaunt/commit/a7724efe3ebda8c7f2e1af64d66b64fed645e3bf))
* **runtime:** close mobile package and readiness gaps [skip ci] ([60b9df9](https://github.com/f0rr0/oliphaunt/commit/60b9df9de1d710d6faeb34114ac66409b689cf22))
* **sdk:** align resource loading and extension selection ([#216](https://github.com/f0rr0/oliphaunt/issues/216)) ([b25d496](https://github.com/f0rr0/oliphaunt/commit/b25d49655de694525544c5553e77bdd83b2e1632))


### Code Refactoring

* **ci:** align product and release task boundaries ([#170](https://github.com/f0rr0/oliphaunt/issues/170)) ([009a5f5](https://github.com/f0rr0/oliphaunt/commit/009a5f5ec0659d70f6a22902c071a81e0806fabe))
* **ci:** model independent product dependencies ([#173](https://github.com/f0rr0/oliphaunt/issues/173)) ([2d5f90c](https://github.com/f0rr0/oliphaunt/commit/2d5f90c837ef7ecd8b43c2547e4b3c9b04767121))
* model product dependencies and simplify qualification ([#209](https://github.com/f0rr0/oliphaunt/issues/209)) ([e058785](https://github.com/f0rr0/oliphaunt/commit/e0587850e153fb8f8866711aa73717ca37bdb657))
* organize sources by native and WASIX runtime families ([#215](https://github.com/f0rr0/oliphaunt/issues/215)) ([a8f9bfe](https://github.com/f0rr0/oliphaunt/commit/a8f9bfe75f4cff0426f0089eb248783efacbde2e))
* **release:** simplify releases and make contrib runtime-owned ([#127](https://github.com/f0rr0/oliphaunt/issues/127)) ([c45082d](https://github.com/f0rr0/oliphaunt/commit/c45082dc522f04ed0f020464282ed79150f83ecc))

## Changelog

## Unreleased

Extract the existing WASIX socket server and command-line interface into its own product.
