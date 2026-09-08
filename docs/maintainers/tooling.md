# Tooling

Moon owns the project graph, affected task selection, task ordering, and output
caching. Cargo, pnpm, Gradle, and SwiftPM own their package dependencies.
Product versions and compatibility requirements live in product manifests.
There is no second repository build scheduler.

## Local commands and ownership

Put build, lint, test, and package commands beside their product and declare them
in that product's `moon.yml`. CI invokes those same commands. Shared runtime,
ABI, query-core, and fixture dependencies belong in the graph when the product
actually consumes them; unrelated platforms must not hold up one another's tests.

Use Shell for external commands and TypeScript for data processing. Committed
JavaScript and Python implementations are not maintained. Generated JavaScript
inside npm packages remains part of those packages' supported interface.
Native Rust/C helpers remain where they execute WASM, serialize AOT artifacts,
or provide operating-system operations unavailable in the scripting runtime.

Useful commands from the repository root:

```sh
moon query tasks --project <product>
moon run <product>:compile <product>:unit <product>:package
moon run <product>:smoke --cache off
bash tools/policy/check-workflows.sh
bash tools/dev/install-hooks.sh
```

Each project exposes the task names relevant to its language and runtime;
inspect its tasks before choosing a command. Do not replace package or installed
consumer tests with source-text assertions.

The ordinary package manager commands also remain available, such as
`cargo test -p <package>`, `cargo clippy -p <package> --all-targets`, and each
SDK's documented pnpm, Gradle, or SwiftPM commands. For an unreleased crate,
`cargo semver-checks` needs an explicit `--baseline-rev <commit>`; a registry
baseline exists only after publication.

## Toolchain and cache inputs

Toolchain pins and platform archive checksums live under `src/sources/toolchains`.
GitHub setup actions use the local Shell installers. Use the pinned Moon and
Bun versions when reproducing CI; arbitrary globally installed versions can
behave differently.

A cached task must declare every input that affects its output. Cache completed
build outputs as well as compiler objects where source, toolchain, flags, and ABI
identity establish safe reuse. A version label alone does not establish that
identity. Do not cache a live device, process-recovery, or benchmark measurement
as if it proved the current runner's state.

Postmaster binds prepared upstream checkouts to pinned commits, patches, and
executor source. Its build receipts additionally bind compiler and build
recipes. A build-script change must not force reapplying unchanged upstream
patches. Standalone tests are outside the executor source identity.

## Release and qualification

Release Please prepares independently selected product versions and changelogs.
The protected Release workflow prepares or publishes a candidate. Its internal
steps freeze and qualify package bytes, perform necessary first-publication
setup, submit missing packages, and verify publication. Retries reconcile exact
bytes; they must not silently replace an existing version with different bytes.
See [the release guide](release.md) for the maintained commands and recovery flow.

Run affected product checks before expensive platform builds. Checks of archive
safety, ABI compatibility, package installation, transaction recovery, and
immutable publication protect real boundaries. Source-spelling, repository
layout, fixture-content duplication, and generated symbol-list gates do not
replace those checks.

Optional performance measurements use the native workloads described in
[performance evidence](performance-evidence.md). They retain raw results and
input identities and are separate from release qualification.
