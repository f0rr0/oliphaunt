# Repository structure

Products own their source, native manifests, tests and packaging commands. Moon
orders cross-project tasks; Cargo, Bun, Gradle and SwiftPM retain their native
dependency and build semantics.

## Current tree

```text
/
  Cargo.toml, Cargo.lock
  package.json, bun.lock, bunfig.toml
  Package.swift
  .moon/, .github/
  runtimes/
    liboliphaunt-native/
    liboliphaunt-wasix/
    liboliphaunt-wasix-postmaster/
      executor/
      wasmer/
    wasix-browser-host/
  sdks/
    ts/{sdk,node-addon}/
    ts-wasix/{sdk,node-addon}/
    rust/{sdk,liboliphaunt-native}/
    rust-wasix/
    ts-query/
    rust-query/
    swift/
    kotlin/
    react-native/
  broker/
  extensions/
  third-party/{postgres,icu,openssl,tools}/
  docs/{src,content,public,architecture,maintainers,internal}/
  examples/
  benchmarks/
  database-resources/{contracts,icu,seeds,tools}/
  postgres-tools/{native,wasix}/
  pgwire-server/
  test-fixtures/
  tools/{dev,graph,packaging,policy,release,test}/
```

Release metadata readers live in `tools/release`; reusable archive and package
utilities live in `tools/packaging`. Runtime, Swift and extension packaging
contracts live with their producers. ICU data and four selectable seed profiles belong to
`database-resources`; PostgreSQL utilities and the pgwire server have independent
product owners. Shared source acquisition lives in `third-party/tools`, upstream
pins and notices beside each dependency, and installer pins in `tools/dev`.
Product-specific pins stay with their runtime. New package identities remain
unreleased until their first successful public release.
The [implementation plan](../architecture/repository-simplification-plan.md)
tracks those remaining boundaries.

## Product boundaries

- `runtimes/liboliphaunt-native` owns the native C ABI, embedded PostgreSQL
  implementation, patches and platform runtime production.
- `runtimes/liboliphaunt-wasix` owns the single-backend WASIX runtime and its
  portable/AOT carriers. `liboliphaunt-wasix-postmaster` owns the separate
  concurrent postmaster product, executor and patched Wasmer host.
- `runtimes/wasix-browser-host` is a Rust/WASM execution-host build project
  consumed by the WASIX TypeScript SDK; it is not another SDK.
- `sdks/rust/liboliphaunt-native` is the `liboliphaunt-native-bindings` Cargo
  package. It owns Rust ABI loading, native sessions, runtime discovery and
  database-root handling. The public Rust SDK and broker consume this package.
- `sdks/rust/sdk` is the `oliphaunt` public SDK. `broker` owns the process
  helper, IPC service/client library and broker carriers. The broker does not
  depend on the public SDK.
- `sdks/ts/sdk` and `sdks/ts-wasix/sdk` are the two TypeScript SDKs.
  Their sibling `node-addon` projects own native Node-API artifacts. Browser
  consumers use the WASIX SDK rather than a separate browser package.
- `sdks/rust-wasix` is the ordinary Cargo package for the WASIX SDK; its
  former outer wrapper has been merged into the package.
- `sdks/ts-query` and `sdks/rust-query` are shared query packages with
  explicit package dependencies. They are not copied private source trees.
- Swift, Kotlin and React Native keep their package-native APIs and mobile
  integration. React Native's platform adapters consume the Swift/Kotlin SDKs.
- `extensions` owns contrib/external extension definitions, builds, carriers
  and behavior tests. Contrib carriers follow their runtime release owners;
  external extensions retain their own release identities.
- `docs` contains the public site and maintainer documentation. Public
  guides describe latest behavior and use completed public release versions.
  There are no documentation-version archives or SDK API-generation builds.

Grouping directories such as `sdks/ts` and `sdks/rust` have no package
manifest. Root Cargo/Bun lockfiles belong to their workspaces. The root
`Package.swift` remains the public Swift tag entrypoint; the development
package lives in `sdks/swift`.

## Working in a product

Use the product README and native manifest for commands, and its `moon.yml`
for dependency ordering and affected-task selection. Tests live beside the
behavior they exercise. Cross-product fixture data remains shared only where
multiple real consumers need it. Generated output, fetched upstream trees,
registry staging and build caches belong in ignored output directories.

See [tooling](tooling.md) for the task contract,
[development](development.md) for local commands and
[release](release.md) for publication. Historical investigation records remain
under `architecture` and `internal`; they describe their recorded source
state rather than acting as current path aliases.
