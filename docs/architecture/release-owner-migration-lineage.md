# Release owner migration lineage

This is one-time cutover review material, not another release registry. Snapshot:
HEAD `e425160984872b725debd82961aaef0d9054813b`; origin/main
`f4b7a5c71c8e244f77cc08d474e06e47fe336287`. Uncommitted implementation changes
are absent; refresh the capture at the final pre-move commit.

All 20 local component tags below resolve to
`bfa867aa52b1e1bcf45f8107c072940e2a120dd6`. No owner has pending
path-local commits between its tag and this origin/main. The pending column
records commits between that tag and HEAD. Local tags establish lineage; this
is not a fresh audit of registry availability or remote pending release PRs.

## Existing owners

Move each owner's CHANGELOG.md with its source; rekey both release configuration
and manifest baseline without changing component, package identity or tag.
The floor comes from the pinned Release Please version strategy applied to
existing branch history. A dash means no path-local release selected.

| Current owner | Final owner | Stable component / tag prefix | Baseline | Pending version floor | Pending commits |
| --- | --- | --- | --- | --- | --- |
| src/runtimes/liboliphaunt/native | runtimes/liboliphaunt-native | liboliphaunt-native | 0.2.0 | 0.2.1 | 183ff83, 96de165 |
| src/sdks/rust | sdks/rust/sdk | oliphaunt-rust | 0.2.0 | 0.2.1 | 05906fc, 183ff83, 96de165 |
| src/runtimes/broker | broker | oliphaunt-broker | 0.2.0 | 0.2.1 | 9609530, 183ff83, 96de165 |
| src/runtimes/node-direct | sdks/ts/node-addon | oliphaunt-node-direct | 0.2.0 | 0.2.1 | 183ff83, 96de165 |
| src/runtimes/wasix-napi | sdks/ts-wasix/node-addon | oliphaunt-wasix-napi | 0.1.0 | 0.1.1 | 5ee8fec, 2c77120, 183ff83, 96de165 |
| src/sdks/swift | sdks/swift | oliphaunt-swift | 0.7.0 | 0.7.1 | 183ff83, 96de165 |
| src/sdks/kotlin | sdks/kotlin | oliphaunt-kotlin | 0.2.0 | 0.2.1 | 9609530, 183ff83, 96de165 |
| src/sdks/react-native | sdks/react-native | oliphaunt-react-native | 0.2.0 | 0.2.1 | 2c77120, 183ff83, 96de165 |
| src/sdks/js | sdks/ts/sdk | oliphaunt-js | 0.2.0 | 0.2.1 | c14972f, 96de165 |
| src/extensions/external/pg_hashids | extensions/external/pg_hashids | oliphaunt-extension-pg-hashids | 0.2.0 | — | — |
| src/extensions/external/pg_ivm | extensions/external/pg_ivm | oliphaunt-extension-pg-ivm | 0.2.0 | — | — |
| src/extensions/external/pg_textsearch | extensions/external/pg_textsearch | oliphaunt-extension-pg-textsearch | 0.2.0 | 0.2.1 | 96de165 |
| src/extensions/external/pg_uuidv7 | extensions/external/pg_uuidv7 | oliphaunt-extension-pg-uuidv7 | 0.2.0 | — | — |
| src/extensions/external/pgtap | extensions/external/pgtap | oliphaunt-extension-pgtap | 0.2.0 | — | — |
| src/extensions/external/postgis | extensions/external/postgis | oliphaunt-extension-postgis | 0.2.0 | 0.2.1 | 9609530, 183ff83, 96de165 |
| src/extensions/external/vector | extensions/external/vector | oliphaunt-extension-vector | 0.2.0 | — | — |
| src/runtimes/liboliphaunt/wasix | runtimes/liboliphaunt-wasix | liboliphaunt-wasix | 0.2.0 | 0.2.1 | 183ff83, 96de165 |
| src/runtimes/liboliphaunt/wasix-postmaster | runtimes/liboliphaunt-wasix-postmaster | liboliphaunt-wasix-postmaster | 0.1.0 | 0.1.1 | e425160, 5ee8fec, 2c77120, 41b04b6, 05906fc, 183ff83, 96de165 |
| src/bindings/wasix-rust/crates/oliphaunt-wasix | sdks/rust-wasix | oliphaunt-wasix-rust | 0.2.0 | 0.2.1 | 41b04b6, 96de165 |
| src/bindings/wasix-ts | sdks/ts-wasix/sdk | oliphaunt-wasix-ts | 0.1.0 | 0.1.1 | 183ff83, 96de165 |

## One-time pending release carry

1. At the final old-path commit, capture the actual Release Please candidate
   versions and notes. Preserve published manifest baselines. Capture pending
   release PR intent too; do not mark merged but unpublished releases tagged.
2. Move source/changelogs and rekey manifest/config together. Keep component IDs
   and registry names. New query packages are new owners, not aliases.
3. In the first post-move release PR, apply captured pending notes once to the
   corresponding component's candidate entry. Deduplicate by original commit
   SHA. Do not prepend a second heading for the same version. Preserve newer
   post-move notes and released historical notes verbatim.
4. If path loss chooses a lower version, use Release Please's native temporary
   release-as input for that component with its captured candidate version.
   A higher post-move candidate wins. Remove temporary inputs after consumption.
   Verify repeated preparation retains the same notes and versions before
   merging. This is reviewed one-time preparation, not permanent path aliases.
5. Refresh this capture before cutover; retain it until the first publication
   receipt completes. An unattended first post-move prepare is not ready until
   the carry is applied: plain rekeying loses pending changes.

## Verification and limits

Used the actual Release Please 17.3.0 bundle in pinned action
`5c625bfb5d1ff62eadeeb3772007f7f66fdcf071`. A disposable simulation of all
20 components verified stable tag/baseline lookup and exact equality of candidate
versions and notes before and after a one-time history-path rekey. Without the
carry, the real CommitSplit omits all old-path pending commits.

The initial simulation uses the common simple strategy to isolate path splitting,
conventional versions and notes. Additional actual ecosystem updater and workspace
simulations are described below. These checks do not publish anything or replace
the first candidate's normal validation. The disposable harness, inputs and logs are at
`/tmp/oliphaunt-release-lineage` on the implementation machine. The captured
pending notes follow, so they survive removal of that temporary directory.

## Transferred resources and PostgreSQL tools

Read-only registry capture: **2026-09-11T12:36Z**, against the active checkout.
The publication catalog identifies 22 relevant Cargo/npm/Maven identities;
crates.io additionally exposes four generated native tool payload-part crates.
All 26 direct metadata requests returned HTTP 200. All have highest published
stable version **0.2.0**, except `@oliphaunt/wasix-tools`, which has **0.1.0**.
No source manifest sentinel was used as publication evidence.

**Each of the three new owners has a minimum next-version floor of 0.2.1.**
This is a collision/history floor, not a decision that a breaking resource/API
change merits only a patch. Release Please may select a higher version. New
seed identities join the resource owner's version; they do not restart at
0.1.0. Recheck these mutable registries before the actual cutover/publication.

| Existing registry identity | Previous release owner | Final owner | Public maximum | Minimum for next publication |
| --- | --- | --- | --- | --- |
| Cargo `oliphaunt-icu` | `liboliphaunt-wasix` | `database-resources` | 0.2.0 | 0.2.1 |
| npm `@oliphaunt/icu` | `liboliphaunt-native` | `database-resources`, canonical shared ICU data | 0.2.0 | 0.2.1 |
| npm `@oliphaunt/wasix-icu` | `liboliphaunt-wasix` | `database-resources` history; retire new publication of this combined data/seed carrier | 0.2.0 | No new duplicate payload; any exceptional reuse must exceed 0.2.0 |
| Maven `dev.oliphaunt.runtime:oliphaunt-icu` | `liboliphaunt-native` | `database-resources` | 0.2.0 | 0.2.1 |
| Maven `dev.oliphaunt.runtime:liboliphaunt-runtime-resources-android-datum64` | `liboliphaunt-native` | `database-resources` | 0.2.0 | 0.2.1 |
| Cargo `oliphaunt-tools` | `liboliphaunt-native` | `postgres-tools/native` | 0.2.0 | 0.2.1 |
| Cargo `oliphaunt-tools-linux-arm64-gnu`, `oliphaunt-tools-linux-x64-gnu`, `oliphaunt-tools-macos-arm64`, `oliphaunt-tools-windows-x64-msvc` | `liboliphaunt-native` | `postgres-tools/native` | 0.2.0 each | 0.2.1 each |
| Cargo `oliphaunt-tools-linux-arm64-gnu-part-001`, `oliphaunt-tools-linux-x64-gnu-part-001`, `oliphaunt-tools-macos-arm64-part-001`, `oliphaunt-tools-windows-x64-msvc-part-001` | `liboliphaunt-native` generated payload parts | `postgres-tools/native` | 0.2.0 each | 0.2.1 each |
| npm `@oliphaunt/tools` | `liboliphaunt-native` | `postgres-tools/native` | 0.2.0 | 0.2.1 |
| npm `@oliphaunt/tools-darwin-arm64`, `@oliphaunt/tools-linux-arm64-gnu`, `@oliphaunt/tools-linux-x64-gnu`, `@oliphaunt/tools-win32-x64-msvc` | `liboliphaunt-native` | `postgres-tools/native` | 0.2.0 each | 0.2.1 each |
| Cargo `oliphaunt-wasix-tools` | `liboliphaunt-wasix` | `postgres-tools/wasix` | 0.2.0 | 0.2.1 |
| Cargo `oliphaunt-wasix-tools-aot-aarch64-apple-darwin`, `oliphaunt-wasix-tools-aot-aarch64-unknown-linux-gnu`, `oliphaunt-wasix-tools-aot-x86_64-pc-windows-msvc`, `oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu` | `liboliphaunt-wasix` | `postgres-tools/wasix` | 0.2.0 each | 0.2.1 each |
| npm `@oliphaunt/liboliphaunt-wasix-tools` | `liboliphaunt-wasix` | `postgres-tools/wasix` | 0.2.0 | 0.2.1 |
| npm `@oliphaunt/wasix-tools` | `oliphaunt-wasix-ts` | `postgres-tools/wasix` | 0.1.0 | 0.2.1 with its new owner; its individual collision floor is 0.1.1 |
| npm `@oliphaunt/liboliphaunt-wasix-tools-linux-arm64-gnu`, `@oliphaunt/liboliphaunt-wasix-tools-linux-x64-gnu`, `@oliphaunt/liboliphaunt-wasix-tools-darwin-arm64`, `@oliphaunt/liboliphaunt-wasix-tools-win32-x64-msvc` | New optional AOT carriers | `postgres-tools/wasix` | No previous publication identified | 0.2.1 with the tools owner |

The four payload-part crates each have published 0.1.0, 0.1.1 and 0.2.0
versions. A move must not lose them merely because the base catalog generates
part identities only while packaging. Future required parts inherit the tool
owner; do not create separate release owners for them.

### GitHub archives, Swift products, and seeds

The completed [native 0.2.0 release](https://github.com/f0rr0/oliphaunt/releases/tag/liboliphaunt-native-v0.2.0)
contains `liboliphaunt-0.2.0-icu-data.tar.gz` and both
`liboliphaunt-0.2.0-runtime-resources-{android,ios}-datum64.tar.gz` archives.
Their future production belongs to `database-resources`, with the same 0.2.1
minimum floor. The older unsuffixed `runtime-resources.tar.gz` archives at
0.1.0/0.1.1 remain immutable historical assets, not another new carrier.
The native release's four `oliphaunt-tools-0.2.0-{linux-arm64-gnu,linux-x64-gnu,macos-arm64,windows-x64-msvc}`
archives move to `postgres-tools/native` (tar.gz on Unix, zip on Windows).

The completed [WASIX 0.2.0 release](https://github.com/f0rr0/oliphaunt/releases/tag/liboliphaunt-wasix-v0.2.0)
contains `liboliphaunt-wasix-0.2.0-icu-data.tar.zst`; future ICU data production
belongs to `database-resources`. It has no separately named PostgreSQL-tools
archive in its public asset list. Tools are nevertheless published in the Cargo
and npm identities above; do not invent an existing GitHub tools-archive history.

The public [Swift 0.7.0 Package.swift](https://github.com/f0rr0/oliphaunt/blob/0.7.0/Package.swift)
exports `OliphauntICU` inside the existing `Oliphaunt` SwiftPM package, backed by
`generated/swiftpm/OliphauntICU` resources. **This is not an independently
versioned Swift package.** Its source wrapper/package history stays with the
Swift SDK (0.7.0 baseline); its data producer transfers to database-resources.
Do not either reset the Swift package to 0.2.1 or incorrectly raise the data
owner's floor to 0.7.1. The new selectable Swift resource delivery still needs
task 16 implementation; publishing a new data owner alone cannot avoid fetching
resources already embedded in old Swift source tags. No separate Swift or Maven
PostgreSQL-tools identity appears in the catalog/public Swift manifest.

There are currently **no independently declared seed registry identities**.
Native desktop runtime packages contain standard and ICU seed directories;
native mobile resource archives carry seed/resources. The WASIX runtime npm
carrier contains the standard seed; `@oliphaunt/wasix-icu` combines ICU data with
the ICU seed. WASIX Cargo/runtime packaging also carries seeds. Transfer those
payload producers, not the entire native/WASIX runtime package identities, to
database-resources. Runtime identities stay with their runtimes and old versions
keep their existing bundled payloads. Four logical native/WASIX × standard/ICU
seed families, plus required physical target variants, become independently
selectable carriers at the new resource owner's version.

Carry both existing ICU histories into the new owner's migration notes.
New WASIX consumers use canonical `@oliphaunt/icu` plus a separate ICU seed;
do not publish another data copy under `@oliphaunt/wasix-icu` or add a permanent
compatibility facade merely to retain that spelling. Existing published versions
and their exact dependency URLs remain available. Separate resource versioning
also requires explicit runtime/physical-format compatibility; version 0.2.1
itself proves no seed compatibility.

### Evidence and remaining boundaries

Registry evidence came from every listed crate's
`https://crates.io/api/v1/crates/<name>` metadata, every listed npm package's
`https://registry.npmjs.org/<encoded-name>` metadata, and Maven Central's
[ICU metadata](https://repo.maven.apache.org/maven2/dev/oliphaunt/runtime/oliphaunt-icu/maven-metadata.xml)
and [Android resources metadata](https://repo.maven.apache.org/maven2/dev/oliphaunt/runtime/liboliphaunt-runtime-resources-android-datum64/maven-metadata.xml).
All version arrays were inspected; npm dist-tags alone were not the floor.
Crates.io searches for `oliphaunt-tools` and `oliphaunt-wasix-tools` returned
11 and 6 results respectively (below their 100-result page limit), exposing the
four additional parts; each part then received a direct metadata read.

The disposable read-only capture is `/tmp/oliphaunt-carrier-lineage/`:
`catalog.json`, `registries.json`, `cargo-search.json`, `cargo-parts.json`,
`github.json`, and `Package-0.7.0.swift`. No selected registry was inaccessible.
This establishes names, ownership lineage and version floors, not downloaded
payload integrity, publisher permissions, or a complete first post-move release.
New seed carrier names/distribution metadata, the shared ICU package conversion,
Swift resource delivery, pending-change carry and the final exact-lock registry
recheck remain cutover work. Do not mark all of task 02a complete from this table
alone or add these observations as a second machine-maintained release catalog.

### Actual ecosystem updater results

The pinned bundle also ran the current per-package release configuration and
real owner files through the actual Rust, Node and simple strategies. Applying
their emitted updaters before and after the proposed path rekey produced exactly
equal versioned file contents and changelog notes:

| Owner | Candidate | Verified updater outputs |
| --- | --- | --- |
| Rust SDK | 0.2.1 | Cargo.toml, build-helper Cargo.toml extra version, changelog |
| TypeScript SDK | 0.2.1 | package.json with unchanged registry name, changelog |
| Swift SDK | 0.7.1 | VERSION, changelog, including its explicit pre-1.0 options |
| Kotlin SDK | 0.2.1 | VERSION, Gradle VERSION_NAME marker, changelog |

Rust's unrelated query dependency version stayed unchanged. Missing optional
owner Cargo.lock/npm lockfiles are not created by these updaters. Root lock
regeneration remains the existing native package-manager release preparation
step. Rehoming the build helper requires updating its extra-file reference in
the same move; the test verifies the existing reference's version update.

A separate actual node-workspace plugin simulation used the query/SDK package
identities with a synthetic already-published query baseline. A query fix bumped
its consumer and exact dependency from 0.1.0 to 0.1.1; disabling the plugin lost
that consumer release. Keep the plugin with merge:false. The plugin also bumps
dev-only dependents, but none of the six currently configured Node products has
another configured product in devDependencies. Thus this behavior is not a
current release blocker. Do not place unrelated maintainer tooling there as a
release-managed local product. Cargo release owners must stay individual crates:
the Rust strategy intentionally bumps every member if pointed at a workspace.

### Remote pending-release reconciliation

Read-only GitHub checks on 2026-09-11 confirmed remote main still equals the
snapshot above. All 20 baseline tags in the table exist remotely at the recorded
commit and have public, non-draft, non-prerelease GitHub releases, published on
2026-09-08. The latest merged release preparation is
[PR 186](https://github.com/f0rr0/oliphaunt/pull/186), merged at
`5fdd03ac5bd6b7fb5f3cc471014b4313379de32e`, labeled autorelease: tagged.
Its publication tags resolve to the later release source commit already recorded
above; do not substitute the PR merge SHA for those immutable tag targets.

There are no open release preparation PRs and no newer merged release
preparation awaiting publication. Pending-labeled PRs 179, 177, 167, 78, 76 and
58 are all closed and unmerged; their labels are stale, not unpublished intent.
Leave those historical PRs alone. No remote pending candidate needs an extra
carry at this snapshot; preserve the branch's captured notes below. Repeat the
read-only reconciliation at cutover because PR/release state can change.

## Captured pending notes

### liboliphaunt-native

#### [0.2.1](https://github.com/f0rr0/oliphaunt/compare/liboliphaunt-native-v0.2.0...liboliphaunt-native-v0.2.1) (2026-09-11)


##### Bug Fixes

* isolate owner tests and repair native build setup ([183ff83](https://github.com/f0rr0/oliphaunt/commit/183ff8311da860f719118046ceca8d6906ec07c1))


##### Code Refactoring

* localize product tooling and simplify release qualification ([96de165](https://github.com/f0rr0/oliphaunt/commit/96de16598206f05ca52867d36ff0c0e109bba782))

### oliphaunt-rust

#### [0.2.1](https://github.com/f0rr0/oliphaunt/compare/oliphaunt-rust-v0.2.0...oliphaunt-rust-v0.2.1) (2026-09-11)


##### Bug Fixes

* exercise LLVM installation and share lifecycle test support ([05906fc](https://github.com/f0rr0/oliphaunt/commit/05906fca19cd4561b23fa18c4d0b3aa517e6a50e))
* isolate owner tests and repair native build setup ([183ff83](https://github.com/f0rr0/oliphaunt/commit/183ff8311da860f719118046ceca8d6906ec07c1))


##### Code Refactoring

* localize product tooling and simplify release qualification ([96de165](https://github.com/f0rr0/oliphaunt/commit/96de16598206f05ca52867d36ff0c0e109bba782))

### oliphaunt-broker

#### [0.2.1](https://github.com/f0rr0/oliphaunt/compare/oliphaunt-broker-v0.2.0...oliphaunt-broker-v0.2.1) (2026-09-11)


##### Bug Fixes

* isolate owner tests and repair native build setup ([183ff83](https://github.com/f0rr0/oliphaunt/commit/183ff8311da860f719118046ceca8d6906ec07c1))


##### Code Refactoring

* localize product tooling and simplify release qualification ([96de165](https://github.com/f0rr0/oliphaunt/commit/96de16598206f05ca52867d36ff0c0e109bba782))
* remove oversized fixtures and keep tests with their owners ([9609530](https://github.com/f0rr0/oliphaunt/commit/96095307126f14c35ed965501d2f3e07d77f621c))

### oliphaunt-node-direct

#### [0.2.1](https://github.com/f0rr0/oliphaunt/compare/oliphaunt-node-direct-v0.2.0...oliphaunt-node-direct-v0.2.1) (2026-09-11)


##### Bug Fixes

* isolate owner tests and repair native build setup ([183ff83](https://github.com/f0rr0/oliphaunt/commit/183ff8311da860f719118046ceca8d6906ec07c1))


##### Code Refactoring

* localize product tooling and simplify release qualification ([96de165](https://github.com/f0rr0/oliphaunt/commit/96de16598206f05ca52867d36ff0c0e109bba782))

### oliphaunt-wasix-napi

#### [0.1.1](https://github.com/f0rr0/oliphaunt/compare/oliphaunt-wasix-napi-v0.1.0...oliphaunt-wasix-napi-v0.1.1) (2026-09-11)


##### Bug Fixes

* **ci:** qualify unprivileged carriers and provision evidence dependencies ([5ee8fec](https://github.com/f0rr0/oliphaunt/commit/5ee8fecf00bbb41c1fa31f9501ad2c16070e6783))
* **ci:** repair cache restores and carrier qualification ([2c77120](https://github.com/f0rr0/oliphaunt/commit/2c771205fda376acb4b81a89d3d510e2b48838a3))
* isolate owner tests and repair native build setup ([183ff83](https://github.com/f0rr0/oliphaunt/commit/183ff8311da860f719118046ceca8d6906ec07c1))


##### Code Refactoring

* localize product tooling and simplify release qualification ([96de165](https://github.com/f0rr0/oliphaunt/commit/96de16598206f05ca52867d36ff0c0e109bba782))

### oliphaunt-swift

#### [0.7.1](https://github.com/f0rr0/oliphaunt/compare/oliphaunt-swift-v0.7.0...oliphaunt-swift-v0.7.1) (2026-09-11)


##### Bug Fixes

* isolate owner tests and repair native build setup ([183ff83](https://github.com/f0rr0/oliphaunt/commit/183ff8311da860f719118046ceca8d6906ec07c1))


##### Code Refactoring

* localize product tooling and simplify release qualification ([96de165](https://github.com/f0rr0/oliphaunt/commit/96de16598206f05ca52867d36ff0c0e109bba782))

### oliphaunt-kotlin

#### [0.2.1](https://github.com/f0rr0/oliphaunt/compare/oliphaunt-kotlin-v0.2.0...oliphaunt-kotlin-v0.2.1) (2026-09-11)


##### Bug Fixes

* isolate owner tests and repair native build setup ([183ff83](https://github.com/f0rr0/oliphaunt/commit/183ff8311da860f719118046ceca8d6906ec07c1))


##### Code Refactoring

* localize product tooling and simplify release qualification ([96de165](https://github.com/f0rr0/oliphaunt/commit/96de16598206f05ca52867d36ff0c0e109bba782))
* remove oversized fixtures and keep tests with their owners ([9609530](https://github.com/f0rr0/oliphaunt/commit/96095307126f14c35ed965501d2f3e07d77f621c))

### oliphaunt-react-native

#### [0.2.1](https://github.com/f0rr0/oliphaunt/compare/oliphaunt-react-native-v0.2.0...oliphaunt-react-native-v0.2.1) (2026-09-11)


##### Bug Fixes

* **ci:** repair cache restores and carrier qualification ([2c77120](https://github.com/f0rr0/oliphaunt/commit/2c771205fda376acb4b81a89d3d510e2b48838a3))
* isolate owner tests and repair native build setup ([183ff83](https://github.com/f0rr0/oliphaunt/commit/183ff8311da860f719118046ceca8d6906ec07c1))


##### Code Refactoring

* localize product tooling and simplify release qualification ([96de165](https://github.com/f0rr0/oliphaunt/commit/96de16598206f05ca52867d36ff0c0e109bba782))

### oliphaunt-js

#### [0.2.1](https://github.com/f0rr0/oliphaunt/compare/oliphaunt-js-v0.2.0...oliphaunt-js-v0.2.1) (2026-09-11)


##### Bug Fixes

* avoid duplicate docs checks and type native SDK smoke helpers ([c14972f](https://github.com/f0rr0/oliphaunt/commit/c14972f457a0bdcca2b97910a710e9b5e6495afb))


##### Code Refactoring

* localize product tooling and simplify release qualification ([96de165](https://github.com/f0rr0/oliphaunt/commit/96de16598206f05ca52867d36ff0c0e109bba782))

### oliphaunt-extension-pg-textsearch

#### [0.2.1](https://github.com/f0rr0/oliphaunt/compare/oliphaunt-extension-pg-textsearch-v0.2.0...oliphaunt-extension-pg-textsearch-v0.2.1) (2026-09-11)


##### Code Refactoring

* localize product tooling and simplify release qualification ([96de165](https://github.com/f0rr0/oliphaunt/commit/96de16598206f05ca52867d36ff0c0e109bba782))

### oliphaunt-extension-postgis

#### [0.2.1](https://github.com/f0rr0/oliphaunt/compare/oliphaunt-extension-postgis-v0.2.0...oliphaunt-extension-postgis-v0.2.1) (2026-09-11)


##### Bug Fixes

* isolate owner tests and repair native build setup ([183ff83](https://github.com/f0rr0/oliphaunt/commit/183ff8311da860f719118046ceca8d6906ec07c1))


##### Code Refactoring

* localize product tooling and simplify release qualification ([96de165](https://github.com/f0rr0/oliphaunt/commit/96de16598206f05ca52867d36ff0c0e109bba782))
* remove oversized fixtures and keep tests with their owners ([9609530](https://github.com/f0rr0/oliphaunt/commit/96095307126f14c35ed965501d2f3e07d77f621c))

### liboliphaunt-wasix

#### [0.2.1](https://github.com/f0rr0/oliphaunt/compare/liboliphaunt-wasix-v0.2.0...liboliphaunt-wasix-v0.2.1) (2026-09-11)


##### Bug Fixes

* isolate owner tests and repair native build setup ([183ff83](https://github.com/f0rr0/oliphaunt/commit/183ff8311da860f719118046ceca8d6906ec07c1))


##### Code Refactoring

* localize product tooling and simplify release qualification ([96de165](https://github.com/f0rr0/oliphaunt/commit/96de16598206f05ca52867d36ff0c0e109bba782))

### liboliphaunt-wasix-postmaster

#### [0.1.1](https://github.com/f0rr0/oliphaunt/compare/liboliphaunt-wasix-postmaster-v0.1.0...liboliphaunt-wasix-postmaster-v0.1.1) (2026-09-11)


##### Bug Fixes

* **ci:** qualify unprivileged carriers and provision evidence dependencies ([5ee8fec](https://github.com/f0rr0/oliphaunt/commit/5ee8fecf00bbb41c1fa31f9501ad2c16070e6783))
* **ci:** repair cache restores and carrier qualification ([2c77120](https://github.com/f0rr0/oliphaunt/commit/2c771205fda376acb4b81a89d3d510e2b48838a3))
* **ci:** repair cold client builds and Windows backup paths ([41b04b6](https://github.com/f0rr0/oliphaunt/commit/41b04b630ed4aa3014cee23758bd3f7c312fbbe7))
* exercise LLVM installation and share lifecycle test support ([05906fc](https://github.com/f0rr0/oliphaunt/commit/05906fca19cd4561b23fa18c4d0b3aa517e6a50e))
* isolate owner tests and repair native build setup ([183ff83](https://github.com/f0rr0/oliphaunt/commit/183ff8311da860f719118046ceca8d6906ec07c1))
* **postmaster:** include release asset finalizer in source checkout ([e425160](https://github.com/f0rr0/oliphaunt/commit/e425160984872b725debd82961aaef0d9054813b))


##### Code Refactoring

* localize product tooling and simplify release qualification ([96de165](https://github.com/f0rr0/oliphaunt/commit/96de16598206f05ca52867d36ff0c0e109bba782))

### oliphaunt-wasix-rust

#### [0.2.1](https://github.com/f0rr0/oliphaunt/compare/oliphaunt-wasix-rust-v0.2.0...oliphaunt-wasix-rust-v0.2.1) (2026-09-11)


##### Bug Fixes

* **ci:** repair cold client builds and Windows backup paths ([41b04b6](https://github.com/f0rr0/oliphaunt/commit/41b04b630ed4aa3014cee23758bd3f7c312fbbe7))


##### Code Refactoring

* localize product tooling and simplify release qualification ([96de165](https://github.com/f0rr0/oliphaunt/commit/96de16598206f05ca52867d36ff0c0e109bba782))

### oliphaunt-wasix-ts

#### [0.1.1](https://github.com/f0rr0/oliphaunt/compare/oliphaunt-wasix-ts-v0.1.0...oliphaunt-wasix-ts-v0.1.1) (2026-09-11)


##### Bug Fixes

* isolate owner tests and repair native build setup ([183ff83](https://github.com/f0rr0/oliphaunt/commit/183ff8311da860f719118046ceca8d6906ec07c1))


##### Code Refactoring

* localize product tooling and simplify release qualification ([96de165](https://github.com/f0rr0/oliphaunt/commit/96de16598206f05ca52867d36ff0c0e109bba782))
