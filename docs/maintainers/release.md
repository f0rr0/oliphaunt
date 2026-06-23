# Release Process

Oliphaunt is released as independent product lanes. The repository version is
not a product version.

The canonical public release repository is repository `f0rr0/oliphaunt`.

## Products

Release-please components define the public release products:

- `liboliphaunt-native`: native C ABI runtime, PostgreSQL 18 patch stack,
  platform libraries, runtime resources, and native exact-extension artifacts.
- `liboliphaunt-wasix`: WASIX runtime assets and AOT asset crates.
- `oliphaunt-rust`: Rust SDK crate.
- `oliphaunt-broker`: Rust broker helper runtime.
- `oliphaunt-node-direct`: Node direct native runtime.
- `oliphaunt-swift`: Swift SDK for iOS and macOS.
- `oliphaunt-kotlin`: Kotlin/Android SDK and Android Gradle plugin.
- `oliphaunt-react-native`: React Native New Architecture SDK.
- `oliphaunt-js`: TypeScript SDK for Node.js, Bun, Deno, and Tauri
  JavaScript apps.
- `oliphaunt-wasix-rust`: Rust binding crate for the WASIX runtime.
- `oliphaunt-extension-*`: exact SQL extension artifact products.

## Release Authority

Release-please manifest mode owns product versions, changelogs, release PRs,
and product-scoped tags. Product-local `release.toml` files declare owner, kind,
publish targets, registry packages, release artifacts, and compatibility-version
files. Moon owns dependency scopes and path ownership.

`tools/release/release.py plan` computes release impact as:

1. map changed files to owning Moon projects;
2. follow Moon dependencies with `production` or `peer` scope;
3. map selected Moon projects to release-please products.

Build/test-only Moon dependencies affect CI but do not force package releases.
Docs, root README, examples, fixtures, benchmark plans, CI policy, and
maintainer-only files do not trigger product releases unless they change a
product-owned package source that release-please tracks.

Do not add a second release dependency graph. If a product must be published
with another product, model the real dependency in Moon without violating Moon
layering or cycles, and make sure release-please can see a release-affecting
change for each independently versioned product. Exact extension artifact
products are Moon `library` projects because they are independently publishable
runtime-compatible products; they depend on the native runtime, the WASIX
runtime, and the shared extension runtime contract. Release PR checks compare
Moon-selected products with release-please manifest version bumps so a release
cannot merge with products selected for publish but missing release-please
versions/tags.

## Commands

Use these commands while preparing or checking releases:

```sh
tools/release/release.py plan
tools/release/release.py check
tools/release/release.py check-registries
tools/release/release.py publish-dry-run
tools/release/release.py publish
tools/release/release.py verify-release
tools/release/release.py consumer-shape
```

`consumer-shape` validates tracked package metadata, install docs, SwiftPM,
Gradle, Expo, React Native, asset resolver hooks, exact-extension selection,
dependency pins, and install-script safety. It is a package-shape gate, not a
standing broad clean-registry reinstall policy. Final registry and asset proof
belongs to `check-registries`, package-native dry-runs, `publish`, and
`verify-release`.

## Product Releases

PRs that change release-affecting product surfaces must use a
release-producing Conventional Commit title:

- `feat:` for user-facing additions;
- `fix:` for behavior fixes;
- `perf:` for performance improvements;
- `refactor:` for behavior-preserving product changes that still need a
  release;
- `revert:` for reverted release-affecting changes;
- any type with `!` for breaking changes.

Docs, CI, test, examples, fixtures, and maintainer-only PRs can use non-release
types such as `docs:`, `ci:`, `chore:`, `style:`, or `test:` when the release
plan selects no product.

Feature and fix PRs must not edit package versions directly. Version bumps and
changelog entries belong to release-please release PRs. For a product with no
product-scoped tag yet, the release PR prepares the checked-in version as the
first release. After the first tag exists, release-please bumps that product
from release-affecting commits since its own latest product tag.

## Tags

Product tags are scoped by product:

- `liboliphaunt-native-v0.1.0`
- `liboliphaunt-wasix-v0.5.1`
- `oliphaunt-rust-v0.1.0`
- `oliphaunt-broker-v0.1.0`
- `oliphaunt-node-direct-v0.1.0`
- `oliphaunt-swift-v0.1.0`
- `oliphaunt-kotlin-v0.1.0`
- `oliphaunt-react-native-v0.1.0`
- `oliphaunt-js-v0.1.0`
- `oliphaunt-wasix-rust-v0.5.1`
- `oliphaunt-extension-vector-v0.1.0`

The WASIX Rust crate can read legacy unscoped tags for migration history, but
new product identity uses product-scoped tags.

## Native Artifacts

Native runtime artifacts are release assets consumed by SDK tooling. The active
native target matrix is declared under
`src/runtimes/liboliphaunt/native/targets/` and includes desktop/server targets
plus mobile targets that apps consume as prebuilt artifacts.

Downstream SDKs must consume published native artifacts through normal
ecosystem mechanisms:

- Rust/Tauri resolves the native runtime and broker helper through Rust SDK
  tooling and GitHub release assets.
- Swift resolves Apple artifacts through SwiftPM-compatible release assets.
- Kotlin/Android resolves Android ABI artifacts through the Android Gradle
  plugin and GitHub release assets.
- React Native delegates iOS to Swift and Android to Kotlin.
- TypeScript resolves Node direct and broker helper artifacts through npm/JSR
  metadata and GitHub release assets.

Developers must not need to clone this repository or compile PostgreSQL as the
normal install path.

## Extensions

Extensions are exact SQL extension artifact products. There are no extension
packs, aliases, or grouped selectors.

Contrib extension metadata lives under `src/extensions/contrib/`. External
extensions live under `src/extensions/external/<name>/` and own their own
source pin, recipe, target metadata, tests, version, changelog, and
`release.toml`.

Each exact extension `release.toml` declares an `[extension]` table:

- `class = "contrib"` uses PostgreSQL 18 source identity and is
  `postgres-bound`;
- `class = "external"` uses the extension's own `source.toml` and is
  `upstream-bound`;
- `class = "first-party"` is reserved for Oliphaunt-owned non-contrib
  extensions with repo-bound source identity;
- `[extension.compatibility]` names PostgreSQL major 18, the shared extension
  runtime contract, native/WASIX runtime product families, and checked native
  and WASIX runtime compatibility versions.

An external extension source change releases that extension artifact product.
It does not release SDKs unless SDK-visible generated source or compatibility
metadata changes. PostgreSQL contrib source changes release all contrib exact
extension products. Native or WASIX runtime changes release the exact extension
products that are runtime-compatible with those artifacts through normal Moon
dependencies. The extension runtime contract is shared by native and WASIX;
changes to that contract correctly affect extension artifacts and runtime lanes
through the normal Moon graph. Runtime compatibility versions in extension
`release.toml` files are derived by `sync_release_pr.py --check`; they record
which runtime product versions an exact extension artifact was built against,
but release-please still owns the extension product version, changelog, and tag.

Exact extension CI writes an internal staging manifest with local paths and a
public release manifest without local CI paths. Release verification reads the
public manifest, validates checksums and target coverage, and rejects public
manifests that add fields outside the published schema or leak local asset
paths.

App developers select exactly the SQL extensions they use. Release artifacts
and SDK packaging checks must prove unselected extensions do not enter consumer
apps.

## Recovery

Publish workflows are idempotent for already-published immutable artifacts:
registry checks skip products already published at the release commit, and
GitHub release asset upload skips existing assets with matching checksums. A
conflicting GitHub asset fails unless the maintainer intentionally reruns the
validated publish command with `--replace-conflicting-assets`, or reruns the
Release workflow with `operation = publish` and
`replace_conflicting_assets = true`.

## Provenance

Every native runtime, broker helper, Node direct runtime, WASIX runtime, AOT
asset, and exact-extension release asset must be covered by:

- checksum manifests;
- GitHub artifact attestations;
- product-local target metadata;
- package-size evidence where applicable;
- `tools/release/release.py verify-release`.

Package-native publication remains package-native: Cargo publishes Rust crates,
npm publishes JavaScript/React Native packages, Gradle/Vanniktech publishes
Maven artifacts, SwiftPM resolves tags/assets, and GitHub Releases publish
binary assets.
