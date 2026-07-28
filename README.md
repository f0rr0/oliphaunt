<p align="center">
  <img src="docs/assets/oliphaunt.png" alt="Oliphaunt" width="360">
</p>

<h1 align="center">Oliphaunt</h1>

<p align="center">
  <strong>Native-first embedded PostgreSQL 18 for desktop, mobile, and WASIX applications.</strong>
</p>

Oliphaunt is a family of peer SDKs and runtime products over the same embedded
PostgreSQL model. Applications own their database roots, choose an honest
runtime mode for their platform, and package only the exact PostgreSQL
extensions they select.

> **Release status:** this source tree is preparing Oliphaunt's first
> independently versioned public releases. Source versions intentionally remain
> `0.0.0` until the generated release PR advances them. Package names and
> install examples describe the release contract; they are not evidence that a
> registry package has already been published.

## Product model

Oliphaunt is a multi-product monorepo, not one repository-wide version:

- `liboliphaunt-native` owns the PostgreSQL 18 C ABI runtime and native target
  carriers.
- `liboliphaunt-wasix` owns portable WASIX runtime assets and host AOT
  carriers.
- Rust, Swift, Kotlin/Android, React Native, TypeScript, and WASIX Rust are
  separately versioned SDK products.
- Broker and Node-direct helpers are separately versioned runtime products.
- Every promoted SQL extension remains exactly selectable. PostgreSQL 18
  contrib members share one runtime-bound distribution product and its stable
  carriers; each external extension is a separately tagged, independently
  versioned product.

A product owns its SemVer, changelog, source identity, product tag, and GitHub
release. Platform packages, ABI payloads, and size-split crates are carriers of
that product; they use the product version and are not extra products.

## First-release target envelope

The published target manifests currently declare:

| Surface | Declared release targets |
| --- | --- |
| Desktop native | Linux x64 GNU, Linux arm64 GNU, macOS arm64, Windows x64 MSVC |
| Android | `arm64-v8a`, `x86_64` |
| Apple | iOS XCFramework carrier plus the declared macOS arm64 runtime carrier, delivered through SwiftPM and GitHub release assets |
| WASIX | portable runtime plus AOT carriers for Linux x64/arm64 GNU, macOS arm64, and Windows x64 MSVC |

The first release intentionally does **not** claim macOS x64, Windows ARM64,
Linux musl, Android 32-bit, or undeclared Apple architectures. A compiler,
language, or runtime working on a broader platform is not a support promise;
the explicit target manifest, publication catalog, and frozen release lock are
the boundary.

Exact-extension support is target-specific too. An extension is publishable
for a target only when its own target manifest and evidence declare that row.
The public [release reference](src/docs/content/reference/releases.mdx)
publishes the enforced OS/API/ABI floors and distinguishes built package
coverage from installed-app execution evidence, including the Android arm64
and physical-iOS boundaries.

## SDK entry points

The planned public entry points are:

| App surface | Package entry point | Distribution boundary |
| --- | --- | --- |
| Rust/Tauri desktop | `oliphaunt` | Cargo and target-specific native artifact crates |
| WASIX Rust | `oliphaunt-wasix` | Cargo portable/AOT artifact crates |
| Swift | `Oliphaunt` | SwiftPM source tag and checksum-pinned release assets |
| Android | `dev.oliphaunt:oliphaunt-android` and `dev.oliphaunt.android` | Maven Central AAR, Gradle plugin/marker, and declared ABI carriers |
| React Native | `@oliphaunt/react-native` | npm package delegating runtime work to Swift and Kotlin |
| Node.js, Bun, and Deno | `@oliphaunt/ts` | npm for native runtime support; JSR for protocol/query helpers only |
| Native bindings | `liboliphaunt` C ABI | declared native runtime carriers |

Kotlin host-native and JVM compilations are development/parity evidence, not
public Kotlin Multiplatform or JVM artifacts. The first Swift release starts at
`0.6.0` because legacy unscoped SwiftPM tags already occupy `0.1.0` through
`0.5.1`; other new products start at `0.1.0`.

## Exact extensions

Extension selection uses exact PostgreSQL SQL names. There are no selection
packs, aliases, or implicit groups; the contrib distribution bundle is only a
carrier envelope. Selecting `earthdistance` may include its declared `cube`
dependency; selecting `vector` does not pull unrelated extensions into the
application.

The `oliphaunt-extension-contrib-pg18` product is runtime-bound and moves with
the linked runtime version group. Its target carriers contain an exact,
checksummed member inventory, but consumers still stage only the requested SQL
members. External extension products own independent packaging SemVer. Their
immutable upstream version/commit and compatible Oliphaunt runtime versions are
recorded separately, so consumers must not infer compatibility from matching
version numbers.

## Development

Install the pinned toolchain once, then use Moon as the repository task
surface:

```sh
tools/dev/bootstrap-tools.sh
moon run dev-tools:doctor
moon run policy-tools:fmt-check
moon run :check
moon run :test
```

For a release-sensitive change, also run the metadata and package contract
gate:

```sh
moon run repo:release-check
```

The protected GitHub `Release` workflow owns candidate dry-runs and all public
mutation. Local development commands do not publish packages, create tags, or
promote releases.

## Documentation

- [Public SDK documentation](src/docs/content/sdk/index.mdx)
- [Capabilities](src/docs/content/reference/capabilities.mdx)
- [Exact extension model](src/docs/content/reference/extensions.mdx)
- [Source architecture](docs/architecture/final-product-source-architecture.md)
- [Maintainer documentation index](docs/maintainers/README.md)
- [Release process](docs/maintainers/release.md)
- [Contributing](CONTRIBUTING.md)

Oliphaunt is licensed under the terms recorded in [LICENSE](LICENSE).
