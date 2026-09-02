# Changelog

## 0.1.0 (2026-09-02)


### ⚠ BREAKING CHANGES

* **wasix-ts:** run host runtimes through Rust Node-API ([#156](https://github.com/f0rr0/oliphaunt/issues/156))
* **sdk:** unify embedded PostgreSQL public APIs ([#153](https://github.com/f0rr0/oliphaunt/issues/153))
* Rust WASIX removes temporary/application-data storage variants, and browser IndexedDB uses the new per-database v3 layout without migrating prior generations.

### Features

* **sdk:** unify embedded PostgreSQL public APIs ([#153](https://github.com/f0rr0/oliphaunt/issues/153)) ([4384d1b](https://github.com/f0rr0/oliphaunt/commit/4384d1bdfafee07e4e1963ac68027b4bcf002a1e))
* unify native and WASIX runtimes and SDKs ([#129](https://github.com/f0rr0/oliphaunt/issues/129)) ([fae2bd7](https://github.com/f0rr0/oliphaunt/commit/fae2bd7bde00ae436d9b62ba6a37d919679ac790))
* **wasix-ts:** run host runtimes through Rust Node-API ([#156](https://github.com/f0rr0/oliphaunt/issues/156)) ([28e07be](https://github.com/f0rr0/oliphaunt/commit/28e07be782388915b28ad3fd30e3e78143710d28))


### Bug Fixes

* **ci:** preserve native lifecycle server sessions ([#165](https://github.com/f0rr0/oliphaunt/issues/165)) ([b8cab0b](https://github.com/f0rr0/oliphaunt/commit/b8cab0be2b86c6b9fab4c279add89113c5797d23))


### Performance Improvements

* **js:** streamline exec response handling ([#158](https://github.com/f0rr0/oliphaunt/issues/158)) ([5eaf05b](https://github.com/f0rr0/oliphaunt/commit/5eaf05b8a8d21bd974b9fcb6d618103be5689151))
* **wasix:** preserve and accelerate seek end ([#154](https://github.com/f0rr0/oliphaunt/issues/154)) ([169852f](https://github.com/f0rr0/oliphaunt/commit/169852f22d1c5eab4cfd30c17ccca014b8d84592))
