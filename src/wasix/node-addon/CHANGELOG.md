# Changelog

## [0.2.0]() (2026-09-29)


### ⚠ BREAKING CHANGES

* **mobile:** native runtime ABI advances to 12 for streaming archive APIs; rebuild native clients and workers with matching artifacts.
* **sdk:** Native extension lists use typed selections, and native TypeScript restore accepts a directory storage descriptor instead of a path.

### Features

* **mobile:** add unified iOS and Android broker modes ([#219](https://github.com/f0rr0/oliphaunt/issues/219)) ([6f205e9](https://github.com/f0rr0/oliphaunt/commit/6f205e966c6ce404f252ddcc5c5c1b0b8da47e31))


### Bug Fixes

* **ci:** unify Bun test entrypoints and import Swift signing keys ([#214](https://github.com/f0rr0/oliphaunt/issues/214)) ([a7724ef](https://github.com/f0rr0/oliphaunt/commit/a7724efe3ebda8c7f2e1af64d66b64fed645e3bf))
* **sdk:** align resource loading and extension selection ([#216](https://github.com/f0rr0/oliphaunt/issues/216)) ([b25d496](https://github.com/f0rr0/oliphaunt/commit/b25d49655de694525544c5553e77bdd83b2e1632))


### Code Refactoring

* model product dependencies and simplify qualification ([#209](https://github.com/f0rr0/oliphaunt/issues/209)) ([e058785](https://github.com/f0rr0/oliphaunt/commit/e0587850e153fb8f8866711aa73717ca37bdb657))
* organize sources by native and WASIX runtime families ([#215](https://github.com/f0rr0/oliphaunt/issues/215)) ([a8f9bfe](https://github.com/f0rr0/oliphaunt/commit/a8f9bfe75f4cff0426f0089eb248783efacbde2e))

## 0.1.0 (2026-09-05)


### ⚠ BREAKING CHANGES

* **wasix-ts:** run host runtimes through Rust Node-API ([#156](https://github.com/f0rr0/oliphaunt/issues/156))

### Features

* **wasix-ts:** run host runtimes through Rust Node-API ([#156](https://github.com/f0rr0/oliphaunt/issues/156)) ([28e07be](https://github.com/f0rr0/oliphaunt/commit/28e07be782388915b28ad3fd30e3e78143710d28))


### Code Refactoring

* **ci:** align product and release task boundaries ([#170](https://github.com/f0rr0/oliphaunt/issues/170)) ([009a5f5](https://github.com/f0rr0/oliphaunt/commit/009a5f5ec0659d70f6a22902c071a81e0806fabe))
* **ci:** model independent product dependencies ([#173](https://github.com/f0rr0/oliphaunt/issues/173)) ([2d5f90c](https://github.com/f0rr0/oliphaunt/commit/2d5f90c837ef7ecd8b43c2547e4b3c9b04767121))
