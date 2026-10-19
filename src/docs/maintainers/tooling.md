# Tooling

Moon owns the project graph, affected task selection, task ordering, and output
caching. Cargo, Bun, Gradle, and SwiftPM own their package dependencies.
Product versions and compatibility requirements live in product manifests.
There is no second repository build scheduler.

## Local commands and ownership

Put build, lint, test, and package commands in the product's native manifest or
local Shell script. Its `moon.yml` orders and caches those commands; it should
not be the only place an ordinary compilation recipe exists. Shared runtime,
ABI, shared query, and fixture dependencies belong in the graph when the product
actually consumes them; unrelated platforms must not hold up one another's tests.

Use Shell for external commands and TypeScript for data processing. Committed
JavaScript and Python implementations are not maintained. Generated JavaScript
inside npm packages remains part of those packages' supported interface.
Native Rust/C helpers remain where they execute WASM, serialize AOT artifacts,
or provide operating-system operations unavailable in the scripting runtime.

Task names describe the result, not a compulsory sequence:

| Task | Contract | Prerequisites |
| --- | --- | --- |
| `format-check` | Read-only formatting diagnostics | Source and formatter |
| `lint` | Source diagnostics | Source and language tools; compiler analysis is allowed |
| `typecheck` | Compiler/type diagnostics without a distributable artifact | Required dependency interfaces |
| `build` | Compile or generate usable product outputs | Builds of dependencies actually consumed |
| `test` | Source behavior and unit tests | The ecosystem's test runner may compile its test targets |
| `check` | An explicitly declared aggregate of source checks and isolated tests | Its listed source tasks; no platform release promise |
| `package` | Produce and inspect the distributable | Required build outputs; no implicit full source-test gate |
| `test-integration` | Behavior against a real runtime or dependency | The runtime and inputs actually exercised |
| `test-consumer` | Install or compile the produced package outside the source workspace | The actual package and dependency closure |
| `test-browser` / platform tests | Browser or device behavior | The named platform and required artifacts |
| `test-packaging` | Isolated packaging behavior | Artifact fixtures; an installed consumer remains a separate proof |
| `coverage` / benchmarks | Optional measurement | The suite or runtime being measured |

Use a suffix when it identifies a real boundary, such as `smoke-android`,
`smoke-ios`, `lint-codegen`, or `rust-lint` in a mixed-language package.
Do not add empty tasks to make every ecosystem expose every name. In particular,
`cargo test`, `swift test`, and Gradle tests already compile what they need;
they should not depend on a second, standalone `build` merely to enforce a tier.
Native lifecycle names remain native: Gradle's `build` normally combines
assembly and checking; use its compilation/assembly tasks for the Moon `build`
phase. Do not override Gradle's lifecycle just to match the table.

Optional prek hooks run cheap file checks and validate commit messages. Formatting
belongs to the owning project's `format` and `format-check` tasks; editing an
unrelated TOML file does not run formatting across the Rust workspace.

The old product `qualify` aliases were removed: some meant source checks,
others included a native runtime or packaging, and none certified publication.
The hosted `Qualified` artifact is a separate release protocol, described below.

Useful commands from the repository root:

```sh
moon query tasks --project <product>
moon query affected --upstream none --downstream deep
moon run <product>:format-check <product>:lint <product>:test
moon run <product>:package
moon run <product>:test-consumer --cache off
bash tools/ci/check-workflows.sh
bash tools/dev/install-hooks.sh
```

Choose explicit owner targets from the affected graph and the product's task
list. CI selects source checks through task tags; local commands above name the
checks to run. Use a host with the required capabilities. Package and
installed-consumer checks must exercise their artifact; source-text assertions
cannot substitute for them.

The ordinary package manager commands also remain available, such as
`cargo test -p <package>`, `cargo clippy -p <package> --all-targets`, and each
SDK's documented Bun, Gradle, or SwiftPM commands. For an unreleased crate,
`cargo semver-checks` needs an explicit `--baseline-rev <commit>`; a registry
baseline exists only after publication.

For TypeScript, use `moon run oliphaunt-js:build` (or the corresponding WASIX/RN product) to build its declared query dependency first. A local `bun run build` runs the package's own recipe. Bun workspaces declare package dependencies; Moon orders cross-project tasks. An ordinary TypeScript edit does not require building PostgreSQL.

Build dependencies and release propagation are different. A published dependency
can retain its existing compatible version. A private library copied or compiled
into several products must make every embedding product release-affected. A
shared test fixture must rerun its consumer tests without forcing a release.
The current release planner does not yet implement every one of these cases;
moving a directory or adding a Moon edge alone does not fix version propagation.

## Toolchain and cache inputs

Toolchain pins and platform archive checksums live under `tools/dev`.
GitHub setup actions use the local Shell installers. Use the pinned Moon and
Bun versions when reproducing CI; arbitrary globally installed versions can
behave differently.

A cached task must declare every input that affects its output. Cache completed
build outputs as well as compiler objects where source, toolchain, flags, and ABI
identity establish safe reuse. A version label alone does not establish that
identity. Do not cache a live device, process-recovery, or benchmark measurement
as if it proved the current runner's state.

Root Cargo package owners carry the `cargo-package` tag. Their internal
`cargo-sources` task runs no command: it hashes local source and the same node
in declared dependencies. Compiler tasks depend on this hash, so a transitive
library edit invalidates consumers without running a duplicate Cargo build.
Formatting stays local. Extend the owner's `cargo-sources` file group when its
crate compiles source outside `src`; do not repeat dependency directory lists
in each consumer. Cross-language consumers also depend on this source hash when
their required binary producer cannot be cached safely. Affected selection must
traverse task dependents deeply to preserve these transitive relationships.

Postmaster binds prepared upstream checkouts to pinned commits, patches, and
executor source. Its build receipts additionally bind compiler and build
recipes. A build-script change must not force reapplying unchanged upstream
patches. Standalone tests are outside the executor source identity.

## Release and qualification

Ordinary execution delegates dependency ordering and parallelism to Moon.
Downloaded CI artifacts require a narrower path: Moon 2.5.4 with `--upstream none`
does not preserve edges even between explicitly selected tasks. A disposable
workspace probe on 2026-09-11 ran a consumer before its delayed producer wrote
its artifact; the consumer also ran when that producer was configured to fail.
Without the flag, Moon ordered them correctly, ran an independent task in
parallel, and withheld the consumer after producer failure. Consequently, CI
handoffs first run local prerequisites normally, then run selected roots in
dependency order with upstream traversal disabled. This fallback prevents
rebuilding downloaded producers; it is only used for transferred artifacts.

Release Please prepares independently selected product versions and changelogs.
The protected Release workflow prepares or publishes a candidate. Its internal
steps freeze and qualify package bytes, perform necessary first-publication
setup, submit missing packages, and verify publication. Retries reconcile exact
bytes; they must not silently replace an existing version with different bytes.
See [the release guide](release.md) for the maintained commands and recovery flow.

Currently, only an exhaustive manual CI dispatch can produce `Qualified`; an
affected PR or main push cannot. The record is bound to that exact SHA and
same-run artifacts. Publication consumes those artifacts without rebuilding
them. Product-scoped qualification requires changing the planner, evidence
record, verifier, and workflow together; deleting unrelated workflow jobs alone
would leave an invalid release contract.

Run affected product checks before expensive platform builds. Checks of archive
safety, ABI compatibility, package installation, transaction recovery, and
immutable publication protect real boundaries. Source-spelling, repository
layout, fixture-content duplication, and generated symbol-list gates do not
replace those checks.

Optional performance measurements use the native workloads described in
[performance evidence](performance-evidence.md). They retain raw results and
input identities and are separate from release qualification.
