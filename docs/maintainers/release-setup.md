# Release Setup

This is the one-time external setup needed before Oliphaunt can publish from
GitHub Actions. Release-please configuration owns versions, changelogs, release
PRs, and product tags; Moon owns the product dependency graph; product-local
`release.toml` files own package and artifact metadata. This document covers
the accounts, registry settings, environments, and secrets that live outside
the repository.

The canonical public repository identity is `f0rr0/oliphaunt`. Configure the
registries only after the GitHub repository has that name, because Cargo, npm
provenance, JSR provenance, SwiftPM Git tags, GitHub release URLs, and Maven POM
metadata all use that identity.

Release setup is considered ready only when consumers install Oliphaunt through
normal platform package managers:

- Rust/Tauri: `cargo add oliphaunt`
- iOS/macOS Swift: Xcode or SwiftPM using
  `https://github.com/f0rr0/oliphaunt.git`
- Android/Kotlin: Maven Central plus `id("dev.oliphaunt.android")`
- React Native/Expo: `pnpm add @oliphaunt/react-native` plus the Expo config
  plugin
- TypeScript/Node/Bun: `pnpm add @oliphaunt/ts`
- TypeScript/Deno: `deno add jsr:@oliphaunt/ts`
- WASM: crates.io/GitHub release assets for the WASM product lane

Those paths may fetch checksum-covered GitHub release assets behind the scenes,
but app developers should not clone this repository, copy PostgreSQL resources,
manually download XCFrameworks, or publish/consume Oliphaunt through CocoaPods
trunk.
Normal app consumers must not install Rust, run Cargo, build PostgreSQL, or
compile Oliphaunt native artifacts from source unless they are intentionally
using the Rust SDK or contributing to this repository.

## GitHub

Create three environments under repository settings:

| Environment | Purpose | Required secrets |
| --- | --- | --- |
| `release-pr` | Creates the generated release PR. | `RELEASE_PR_TOKEN` |
| `release-dry-run` | Runs publish dry-runs without registry write secrets. | none |
| `release-publish` | Publishes registries and release assets. | `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD`, `MAVEN_GPG_PRIVATE_KEY`, `MAVEN_GPG_KEY_ID`, `MAVEN_GPG_PASSPHRASE` |

Recommended environment protection:

- `release-pr`: no reviewer requirement, but restrict to `main`.
- `release-dry-run`: no registry secrets; optional maintainer reviewer.
- `release-publish`: require maintainer review, prevent self-review, disallow
  administrator bypass, and restrict deployment branches to `main`.

Repository Actions settings:

- Allow GitHub Actions to create pull requests.
- Keep workflow permissions at least read/write for the release workflow.
- Keep `id-token: write` and `attestations: write` on publish jobs. The
  workflow already declares these permissions; the repository must not disable
  Actions OIDC.

`RELEASE_PR_TOKEN` should be a GitHub App installation token or maintainer bot
token that can push `release/<products>-<plan-hash>` release-intent branches
and open/update PRs. Do not use the default `GITHUB_TOKEN` for this path,
because PR workflows triggered by the default token do not run as normal
human-authored PR checks.
After release-please runs, the workflow looks for the open generated release PR,
checks out that PR branch, runs `tools/release/sync_release_pr.py`, and commits
derived compatibility files and lockfile updates back to the same PR when
needed. If no release PR exists, the sync step exits cleanly. Run
`tools/release/sync_release_pr.py --check` locally after manual version
experiments; it is also part of `tools/release/release.py check`.

The publish job still needs the repository-scoped `GITHUB_TOKEN` for GitHub
release asset uploads, artifact attestations, release-please release creation,
and the SwiftPM semver tag. The workflow passes that token automatically; local
release CLI experiments that touch asset-backed products must set `GH_TOKEN` or
`GITHUB_TOKEN`.

Useful verification:

```bash
gh repo view f0rr0/oliphaunt
gh workflow list --repo f0rr0/oliphaunt
tools/release/release.py plan --from-product-tags --include-current-tags --head-ref HEAD
tools/release/release.py check
```

## crates.io

Products:

- `oliphaunt`
- `oliphaunt-wasix`
- `oliphaunt-wasix-assets`
- `oliphaunt-wasix-aot-aarch64-apple-darwin`
- `oliphaunt-wasix-aot-x86_64-unknown-linux-gnu`
- `oliphaunt-wasix-aot-aarch64-unknown-linux-gnu`
- `oliphaunt-wasix-aot-x86_64-pc-windows-msvc`

Setup:

1. Create or log in to the crates.io account that will own the crates.
2. Perform the first publication manually for each new crate. crates.io trusted
   publishing cannot create brand-new crates; it can publish later versions
   after the crate exists.
3. Add all maintainers who should have owner access.
4. Configure trusted publishing for every crate:
   - owner: `f0rr0`
   - repository: `oliphaunt`
   - workflow filename: `release.yml`
   - environment: `release-publish`
5. Do not add `CARGO_REGISTRY_TOKEN` to the repository. Cargo publishing runs
   inside the protected `Release` workflow and obtains short-lived crates.io
   credentials through GitHub Actions OIDC when trusted publishing is
   configured.

Manual first-publish should happen from the exact release artifacts produced by
the release workflow or an equivalent local staged release workspace, not from a
hand-edited tree. After that bootstrap, all Cargo publishing should go through
the `Release` workflow.

Manual registry bootstrap is a release-completion state, not a consumer install
path. If a registry forces a first manual package-version publish before trusted
publishing can be configured, create and push the matching product tag at the
same release commit before rerunning `Release` as a completion run. For example,
`oliphaunt-rust-v0.1.0` must point at the exact commit that produced
`oliphaunt 0.1.0`. Without that tag, release validation rejects the already
published version and tells maintainers to prepare a new version instead.

## npm

Product:

- `@oliphaunt/react-native`
- `@oliphaunt/ts`

Setup:

1. Create or claim the `@oliphaunt` npm organization/scope.
2. Ensure the package metadata keeps:
   - `repository.url`: `git+https://github.com/f0rr0/oliphaunt.git`
   - `repository.directory`: `src/sdks/react-native` or
     `src/sdks/js`
   - `publishConfig.access`: `public`
   - `publishConfig.provenance`: `true`
3. In the npm package settings for each package, add a trusted publisher:
   - provider: GitHub Actions
   - organization/user: `f0rr0`
   - repository: `oliphaunt`
   - workflow filename: `release.yml`
   - environment: `release-publish`
   - allowed action: `npm publish`
4. After trusted publishing works, set publishing access to require 2FA and
   disallow classic tokens.

npm trusted publishing requires npm CLI `11.5.1` or newer and Node `22.14.0` or
newer. The release workflow uses the repo-pinned Node `22.22.3`, installs npm
`11.5.1`, and checks the npm CLI version before packing or publishing.

If npm requires a package to exist before its package settings page is
available, do one manual first publish from the exact packed release artifact,
configure trusted publishing immediately after that, and revoke any temporary
automation token.
That manual first publish has the same product-tag rule as crates.io: push the
matching `oliphaunt-react-native-v<version>` or `oliphaunt-js-v<version>` tag at
the release commit before rerunning the publish workflow as a completion run.

## JSR

Product:

- `jsr:@oliphaunt/ts`

Setup:

1. Create or claim the `@oliphaunt` scope on JSR.
2. Create the `@oliphaunt/ts` package.
3. Link the package to GitHub repository `f0rr0/oliphaunt` from the package
   settings.
4. Keep `src/sdks/js/jsr.json` as the JSR source of version and export
   metadata. It is release-owned and is updated with `package.json`.
5. Do not add a `JSR_TOKEN` secret for GitHub Actions publish. The release
   workflow uses JSR's GitHub Actions OIDC publishing path, so package versions
   published from the release workflow receive JSR provenance.

Local dry-run equivalent:

```bash
pnpm --dir src/sdks/js install --frozen-lockfile
pnpm --dir src/sdks/js exec jsr publish --dry-run
```

The TypeScript SDK resolves desktop native assets the same way consumers expect
other native packages to behave: the published package pins the compatible
`liboliphaunt` version, downloads the matching `liboliphaunt-native-v*` GitHub release
asset on first use, verifies it against
`liboliphaunt-<version>-release-assets.sha256`, and caches the extracted
library plus PostgreSQL runtime directory. `libraryPath`, `runtimeDirectory`,
`LIBOLIPHAUNT_PATH`, and `OLIPHAUNT_RUNTIME_DIR` remain development overrides,
not the public install story.

Deno can also consume npm packages through its npm compatibility layer, but the
native Deno release target is JSR. Keep JSR as the Deno-first registry because
it publishes TypeScript source, validates public types during
`jsr publish --dry-run`, and supports GitHub Actions OIDC provenance without a
long-lived token.

Bun consumes the npm artifact, not a separate registry artifact. The release
workflow installs a pinned Bun toolchain and the clean-consumer gate runs
`bun add @oliphaunt/ts`, so the npm package is verified under Bun as a normal
app would use it.

If JSR ever requires a one-time manual version publish to create the package
identity, use the exact generated release artifact and then push the matching
`oliphaunt-js-v<version>` product tag at the release commit before the workflow
completion run.

## Maven Central

Product:

- `dev.oliphaunt:oliphaunt`
- Gradle plugin marker for `dev.oliphaunt.android`

Setup:

1. Create a Sonatype Central Portal account.
2. Register and verify the `dev.oliphaunt` namespace. Because this group ID
   comes from `oliphaunt.dev`, the publisher must control the domain/DNS.
3. Generate a Central Portal user token.
4. Create a GPG signing key dedicated to release signing.
5. Export the ASCII-armored private key for CI:

   ```bash
   gpg --export-secret-keys --armor <key-id> > maven-signing-key.asc
   ```

6. Add these secrets to the `release-publish` environment:
   - `MAVEN_CENTRAL_USERNAME`: Central Portal token username
   - `MAVEN_CENTRAL_PASSWORD`: Central Portal token password
   - `MAVEN_GPG_PRIVATE_KEY`: full ASCII-armored private key
   - `MAVEN_GPG_KEY_ID`: signing key id
   - `MAVEN_GPG_PASSPHRASE`: signing key passphrase

The workflow maps these secrets to Vanniktech/Gradle properties:

- `ORG_GRADLE_PROJECT_mavenCentralUsername`
- `ORG_GRADLE_PROJECT_mavenCentralPassword`
- `ORG_GRADLE_PROJECT_signingInMemoryKey`
- `ORG_GRADLE_PROJECT_signingInMemoryKeyId`
- `ORG_GRADLE_PROJECT_signingInMemoryKeyPassword`

Local dry-run equivalent:

```bash
src/sdks/kotlin/gradlew -p src/sdks/kotlin \
  :oliphaunt:publishToMavenLocal \
  :oliphaunt-android-gradle-plugin:publishToMavenLocal \
  -PoliphauntBuildRoot="$PWD/target/liboliphaunt-sdk-check/gradle/oliphaunt-kotlin-release" \
  -PoliphauntCxxBuildRoot="$PWD/target/liboliphaunt-sdk-check/cxx/oliphaunt-kotlin-release" \
  --project-cache-dir "$PWD/target/liboliphaunt-sdk-check/gradle-cache/oliphaunt-kotlin-release" \
  --configuration-cache
```

The Maven publication must contain the SDK artifact, the
`dev.oliphaunt:oliphaunt-android-gradle-plugin` artifact, and the
`dev.oliphaunt.android` plugin marker metadata. The plugin is the
consumer-facing asset resolver: apps apply `id("dev.oliphaunt.android")` and
select exact SQL extension names through its typed `oliphaunt { ... }` block
instead of copying `liboliphaunt.so`, PostgreSQL runtime resources, or
extension archives by hand.

If Maven Central requires a first manual publication to make those coordinates
visible, publish the exact release artifacts and then push
`oliphaunt-kotlin-v<version>` at the release commit before rerunning the publish
workflow as a completion run.

## Apple / SwiftPM

Product:

- `Oliphaunt`

Apple distribution is SwiftPM plus GitHub release assets. Do not set up
CocoaPods trunk credentials and do not publish `COliphaunt` or `Oliphaunt` pod
versions. CocoaPods trunk is scheduled to become read-only on December 2, 2026,
so it is not a durable release registry for this product.

Setup:

1. Keep a root `Package.swift` in the repository. SwiftPM consumers should be
   able to use:

   ```swift
   .package(url: "https://github.com/f0rr0/oliphaunt.git", exact: "<version>")
   ```

2. Ensure the Swift SDK version does not collide with existing semver tags in
   the repository. The release workflow creates two tags:
   - `oliphaunt-swift-v<version>` for the product release identity.
   - `<version>` for SwiftPM package resolution.
3. Publish the compatible `liboliphaunt-native-v<version>` GitHub release assets
   before or during the same release plan. The Swift SDK pins that native core
   version in `src/sdks/swift/LIBOLIPHAUNT_VERSION`.
4. Keep the SwiftPM-compatible Apple XCFramework zip, Apple runtime resources,
   and exact-extension artifacts in GitHub release assets. End developers should
   select exact extension names through package tooling; they should not copy
   XCFrameworks or resource directories by hand.

The SwiftPM release manifest is generated from the actual `liboliphaunt`
release asset checksum:

```bash
tools/release/render_swiftpm_release_package.py \
  --asset-dir target/liboliphaunt/release-assets \
  --output target/oliphaunt-swift/Package.release.swift
```

The release workflow passes that generated manifest to
`tools/release/publish_swiftpm_source_tag.py --manifest ...`. The publisher creates
a release-only commit parented by the source release commit with only
`Package.swift` replaced, then tags that commit with the semver tag SwiftPM
resolves. The source checkout still keeps `src/sdks/swift/Package.swift`
and the root source `Package.swift` for local SDK development and tests.

The React Native npm package includes iOS podspec integration files while the
current React Native New Architecture toolchain uses CocoaPods for generated iOS
integration. The package ships `COliphaunt` and `Oliphaunt` podspec shims under
`ios/podspecs/`; those shims resolve the released Swift SDK source tag through
CocoaPods without publishing to CocoaPods trunk and without vendoring Swift SDK
source into npm. The standalone Swift SDK remains SwiftPM-first and does not
publish separate trunk pods.

## GitHub Release Assets And Attestations

`liboliphaunt`, the `oliphaunt-broker` runtime assets, and
`oliphaunt-wasix` publish binary/runtime assets to GitHub Releases. No extra
registry secret is needed; the release job uses `GITHUB_TOKEN` with
`contents: write`.

Asset provenance requires:

- `id-token: write`
- `attestations: write`
- `contents: write`

The release workflow already declares those permissions. Verification uses:

```bash
tools/release/release.py verify-release --products-json '["liboliphaunt-native"]' --head-ref HEAD
tools/release/release.py verify-release --products-json '["oliphaunt-rust"]' --head-ref HEAD
tools/release/release.py verify-release --products-json '["oliphaunt-wasix-rust"]' --head-ref HEAD
```

## Setup Validation

Run these locally before attempting the first real release. Consumer shape is
strict because it validates tracked package surfaces, not public
registry state:

```bash
moon run dev-tools:doctor
tools/release/release.py check
tools/release/release.py plan --from-product-tags --include-current-tags --head-ref HEAD
tools/release/release.py check-registries --products-json '<released products>' --head-ref HEAD
tools/release/release.py publish-dry-run --products-json '<released products>' --head-ref HEAD
tools/release/release.py consumer-shape --require-ready --format markdown
```

For the first public release, select every product that introduces a public
dependency edge in one release plan. Treat the output of
`tools/release/release.py plan --from-product-tags --include-current-tags
--head-ref HEAD` as the source of truth; the core dependency lane is:

```json
[
  "liboliphaunt-native",
  "oliphaunt-rust",
  "oliphaunt-broker",
  "oliphaunt-node-direct",
  "oliphaunt-swift",
  "oliphaunt-kotlin",
  "oliphaunt-react-native",
  "oliphaunt-js",
  "liboliphaunt-wasix",
  "oliphaunt-wasix-rust"
]
```

That is deliberate. Swift, Kotlin, and TypeScript need the matching
`liboliphaunt-native-v*` assets; React Native needs the matching SwiftPM and Maven
SDKs; TypeScript broker mode needs the matching `oliphaunt-broker` runtime
assets; TypeScript native-direct mode needs the matching `oliphaunt-node-direct`
assets and optional npm packages; the WASIX Rust binding needs the matching
`liboliphaunt-wasix` crates and release assets. If the plan also selects exact
extension artifact products for the first release, keep those product IDs in the
same generated release PR rather than hand-editing the product set. Later
releases can be independent once those current-version
dependency tags, registry packages, and GitHub release assets already exist.
First-time package identities are not a dry-run prerequisite. Some registries
create the package identity during the first publish, while others require
maintainer setup before a package settings page or trusted publisher can be
configured. Treat `check_registry_publication.py --require-identities` as an
optional setup diagnostic, not the release gate. The release gate checks that
planned versions are not already published, runs package-native dry-runs where
the registry supports them, and verifies publication after the real publish.
Create the npm/JSR packages when their registries require it, verify the Maven
namespace/publication path, and manually bootstrap any first Cargo crates that
cannot be created by trusted publishing.
The publish-environment check also rejects legacy long-lived publish secrets
such as `CARGO_REGISTRY_TOKEN`, `NPM_TOKEN`, `NODE_AUTH_TOKEN`, `JSR_TOKEN`, and
CocoaPods trunk credentials. Configure trusted publishing, Maven signing
secrets, and GitHub release permissions instead of adding those tokens.

Run these from GitHub Actions after environments and secrets exist:

1. `Release` with `prepare-release-pr`
2. merge the generated release PR after CI is green
3. `Release` with `publish-dry-run`
4. `Release` with `publish`
5. `tools/release/release.py verify-release --products-json '<released products>' --head-ref HEAD`
6. `tools/release/release.py consumer-shape --require-ready --products-json '<released products>'`

Do not treat successful registry setup as full release readiness. The
consumer-shape report still has to be green: tracked package metadata,
install docs, SwiftPM/Gradle/Expo wiring, exact-extension selection, compatible
dependency pins, and install-script safety must match the consumer-shape
fixtures for the selected release products.
The `--require-ready` command enforces that targeted shape contract. It does
not run clean registry installs, and clean registry reinstalls are not a
standing release policy.
For independently released products, unchanged dependencies may keep their
current-version product tags at earlier release commits. The selected products
in the active release plan are the ones that must tag the current release commit;
the release workflow enforces that separately from the targeted consumer-shape
tag-existence check.

## References

- GitHub environments and environment secrets:
  <https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments>
- GitHub Actions OIDC permissions:
  <https://docs.github.com/en/actions/reference/security/oidc>
- GitHub artifact attestations:
  <https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations>
- crates.io trusted publishing announcement:
  <https://blog.rust-lang.org/2025/07/11/crates-io-development-update-2025-07/>
- crates.io trusted publishing:
  <https://doc.rust-lang.org/cargo/reference/registry-authentication.html#trusted-publishing>
- npm trusted publishers:
  <https://docs.npmjs.com/trusted-publishers/>
- JSR publishing packages:
  <https://jsr.io/docs/publishing-packages>
- JSR using packages:
  <https://jsr.io/docs/using-packages>
- Sonatype Central Portal namespace setup:
  <https://central.sonatype.org/register/namespace/>
- Sonatype Central Portal token setup:
  <https://central.sonatype.org/publish/generate-portal-token/>
- Vanniktech Maven Central publishing:
  <https://vanniktech.github.io/gradle-maven-publish-plugin/central/>
- SwiftPM binary target checksum tooling:
  <https://developer.apple.com/documentation/xcode/distributing-binary-frameworks-as-swift-packages>
- CocoaPods trunk read-only plan:
  <https://blog.cocoapods.org/CocoaPods-Specs-Repo/>
