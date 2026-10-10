# Changelog

## [0.2.3]() (2026-10-11)


### Bug Fixes

* **release:** bind publication to package contracts and consumers ([#288](https://github.com/f0rr0/oliphaunt/issues/288)) ([027ffdc](https://github.com/f0rr0/oliphaunt/commit/027ffdcca83824a7a455926d4546a6b98b09c3c2))
* **release:** bind qualification to exact package versions ([#280](https://github.com/f0rr0/oliphaunt/issues/280)) ([cd68c6c](https://github.com/f0rr0/oliphaunt/commit/cd68c6c9655f53c50a3a98d4db36cfc256d26a3c))
* **release:** validate default SDK and extension installations ([#293](https://github.com/f0rr0/oliphaunt/issues/293)) ([8316eb4](https://github.com/f0rr0/oliphaunt/commit/8316eb419999f47d6d4a61a8444e6c5ef32caf46))
* **wasix-ts:** initialize browser Worker storage without a seed ([#286](https://github.com/f0rr0/oliphaunt/issues/286)) ([0f5bfcd](https://github.com/f0rr0/oliphaunt/commit/0f5bfcdb42389ce8ad6a8f479203471d827a3865))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @oliphaunt/ts-query bumped from 0.1.1 to 0.1.2
* Require liboliphaunt-wasix@0.3.3 for the default extension install.
* Require oliphaunt-wasix-napi@0.2.2 for the default extension install.

## [0.2.2]() (2026-10-07)


### Bug Fixes

* **packaging:** preserve independent SDK compatibility pins ([#251](https://github.com/f0rr0/oliphaunt/issues/251)) ([dabb453](https://github.com/f0rr0/oliphaunt/commit/dabb45393b209d99bcc9c18eb40daca828de68e2))
* **packaging:** restore WASIX initdb and isolate Android C++ runtime ([#245](https://github.com/f0rr0/oliphaunt/issues/245)) ([96c566a](https://github.com/f0rr0/oliphaunt/commit/96c566a7251aae09e441cc0fc4479c58c8809f58))
* **release:** preserve dependency identity across SDK stages ([#253](https://github.com/f0rr0/oliphaunt/issues/253)) ([207fcfa](https://github.com/f0rr0/oliphaunt/commit/207fcfa5cb0cccad89545b84e95356692ee12cd9))
* **release:** validate published consumer compatibility ([#259](https://github.com/f0rr0/oliphaunt/issues/259)) ([e918d6a](https://github.com/f0rr0/oliphaunt/commit/e918d6adf3deeafb38205ce61402e40896d2f3c1))

## [0.2.1]() (2026-10-05)


### Bug Fixes

* **packaging:** restore WASIX initdb and isolate Android C++ runtime ([#245](https://github.com/f0rr0/oliphaunt/issues/245)) ([96c566a](https://github.com/f0rr0/oliphaunt/commit/96c566a7251aae09e441cc0fc4479c58c8809f58))

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


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @oliphaunt/ts-query bumped from 0.1.0 to 0.1.1

## 0.1.0 (2026-09-05)


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


### Code Refactoring

* **ci:** align product and release task boundaries ([#170](https://github.com/f0rr0/oliphaunt/issues/170)) ([009a5f5](https://github.com/f0rr0/oliphaunt/commit/009a5f5ec0659d70f6a22902c071a81e0806fabe))
* **ci:** model independent product dependencies ([#173](https://github.com/f0rr0/oliphaunt/issues/173)) ([2d5f90c](https://github.com/f0rr0/oliphaunt/commit/2d5f90c837ef7ecd8b43c2547e4b3c9b04767121))
