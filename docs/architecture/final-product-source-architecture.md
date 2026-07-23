# Oliphaunt Source Architecture

This document describes the active repository model. It is not a migration log.

## Authority Boundaries

Oliphaunt uses one source graph and one release identity system:

- Moon owns projects, task execution, affectedness, dependency scopes, and task
  caching.
- Release Please manifest mode owns product versions, changelogs, and the
  generated release PR.
- The protected release workflow owns exact-SHA product tags and draft GitHub
  releases; it stages them only after candidate qualification and current-main
  validation.
- Product-local `release.toml` files own package metadata that release-please
  does not model: owner, kind, publish targets, registry coordinates, release
  artifacts, and compatibility-version files.
- Product-local `targets/*.toml` files own platform artifact metadata.
- Bun entrypoints under `tools/release/*.mjs` own release checks, dry-runs,
  publication routing, checksums, attestations, registry checks, and artifact
  verification.

There is no separate release graph, release-input graph, CI jobs graph, or
consumer lockfile. If a relationship affects source, task execution, or release
coupling, it must be visible in Moon or release-please/product-local metadata.

## Source Shape

Source products and shared domains live under `src/`:

```text
src/postgres/versions/18/        PostgreSQL 18 source pin and validation
src/sources/                     shared source and toolchain pins
src/extensions/                  exact SQL extension catalog, recipes, evidence
src/runtimes/liboliphaunt/native native C ABI runtime
src/runtimes/liboliphaunt/wasix  WASIX runtime and AOT assets
src/runtimes/broker              Rust broker helper runtime
src/runtimes/node-direct         Node direct native runtime
src/sdks/rust                    Rust SDK
src/sdks/swift                   Swift SDK
src/sdks/kotlin                  Kotlin/Android SDK
src/sdks/react-native            React Native SDK
src/sdks/js                      TypeScript SDK
src/bindings/wasix-rust          Rust binding for the WASIX runtime
src/shared/contracts             cross-language protocol and API contracts
src/shared/extension-runtime-contract extension/runtime ABI contract
src/shared/fixtures              shared semantic test fixtures
src/docs                         public docs site
```

Generated local state lives outside source roots or in ignored product build
directories. Root `target/`, `.moon/cache/`, `node_modules/`, Gradle build
state, Swift `.build/`, Xcode DerivedData, Expo state, and docs build output are
generated state and must not be tracked.

## Moon Graph

Moon is the only task and affectedness graph. Project dependencies represent
real source relationships and use dependency scopes:

- `production` and `peer` are release-affecting compatibility edges.
- `build` is a test, generation, fixture, or package-shape edge. It affects CI
  and local affected tasks, but it does not force downstream product releases.

Examples:

- `liboliphaunt-native -> oliphaunt-rust`, `oliphaunt-swift`,
  `oliphaunt-kotlin`, `oliphaunt-node-direct`, and `oliphaunt-broker` are
  production edges.
- `oliphaunt-swift -> oliphaunt-react-native` and
  `oliphaunt-kotlin -> oliphaunt-react-native` are production edges.
- `oliphaunt-rust -> oliphaunt-js` is a production edge because the TypeScript
  SDK uses the Rust broker helper.
- `extensions -> SDKs` is a build edge. SDK tests and generated metadata react
  to extension catalog changes, but exact extension source releases do not
  automatically release SDK packages.
- `shared-fixtures -> SDKs` is a build edge. Fixtures affect tests and coverage,
  not package releases.

Use Moon queries for graph inspection:

```sh
moon query projects
moon query tasks
moon query affected --upstream none --downstream deep
moon project-graph
moon action-graph oliphaunt-rust:test
```

Do not add a second graph format to answer questions Moon already answers.

## CI Model

CI has stable GitHub job names because branch protection needs stable checks.
Moon decides which tasks are affected and how tasks depend on each other.

The flow is:

1. The affected planner calls Moon queries and maps `ci-*` task tags to stable
   GitHub job names and exact Moon task targets.
2. Product jobs call `.github/scripts/run-planned-moon-job.sh <job>`, which
   reads the planned target map and delegates to `.github/scripts/run-moon-targets.sh`.
   That helper intentionally uses `moon run` for planned artifact targets because
   the planner may select artifact producer jobs that are required by a changed
   product but are not themselves directly affected.
3. GitHub matrix is used only for real runner or target fan-out: OS, CPU, ABI,
   simulator, device, native runtime target, broker target, Node direct target,
   and WASIX AOT target.
4. The affected planner emits visible `Checks / <target>` and
   `Tests / <target>` matrices plus one compact `Policy` batch from
   Moon-selected targets. `Checks / <target>` is for normal
   static/lint/typecheck-style work. `Policy` is for repository assertions that
   parse code, workflows, release metadata, or generated graphs and enforce
   invariants. Check and test matrix jobs delegate one exact target to
   `moon run --upstream deep`, so task inheritance and target dependencies stay
   in Moon without pulling unrelated affected tests into the checks phase. The
   policy batch runs its exact selected targets with `--upstream none`, because
   package prerequisites already have their own visible jobs. Tasks that truly
   need Android tooling declare the `ci-android-sdk` capability tag; the planner
   projects it into runner setup instead of provisioning Android for every
   check, policy, and test shard. When a selected build lane already inherits a
   `check` or `test` target, the phase selector skips that covered target.
5. The aggregate `Checks` and `Tests` jobs are gates over those visible target
   jobs. `Checks` waits for both `Checks / <target>` jobs and the selected
   `Policy` batch, but policy assertions are named separately because they are
   not normal package checks.
6. Artifact-producing jobs call
   `.github/scripts/run-planned-moon-job.sh <job>`.
7. The `builds` aggregate answers the release-deliverable question:
   every selected runtime, helper runtime, SDK package, extension artifact,
   extension package, and mobile app builder must finish successfully.
   React Native package changes select both Android and iOS mobile app builders,
   because the RN release surface is the JS package plus native Swift/Kotlin
   integration built from staged runtime and extension artifacts.
8. The `required` aggregate is intentionally thin. It gates `affected`,
   `checks`, `tests`, `builds`, and `e2e`, so the job names remain true to their
   phase and mobile installed-app E2E stays an artifact consumer rather than a
   build producer.
9. Builder jobs invoke only their planned builder Moon targets. GitHub `needs:`
   expresses artifact ordering for uploaded artifacts. Builder jobs that can
   run local task prerequisites keep Moon upstream inheritance enabled; jobs
   that consume downloaded artifacts pass `--upstream none` through
   `.github/scripts/run-planned-moon-job.sh` so producer artifacts are not
   rebuilt in the consumer job.
   SDK `package-artifacts` tasks depend on the product `package` task and
   consume its package-shape outputs instead of rerunning package assertions
   inside the artifact staging script.
10. Expensive runtime, mobile, benchmark, publish, registry, and provenance jobs
   are selected by affectedness, but they execute live when current runner state
   matters.

Mobile build jobs do not own ABI lists. They request target surfaces such as
`react-native-android` and `react-native-ios`; the selected native runtime
target IDs come from `src/runtimes/liboliphaunt/native/targets/*.toml`. Mobile
E2E is a separate installed-app phase that consumes the app artifacts from the
same CI run; it must not rebuild runtimes, SDKs, or extension packages.

Moon task options must be semantic:

- cache deterministic checks, tests, package-shape checks, generated freshness,
  docs builds, and measured unit coverage with declared inputs and outputs.
- use `runInCI: skip` for expensive dependency tasks that should remain valid
  in CI action graphs but should not run as broad affected work.
- use `runInCI: false` only for local/manual tasks that CI must never invoke.
- keep runtime/device/provenance tasks uncached in CI with `MOON_CACHE=off`.

## Release Model

Release decisions come from release-please components and Moon dependency
scopes:

1. Release Please identifies product components, versions, and changelogs and
   prepares the generated release PR.
2. Product-local `release.toml` adds publish and artifact metadata.
3. `tools/dev/bun.sh tools/release/release_plan.mjs` maps changed paths to
   owning Moon projects.
4. The release closure follows only Moon `production` and `peer` dependencies.
5. CI affectedness still follows all Moon dependencies, including `build`.

The protected publish workflow derives `<component>-v<version>` from that
reviewed release state and creates the product tags and draft GitHub releases
at the exact qualified commit. Release Please never targets the moving `main`
ref to create them.

This keeps release behavior explicit without duplicating source globs. A
PostgreSQL 18 source change releases native and WASIX runtimes plus downstream
products that have production/peer compatibility edges. A shared fixture change
runs affected tests but releases no package. An exact extension source change
releases that exact extension artifact product, not every SDK.

Release planning adapts Moon project sources and dependency scopes for
product-tag diffs; it must not introduce hand-authored source glob or dependency
metadata. CI execution must run the exact task targets emitted by the affected
planner instead of recomputing affectedness inside each product job.

Release publishing consumes artifacts only from the current-main, same-SHA `CI`
run whose `Builds`, `Required`, and `Qualified` gates succeeded. It downloads
runtime, SDK, helper, extension, and mobile build artifacts only after that
qualification record proves the named check, test, build, policy, and selected
E2E phases completed successfully.

## Extensions

Extensions remain exact SQL-selectable artifacts. Release-product ownership is
separate from SQL selection: PostgreSQL 18 contrib members share one
runtime-bound distribution product, while each external extension remains an
independently versioned product.

- Public selection is by SQL extension name, for example `vector` or `postgis`.
- PostgreSQL 18 contrib release ownership lives at `src/extensions/contrib/` in
  one `oliphaunt-extension-contrib-pg18` product with one `VERSION`, changelog,
  and `release.toml`. The canonical member inventory stays in
  `src/extensions/contrib/postgres18.toml`; member folders retain exact target,
  source, and evidence metadata but do not own SemVer or registry identities.
- External extensions own folders under `src/extensions/external/<name>/` with
  source pin, recipe, target metadata, tests, changelog, version, and
  `release.toml`.
- Complex external extensions keep dependency source pins under their own
  extension folder, for example PostGIS dependency pins under
  `src/extensions/external/postgis/dependencies/`.
- `src/shared/extension-runtime-contract/` defines the runtime contract shared
  by native and WASIX extension artifacts.
- `src/extensions/artifacts/native/` and `src/extensions/artifacts/wasix/`
  validate publishable exact-extension artifact shape.
- Contrib publication groups those exact member artifacts into one deterministic
  carrier per family/target. Every carrier records each member's nested path,
  byte count, and checksum; consumers select and verify only the requested SQL
  members. The bundle is a registry/distribution envelope, not an instruction
  to install every contrib extension in an application.
- Native runtime targets may opt out of exact-extension artifact publication
  with product-local target metadata when no real extension producer exists for
  that target. They must not appear in exact-extension matrices until the
  producer exists.

SDK packages must not ship all extensions. App developers install or configure
only the SQL extension artifacts they use; generated registries and package
checks must prove unselected extension files do not enter app artifacts.

## Tool Entrypoints

Use Moon directly for repository tasks:

```sh
moon run :check
moon run :test
moon run :coverage
moon run :package
moon run :smoke --cache off
moon query affected --upstream none --downstream deep
```

`moon run :package` is the local package-shape lane. It must not build
platform runtimes, exact-extension matrices, mobile apps, or publishable SDK
artifact envelopes. Publishable artifacts are produced by explicit
`package-artifacts`, runtime, extension, and mobile builder tasks selected by
the `CI` workflow.

Use pnpm only for JavaScript dependency installation and package-manager
commands. Use Cargo, SwiftPM/Xcode, Gradle, npm/JSR, and Expo through
product-local Moon tasks or product-owned scripts. Do not add root alias layers
over Moon.

## Mobile E2E Decision

Decision (2026-06-08): installed-app mobile E2E uses the pinned open-source
Maestro CLI on GitHub-hosted emulator/simulator jobs. This is not an open
research loop. Do not keep re-checking Maestro, Detox, Appium, EAS-only flows,
Firebase Test Lab, BrowserStack, Sauce, AWS Device Farm, or paid hosted-device
services during routine implementation.

Reopen the decision only with a written implementation proposal that names a
concrete installed-app E2E requirement that the pinned open-source Maestro CLI
cannot satisfy. When mobile E2E breaks, debug the chosen implementation first:
app artifact shape, simulator/emulator setup, Maestro flow files, logs, and CI
runner assumptions. The default proof path must stay free and reproducible from
a public checkout; paid hosted-device services are not part of the default
model.

## Removed Surfaces

These surfaces are retired and must not reappear:

- `release-plz.toml` and release-plz release PR/changelog/tag ownership.
- `tools/release/release-graph.toml`.
- `tools/release/release-inputs.toml`.
- `tools/graph/jobs.toml`.
- custom affected task runners that bypass Moon.
- broad registry reinstall gates as routine CI policy.
- extension packs, aliases, or grouped selectors.
- root product aliases such as `crates/`, `sdks/`, root `assets/`, and
  root-level runtime build trees.
