# Final Source Architecture Implementation Checklist

This is the active implementation checklist for making the repository match
`docs/architecture/final-product-source-architecture.md` exhaustively. Keep it
evidence-based: an item is only complete when the listed repo source, verifier,
or CI/build output proves the contract.

## Status Legend

- `[x]` implemented and locally verified in this branch.
- `[~]` implemented or partially implemented, but needs broader evidence.
- `[ ]` missing, contradictory, or not yet proven.

## Source Shape

- [x] Product source roots live under `src/`:
  - `src/postgres/versions/18/`
  - `src/sources/`
  - `src/extensions/`
  - `src/runtimes/liboliphaunt/native/`
  - `src/runtimes/liboliphaunt/wasix/`
  - `src/runtimes/broker/`
  - `src/runtimes/node-direct/`
  - `src/sdks/rust/`
  - `src/sdks/swift/`
  - `src/sdks/kotlin/`
  - `src/sdks/react-native/`
  - `src/sdks/js/`
  - `src/bindings/wasix-rust/`
  - `src/shared/contracts/`
  - `src/shared/extension-runtime-contract/`
  - `src/shared/fixtures/`
  - `src/docs/`
- [x] Generated local state is ignored and untracked. Evidence:
  `bash tools/policy/check-repo-structure.sh` passes, and tracked-file scans
  find no root `assets/`, root `crates/`, root `sdks/`, root runtime build
  trees, or generated local state under product source roots.
- [x] Retired root aliases and old product roots are rejected. Evidence:
  `bash tools/policy/check-repo-structure.sh` passes, `find . -maxdepth 2`
  finds no root `assets`, `crates`, or `sdks` directories, and `git ls-files`
  finds no tracked files under those retired roots.

## Moon Graph

- [x] Moon is the only task and affectedness graph. Evidence:
  `tools/graph/graph.py check` passes and reports Moon projects/release
  products.
- [x] Stable CI job names are derived from Moon task `ci-*` tags. Evidence:
  `tools/graph/ci_plan.py` and `tools/policy/check-moon-product-graph.mjs`.
- [x] Runtime target fan-out is metadata-driven, not hardcoded in mobile jobs.
  Evidence: focused mobile planner output narrows native runtime and native
  extension matrices by surface, and `tools/policy/check-release-policy.py`
  asserts Android mobile builds request only `android-arm64-v8a` and
  `android-x86_64` extension artifacts while iOS mobile builds request only
  `ios-xcframework`.
- [x] Moon dependency scopes encode release-affecting versus build-only edges.
  Evidence: `tools/release/release.py plan --changed-file ... --format json`
  probes prove extension catalog changes run affected CI without releases,
  exact extension target changes release only that extension product,
  native runtime patches release native plus production downstream products, and
  WASIX patches release only WASIX runtime plus the WASIX Rust binding.
- [x] React Native depends on Swift/Kotlin at the product graph level. Mobile
  installed-app builder jobs consume target-scoped exact-extension package
  artifacts through CI artifact handoff, not a Moon product dependency.
  Evidence: focused Android/iOS planner output selects
  `mobile-extension-packages` plus only the Android or iOS native extension
  targets, and `oliphaunt-react-native` no longer has `extension-packages` in
  Moon project dependencies.

## CI Builder Model

- [x] Builds workflow owns release-shaped runtime artifacts:
  - `liboliphaunt-native` matrix
  - `liboliphaunt-native-release-assets`
  - `liboliphaunt-wasix-runtime`
  - `liboliphaunt-wasix-aot`
  - `liboliphaunt-wasix-release-assets`
  Evidence: target jobs emit per-platform release assets, then
  `liboliphaunt-native-release-assets` runs the Moon-modeled
  `liboliphaunt-native:release-assets` aggregate task against downloaded target
  artifacts instead of inline workflow shell.
- [x] Builds workflow owns release-shaped helper artifacts:
  - `broker-runtime`
  - `node-direct`
  Evidence: the CI planner maps these jobs to
  `oliphaunt-broker:release-assets` and
  `oliphaunt-node-direct:release-assets`, not package-shape or
  release-check tasks.
- [x] Builds workflow owns SDK package artifacts:
  - Rust SDK
  - Swift SDK
  - Kotlin SDK
  - React Native SDK
  - TypeScript SDK
  - WASIX Rust binding
- [x] Builds workflow owns exact-extension artifacts:
  - `extension-artifacts-native` matrix over published native targets. Each
    target row carries the selected exact-extension product set in
    `extensions_csv`, so a full builder plan emits 7 native rows instead of
    rebuilding PostgreSQL once per product-target pair. Linux, macOS, Android,
    iOS, and Windows rows currently carry all 39 exact-extension products.
  - `extension-artifacts-wasix` matrix over published WASIX targets. A full
    builder plan emits 1 `wasix-portable` row covering 39 exact-extension
    products.
  - `extension-packages` for full native+WASIX release packages
  - `mobile-extension-packages` for Android/iOS installed-app builds that need
    only the selected mobile native extension targets
    Evidence: mobile package assembly now fails closed unless
    `OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS` and
    `OLIPHAUNT_EXTENSION_PACKAGE_NATIVE_TARGETS` are explicit; only the
    release-wide `extension-packages` path may stage all exact-extension
    products.
- [x] Builds workflow has a builder-only aggregate. Evidence:
  `tools/graph/ci_plan.py` emits `builder_jobs`, and the `artifact-builders` GitHub job
  fails if any selected runtime, helper runtime, SDK package, exact-extension
  artifact/package, or mobile app builder fails. Local planner probe confirms a
  full run selects runtime, WASIX, helper, SDK, extension, and mobile app
  builders, with no docs, coverage, regression, release-readiness, or mobile
  E2E jobs selected. An `extension-artifacts-native:build-target`-only plan selects
  only the native extension artifact builder and does not select
  `liboliphaunt-native`. WASIX AOT target fan-out is emitted by the affected
  planner as matrix data, not by a separate CI planner job.
- [x] Builds workflow disables Moon output cache for every artifact-producing
  builder invocation. Evidence: `tools/policy/check-release-policy.py` rejects
  any selected `ci-*` builder job whose `run-planned-moon-job.sh` line omits
  `MOON_CACHE=off`; compiler/package-manager caches remain available below
  Moon for ccache, Cargo, Gradle, pnpm, and Docker layers.
- [x] Builds workflow disables upstream Moon expansion for every
  artifact-producing builder invocation. Evidence:
  `tools/policy/check-release-policy.py` rejects any selected `ci-*` builder
  job whose `run-planned-moon-job.sh` line omits
  `OLIPHAUNT_MOON_UPSTREAM=none`, so `Builds` jobs cannot silently pull in
  `check`, `test`, docs, coverage, regression, or release-readiness work while
  producing runtime, SDK, extension, or mobile app artifacts.
- [x] Native exact-extension artifact builders are independent target builders
  from the same PostgreSQL/liboliphaunt source and ABI inputs. They are now
  addressed by target, receive the exact selected product set as
  `OLIPHAUNT_EXTENSION_PRODUCTS`, do not run the `liboliphaunt-native` runtime
  artifact producer through Moon upstream expansion, and upload target indexes
  containing one row per produced exact-extension artifact. Native
  exact-extension builders restore the same target-scoped compiler/build cache
  family as base native runtime builders, with extension inputs in the cache
  key, so repeated exact-extension jobs do not intentionally recompile
  unchanged PostgreSQL/liboliphaunt inputs. The Moon task now depends on
  `source-inputs:source-fetch-native-runtime`, not the weaker
  extension-only source fetch, because native extension builds need shared and
  native third-party source pins such as ICU. Mobile and Swift jobs still
  select `liboliphaunt-native` explicitly because they consume its packaged
  runtime artifacts.
- [x] Public artifact matrix labels use friendly target ids consistently.
  Evidence: WASIX AOT CI matrix emits `target_id` values such as
  `macos-arm64`, `linux-x64-gnu`, `linux-arm64-gnu`, and
  `windows-x64-msvc`, matching native/helper target ids.
- [x] WASIX AOT builder target metadata is product-local. Evidence:
  `src/runtimes/liboliphaunt/wasix/targets/*` declares runner, triple, asset,
  and `llvm_url`; `tools/release/artifact_target_matrix.py` reads those fields
  instead of carrying target-specific URL maps in the CI planner.
- [x] WASIX AOT build artifacts use an explicit GitHub artifact envelope.
  Evidence: AOT builders stage `target-triple.txt` plus a `files/` payload
  before upload; release aggregation restores the target layout from that
  marker instead of assuming GitHub artifact downloads preserve
  `target/oliphaunt-wasix/aot/<triple>` parent paths.
- [x] Mobile build jobs consume prebuilt native runtime and target-scoped native
  extension package artifacts. They do not source-build liboliphaunt or stage
  extension packages locally, and focused Android/iOS mobile plans build only
  the platform app artifact path. They do not build WASIX extension artifacts
  and do not start emulator/simulator E2E jobs in the `Builds` workflow.
- [x] Mobile-focused extension artifact builders are target-scoped. Evidence:
  direct `tools/graph/ci_plan.py` probes show Android mobile builds select
  native extension artifacts for `android-arm64-v8a` and `android-x86_64`
  only, iOS mobile builds select `ios-xcframework` only, and standalone
  extension-package builds still select every published native
  exact-extension target. Focused Android/iOS builder plans now emit zero
  WASIX exact-extension matrix rows because the WASIX extension builder is not
  selected.
- [x] Exact-extension product selection is scoped by intent. Evidence:
  focused mobile builder plans emit `OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS` for
  `oliphaunt-extension-vector` only; full builder plans emit the explicit full
  exact-extension product list so `extension-packages` builds every
  exact-extension product across native and WASIX publishable targets. Policy
  also checks single-product matrix narrowing for both external
  (`oliphaunt-extension-vector`) and PostgreSQL contrib
  (`oliphaunt-extension-amcheck`) extension products, and checks the real
  affectedness shape where a single exact-extension product change also
  selects aggregate native/WASIX/package tasks.
- [x] Mobile build jobs require staged SDK package artifacts in CI. Evidence:
  CI sets `OLIPHAUNT_EXPO_REQUIRE_SDK_ARTIFACTS=1`; Android consumes the staged
  React Native tarball plus Kotlin Maven repository artifacts; iOS consumes the
  staged React Native tarball and creates a local Git source from the staged
  Swift source archive for CocoaPods.
- [x] Mobile build jobs inspect the produced app artifact for selected-extension
  correctness. Evidence: CI runs
  `tools/release/check_staged_artifacts.py --require-mobile android
  --require-mobile-prebuilt-extensions` and the corresponding iOS command after
  app build, so the app package must contain only selected extension files and
  must have matching prebuilt exact-extension package inputs.
- [x] iOS selected-extension artifact inspection is link-aware instead of
  metadata-only. Evidence:
  `src/sdks/react-native/tools/mobile-extension-runtime.sh` now rejects missing
  or unselected `liboliphaunt_extension_<stem>.xcframework` inputs after
  unpacking exact-extension artifacts; `src/sdks/react-native/tools/expo-ios-runner.sh`
  stages generated registry C under compile-only
  `ios/generated/static-registry/`; and
  `tools/release/check_staged_artifacts.py --require-mobile ios
  --require-mobile-prebuilt-extensions` now requires Xcode link evidence for
  selected extension frameworks while rejecting build-only registry source or
  extension-framework inputs inside the final `.app` resource bundle.
- [x] Android selected-extension artifact inspection is link-aware at the
  Android SDK/RN package build boundary instead of metadata-only. Evidence:
  the Kotlin Android SDK accepts `oliphauntAndroidLinkEvidenceFile`, passes it
  into its CMake static-extension target, and writes
  `oliphaunt-android-static-extension-link-v1` rows for ABI, liboliphaunt, each
  selected static extension archive, and dependency archives. React Native
  Android passes the same property through its builder and
  `src/sdks/react-native/tools/check-sdk.sh build-android-bridge` asserts that
  vector's `liboliphaunt_extension_vector.a` was linked for the selected ABI.
  The staged mobile artifact checker now requires this Android link evidence
  whenever `--require-mobile android --require-mobile-prebuilt-extensions` is
  used, validates the linked `liboliphaunt.so`, verifies selected extension
  archive paths against the static-registry manifest target id
  (`android-arm64-v8a`/`android-x86_64`), and rejects missing or unselected
  dependency archive rows.
- [x] Swift SDK package artifacts render the public SwiftPM release manifest
  from the real Apple liboliphaunt SwiftPM target artifact in CI, not a local
  fixture and not the all-platform aggregate release asset job. Evidence:
  `swift-sdk-package` depends on `liboliphaunt-native-ios`, downloads
  `liboliphaunt-native-release-assets-ios-xcframework`, sets
  `OLIPHAUNT_SWIFT_RELEASE_ASSET_DIR`, and
  `src/sdks/swift/tools/check-sdk.sh package-shape` fails closed unless that
  directory contains a real
  `liboliphaunt-<version>-apple-spm-xcframework.zip` with macOS, iOS device,
  and iOS simulator slices.
- [x] Downloaded-artifact consumer jobs run their explicit Moon target with
  `OLIPHAUNT_MOON_UPSTREAM=none`, so they do not re-run producer tasks after
  GitHub artifact handoff. SDK package jobs also run their package target with
  upstream traversal disabled so they cannot silently rebuild helper/runtime
  package tasks inside an SDK builder.
- [x] WASIX exact-extension packaging consumes portable runtime outputs instead
  of rerunning source-generation checks. Evidence: strict generated asset
  validation remains in `liboliphaunt-wasix:runtime-portable`; the WASIX
  extension artifact packager now only validates and stages archives from the
  downloaded/generated portable runtime asset root.
- [x] Release dry-run SDK validation consumes staged builder artifacts in
  all release modes instead of rebuilding SDKs from source. Evidence:
  `release.py` validates staged Cargo crates, Kotlin Maven repository
  artifacts, Swift release manifests/source archives, and npm/JSR tarballs;
  Kotlin, React Native, TypeScript, WASIX Rust, and Rust dry-runs return after
  staged validation rather than invoking `check-sdk.sh`, Gradle local publish,
  `cargo package`, or `cargo publish --dry-run`.
- [x] Kotlin SDK builder artifacts use the consumer-facing Maven repository as
  the package boundary. Evidence: `tools/release/build-sdk-ci-artifacts.sh`
  stages `target/sdk-artifacts/oliphaunt-kotlin/maven` only, React Native
  Android derives the Kotlin dependency from that staged Maven repo, and
  `tools/release/check_staged_artifacts.py` now requires the Maven repository
  instead of loose top-level AAR/JAR files.
- [x] Builds workflow no longer defines mobile E2E, docs, coverage,
  regression, release-intent, release-readiness, or repository policy jobs.
  Evidence: `.github/workflows/ci.yml` now contains only `affected`, runtime
  artifact builders, helper runtime builders, exact-extension artifact/package
  builders, SDK package builders, mobile app builders, `artifact-builders`, and
  `required`; `tools/policy/check-release-policy.py` rejects any non-builder
  Moon job that reappears in this workflow.
- [x] Required job aggregate is builder-first. Evidence:
  `required` gates only `affected` and `artifact-builders`; `artifact-builders` verifies every
  selected runtime, helper runtime, SDK package, extension artifact, extension
  package, and mobile app builder job from `builder_jobs`. Static checks,
  docs, coverage, regressions, and E2E are intentionally outside this builder
  workflow and cannot replace the release artifact gate.
- [x] Full non-PR Builds runs are deliverable builders by default. Evidence:
  `tools/graph/ci_plan.py::plan_for_full_run()` starts from `BUILDER_JOBS`
  plus the WASIX AOT target planner dependency, and
  `tools/policy/check-release-policy.py` rejects full-run plans that select
  non-builder side lanes such as `repo`, `release-intent`, docs, regressions,
  E2E, coverage, or release-readiness.
- [x] Mobile app builders consume staged SDK, runtime, and exact-extension
  artifacts with source-build fallbacks disabled in CI. Evidence:
  `tools/policy/check-release-policy.py` requires Android/iOS mobile build jobs
  to depend on the relevant liboliphaunt target builder, SDK package builders,
  and `mobile-extension-packages`; download the staged artifacts; set
  `OLIPHAUNT_EXPO_ALLOW_NATIVE_BUILDS=0`,
  `OLIPHAUNT_EXPO_REQUIRE_SDK_ARTIFACTS=1`, and
  `OLIPHAUNT_EXPO_REQUIRE_PREBUILT_EXTENSIONS=1`; and run strict
  `check_staged_artifacts.py --require-mobile-*-prebuilt-extensions`
  validation after app build. Android and iOS mobile builders now force
  release-mode app artifacts (`OLIPHAUNT_EXPO_ANDROID_BUILD_TYPE=release`,
  `OLIPHAUNT_EXPO_IOS_CONFIGURATION=Release`, and
  `OLIPHAUNT_EXPO_IOS_SDK=iphonesimulator`) so installed-app E2E consumes the
  same artifact class produced by `Builds`.
- [x] Mobile installed-app E2E is separated from the builder workflow and
  consumes built app artifacts from `Builds`. Evidence:
  `.github/workflows/mobile-e2e.yml` triggers from successful `Builds` runs or
  explicit `workflow_dispatch`, requires the `artifact-builders` job to have succeeded,
  downloads `react-native-mobile-android-app-android-x86_64` and
  `react-native-mobile-ios-app`, runs the pinned Maestro path through
  `src/sdks/react-native/tools/mobile-e2e.sh`, starts Android with the existing
  `tools/dev/start-android-emulator-ci.sh`, and does not invoke
  `run-planned-moon-job.sh`, `mobile-build:*`, or native/source-build fallback
  paths. `tools/policy/check-release-policy.py` enforces these invariants.
- [x] React Native mobile task semantics match the Moon CI model. Evidence:
  `oliphaunt-react-native:e2e`, `mobile-drill-android`, and `mobile-drill-ios`
  are `runInCI=false` because routine CI must never invoke aggregate/manual
  device drills. Platform installed-app E2E lanes
  `mobile-e2e-android` and `mobile-e2e-ios` are `runInCI=skip` so broad
  `moon ci` does not start emulator/simulator jobs, while the tasks remain
  graph-valid for explicit installed-app CI workflows. Both
  `tools/policy/check-test-strategy.mjs` and
  `tools/policy/check-moon-product-graph.mjs` enforce this distinction.

## Release Model

- [x] release-please manifest mode owns product components, versions,
  changelogs, and tags. Evidence: `release-please-config.json` and
  `.release-please-manifest.json`.
- [x] Product-local `release.toml` files own registry/package metadata.
  Evidence: `tools/release/product_metadata.py` validates Moon release products
  against release-please components.
- [x] There is no active `release-graph.toml`, `release-inputs.toml`, or
  `tools/graph/jobs.toml` release brain.
- [x] `tools/release/release.py plan` uses Moon project ownership and dependency
  scopes for release closure. Evidence: direct release-plan probes for
  extension catalog, PostGIS target metadata, native runtime patch, and WASIX
  runtime patch paths.
- [x] Release workflow consumes Builds artifacts instead of rebuilding native,
  helper, SDK, WASIX, or extension artifacts during publish.
- [x] Swift SDK release dry-run/publish consumes the Swift SDK builder output
  directly: `Oliphaunt-source.zip` plus `Package.swift.release` under
  `target/sdk-artifacts/oliphaunt-swift`. Aggregate liboliphaunt release
  assets are only downloaded when `liboliphaunt-native` itself is selected for
  release. Evidence: `release.py` validates and copies the staged SwiftPM
  manifest, and `.github/workflows/release.yml` no longer ties Swift releases
  to the aggregate native asset download.
- [x] Staged npm SDK artifacts are real release inputs. Evidence:
  `release.py` validates `@oliphaunt/ts` and `@oliphaunt/react-native`
  tarballs for exact filename, package name, version, no `workspace:`
  dependency specs, and built `package/lib` output before dry-run/publish.
- [x] WASIX runtime release download searches successful same-SHA Builds runs
  until it finds the complete portable/AOT artifact set, so focused reruns do
  not shadow earlier complete runs.
- [x] WASIX runtime release download filters same-SHA Builds runs by the
  `builders` job before installing portable/AOT runtime outputs. Evidence:
  `.github/scripts/download-wasix-runtime-build-artifacts.sh` invokes
  `xtask assets download --required-job artifact-builders`, `xtask` verifies the
  required job conclusion before trying a run, and
  `tools/release/check_artifact_targets.py` enforces the handoff.
- [x] Broker release asset publishing verifies the `oliphaunt-broker` release
  tag before uploading artifacts.
- [x] Exact-extension GitHub release verification includes every uploaded
  package file: JSON manifest, `.properties` manifest, checksum manifest, and
  payload assets.
- [~] Release provenance and attestations cover runtime/helper/extension/WASIX
  asset families. Local policy checks pass; full GitHub release dry-run and
  verification still need CI evidence.
- [x] Release dry-run/publish rejects incomplete staged exact-extension package
  artifacts. Evidence: `tools/release/release.py` validates staged extension
  package manifest identity, JSON asset checksums, checksum-manifest entries,
  and declared native/WASIX target coverage; `release.py` now has no native,
  WASIX, or exact-extension local builder fallback, so missing staged extension
  package artifacts fail immediately.

## Extensions

- [x] Public selection model is exact SQL extension name only. No packs,
  aliases, or grouped selectors.
- [x] Every public extension in the generated SDK catalog is modeled as an
  exact-extension release product. Evidence:
  `src/extensions/generated/sdk/rust.json` drives
  `tools/policy/check-release-policy.py`, which requires the release product
  set to match the public catalog. The current graph has 39 exact-extension
  products: PostgreSQL contrib products under `src/extensions/contrib/<id>/`
  and external products under `src/extensions/external/<id>/`.
- [x] Exact-extension products have product-local `release.toml`, `VERSION`,
  `CHANGELOG.md`, and target metadata. PostgreSQL contrib exact-extension
  products depend on `extension-contrib-postgres18` and
  `extension-runtime-contract`; external exact-extension products depend on
  `extension-runtime-contract` and their product-local source/recipe metadata.
- [x] Exact-extension target metadata must declare every native runtime target
  that advertises exact-extension artifact support, with unpublished opt-outs
  required when no real producer exists. Published WASIX target coverage remains
  exact. Evidence:
  `tools/release/check_artifact_targets.py`,
  `src/runtimes/liboliphaunt/native/targets/*.toml`, per-extension
  `targets/artifacts.toml` rows, and full builder planner output that includes
  `windows-x64-msvc` in the native exact-extension artifact matrix with all 39
  exact-extension products selected.
- [x] Native and WASIX extension artifact builders emit target-addressed
  release assets consumed by package assembly.
- [x] Exact-extension package assembly is single-path. Release builds the
  complete native+WASIX package set; mobile app builders consume target-scoped
  package artifacts through the same manifest/checksum/staging code and only
  require Android/iOS native targets.
- [x] Exact-extension package assembly reads target-addressed artifact indexes
  only from declared published targets, not recursive scratch globs. Evidence:
  a stale `target/extensions/native/release-assets/test-mobile` directory no
  longer creates duplicate vector package rows.
- [x] Exact-extension package assembly has no broad native-index fallback.
  Evidence: `tools/release/build-extension-ci-artifacts.py` now requires
  product-scoped target indexes from
  `target/extensions/native/release-assets/<target>/<product>/...` and fails
  when required target artifacts are missing.
- [x] Mobile exact-extension package assembly filters to the requested mobile
  native targets instead of carrying every downloaded desktop/native artifact
  into mobile build handoff artifacts. Evidence:
  `python3 tools/release/build-extension-ci-artifacts.py
  oliphaunt-extension-vector --output-root
  target/extension-artifacts-mobile-validate --require-native-target
  android-x86_64 --require-native-target ios-xcframework` stages only
  `android-x86_64` and `ios-xcframework` vector assets.
- [x] Exact-extension release packages emit JSON manifest, ecosystem-friendly
  `.properties` manifest, and checksum manifest. Evidence:
  `tools/release/build-extension-ci-artifacts.py oliphaunt-extension-vector
  --output-root target/extension-artifacts-test` staged
  `oliphaunt-extension-vector-0.1.0-manifest.properties` and
  `oliphaunt-extension-vector-0.1.0-release-assets.sha256`.
- [x] SDK package checks prove wrapper packages do not ship runtime or
  extension payloads. Evidence:
  `tools/release/check_staged_artifacts.py --inspect-present` validates staged
  Swift, Kotlin, React Native, and TypeScript package artifacts, rejects
  runtime/share/static-registry payload leaks, and caught then removed a stale
  Kotlin debug AAR that embedded smoke runtime/vector assets. SDK staging now
  runs `check_staged_artifacts.py --require-sdk-product "$product"` for every
  SDK product and stages only the Kotlin release AAR.
- [x] Mobile app artifact checks prove unselected extension files do not enter
  app artifacts. Evidence:
  `tools/release/check_staged_artifacts.py --require-mobile ios
  --require-mobile-prebuilt-extensions` validates the fresh iOS `.app` built
  from staged React Native, Swift, liboliphaunt, and exact-extension artifacts;
  the checker binds the build report to the inspected app path, byte size,
  selected extensions, CocoaPods extension link file lists, and Xcode linked
  products. Strict Android prebuilt mode remains pending on Linux-produced
  `android-arm64-v8a` vector extension package evidence because the current
  local macOS host cannot build that Android target.
- [~] Local staged artifact inspection covers wrapper packages and
  exact-extension package shape. Strict iOS installed-app artifact inspection
  is now green after rebuilding through the current staged handoff. Remaining
  work: produce the matching Android exact-extension package on Linux/CI or
  devbox, rebuild/validate the Android mobile artifact against that package,
  and then run full `--inspect-present` without stale local Android state.
- [~] Each advertised extension needs current target smoke evidence across
  desktop native, mobile static registry targets, and WASIX. Builder targeting
  now covers every published native target plus WASIX: full builder planning
  emits 7 native target rows, with Windows scoped to contrib products until
  external PGXS/PostGIS Windows producers exist, and 1 `wasix-portable` row
  carrying the WASIX exact-extension product set. Current smoke evidence is
  still transitional/catalog-level and needs real target smoke results from CI
  before this item can be marked complete.

## SDK Contracts

- [x] Rust, Swift, Kotlin, React Native, TypeScript, and WASIX Rust binding are
  peer products with product-local Moon tasks and package artifacts. Evidence:
  each product is tagged `release-product`, declares release-please component
  metadata, has a product-local `package-artifacts` task, writes to
  `target/sdk-artifacts/<product>/**/*`, and maps to a `ci-*-sdk-package`
  builder tag. `tools/policy/check-moon-product-graph.mjs` enforces the
  commands, outputs, cache policy, and CI tag mappings for all six peer SDKs.
- [x] Kotlin SDK package artifacts include an Android-consumable Maven
  repository layout for both `oliphaunt-android` and the
  `dev.oliphaunt.android` Gradle plugin. Evidence:
  `tools/release/build-sdk-ci-artifacts.sh oliphaunt-kotlin` passes and stages
  both Maven artifacts under `target/sdk-artifacts/oliphaunt-kotlin/maven`.
- [x] React Native package artifacts exclude native runtime/resource payloads.
  Evidence: `src/sdks/react-native/package.json` excludes
  `android/src/main/assets/**`, `android/src/main/jniLibs/**`, and
  `ios/resources/**`, and staged package validation passes for
  `oliphaunt-react-native`.
- [~] React Native is TypeScript/TurboModule glue over Swift and Kotlin, not a
  private database runtime. Static checks exist, and the installed-app E2E
  workflow now consumes `Builds` app artifacts without rebuilding source. iOS
  selected-extension packaging requires exact XCFramework unpacking,
  compile-only static-registry source staging, Xcode link evidence, explicit
  resource-bundle discovery, and static registry linker retention in the final
  app binary. Local iOS installed-app E2E is green for the `vector` selection,
  but this remains partial until GitHub Mobile E2E can run against same-SHA
  `Builds` artifacts.
- [~] Kotlin Android and Swift iOS/macOS consume liboliphaunt and exact selected
  extension artifacts through ecosystem-native package surfaces. Kotlin Android
  now resolves exact extension releases independently from `liboliphaunt-native`
  and verifies per-extension checksums; Swift base release now explicitly stays
  extension-free, no longer advertises nonexistent `OliphauntExtension*`
  SwiftPM products, renders its release manifest from the CI-built Apple
  liboliphaunt XCFramework artifact, and exposes
  `OliphauntExtensionArtifactResolver.resolveNativeArtifacts(...)` to select the
  exact target artifact names and dependency closure for Swift app integrations.
  Swift SDK package artifact creation now passes against a deterministic
  release-shaped Apple XCFramework fixture, proving the public SwiftPM
  manifest/package boundary locally. React Native iOS now has strict link-aware
  selected-extension package inspection plus local release-mode installed-app
  proof using the real native Apple XCFramework artifact and exact-extension
  package handoff. Remaining work: same-SHA GitHub Mobile E2E evidence after
  the workflow is available on the default branch.
- [x] TypeScript package artifacts stay SDK-scoped. Evidence:
  `tools/release/build-sdk-ci-artifacts.sh oliphaunt-js` stages the npm tarball
  and JSR source only; the affected planner now selects only `js-sdk-package`
  for `oliphaunt-js:package-artifacts`. Broker and Node-direct helper artifacts
  are built and downloaded only when the helper products themselves are being
  released.
- [x] Node direct optional npm packages are built in the Builds workflow and
  published from staged tarballs. Evidence:
  `src/runtimes/node-direct/tools/build-node-addon.sh` emits both
  `target/oliphaunt-node-direct/release-assets/*` and
  `target/oliphaunt-node-direct/npm-packages/*.tgz`; the release workflow
  downloads `oliphaunt-node-direct-npm-package-*`; `release.py` validates and
  publishes those tarballs directly.
- [x] WASIX Rust binding package artifacts stay binding-scoped and do not force
  a runtime rebuild. Evidence:
  `MOON_BIN=$HOME/.proto/shims/moon
  .github/scripts/run-moon-targets.sh oliphaunt-wasix-rust:package-artifacts`
  passes. The builder packages the root `oliphaunt-wasix` crate through a
  narrowed WASIX workspace package set so Cargo sees the same-release internal
  asset/AOT crates, stages only `oliphaunt-wasix-0.5.1.crate` plus package-file
  metadata under `target/sdk-artifacts/oliphaunt-wasix-rust`, and
  `python3 tools/release/check_staged_artifacts.py --require-sdk-product
  oliphaunt-wasix-rust` validates that the SDK artifact does not carry runtime
  payloads.

## Tool Entrypoints And Policy

- [x] Repository tasks are Moon-first. Root package-manager aliases are not the
  public orchestration surface.
- [x] pnpm remains JS dependency/package-manager tooling, not the global graph.
- [x] Cargo, SwiftPM/Xcode, Gradle, npm/JSR, and Expo are invoked through
  product-local Moon tasks or product-owned scripts.
- [x] Policy checks reject stale release graphs, root product aliases, broad
  generated-state inputs, and mobile source-build fallbacks.
- [x] Policy checks reject retired release-tool references on active product,
  workflow, and release surfaces. Evidence:
  `tools/policy/check-final-source-architecture.py --self-test` scans tracked
  `src`, `.github`, and `tools/release` files for retired `release-plz` and
  `git-cliff` references while allowing the architecture/tooling docs to name
  retired surfaces as policy.
- [~] Policy scripts should remain minimal and guard real architecture
  invariants only. Continue pruning brittle substring checks as better
  structural checks become available.

## Verification Commands

Run before claiming this architecture complete:

- [x] `bash -n tools/release/build-sdk-ci-artifacts.sh
  src/sdks/swift/tools/check-sdk.sh`
- [x] `python3 -m py_compile tools/release/release.py
  tools/release/build-extension-ci-artifacts.py tools/graph/ci_plan.py
  tools/release/check_artifact_targets.py
  tools/release/check_release_metadata.py`
- [x] `python3 tools/graph/graph.py check`
- [x] `node tools/policy/check-moon-product-graph.mjs`
- [x] `python3 tools/release/check_artifact_targets.py`
- [x] `python3 tools/policy/check-release-policy.py`
- [x] `moon run ci-workflows:check graph-tools:check`
- [x] `MOON_BIN=$HOME/.proto/shims/moon
  .github/scripts/run-moon-targets.sh ci-workflows:check`
- [x] `bash src/sdks/react-native/tools/check-sdk.sh build-android-bridge`
- [x] `moon run policy-tools:check release-tools:check graph-tools:check`
- [x] `MOON_BIN=$HOME/.proto/shims/moon
  .github/scripts/run-moon-targets.sh extensions:check`
- [x] `MOON_BIN=$HOME/.proto/shims/moon
  .github/scripts/run-moon-targets.sh extension-model:check
  extension-artifacts-native:check extension-artifacts-wasix:check`
- [x] `moon query projects`
- [x] `moon query tasks`
- [x] `moon run :check` completed locally with 84 tasks, 72 cached, after
  builder-first CI policy, conditional matrix emission, and JS staged-artifact
  release checks were aligned.
- [x] `moon run :test` completed locally with 28 tasks, including native
  host smoke, Rust nextest, Swift tests, Kotlin Gradle tests, React Native and
  TypeScript Vitest suites, docs tests, broker tests, and WASIX Rust tests.
- [x] `moon run :package` completed locally with 14 tasks, 5 cached. This now
  verifies local package shape only; publishable SDK artifact envelopes use
  explicit `package-artifacts` builder tasks, and runtime/extension/mobile
  artifacts stay in target-scoped builder jobs.
- [x] `python3 tools/graph/ci_plan.py` for a full run now selects only
  `affected` plus 21 artifact-producing builder jobs. WASIX AOT target fan-out
  is emitted by the affected plan as
  `liboliphaunt_wasix_aot_runtime_matrix`; there is no separate AOT planner job
  in the Builds workflow.
- [x] `GITHUB_EVENT_NAME=workflow_dispatch NATIVE_TARGET=all
  WASM_TARGET=linux-x64-gnu MOBILE_TARGET=all
  python3 .github/scripts/plan-affected.py` now selects only
  `affected`, `liboliphaunt-wasix-runtime`, and `liboliphaunt-wasix-aot`;
  it does not select `liboliphaunt-wasix-release-assets`,
  `wasix-rust-package`, SDK packages, extension packages, or mobile builders.
  The emitted AOT matrix contains the single friendly target id
  `linux-x64-gnu`.
- [x] `tools/release/release.py plan`
- [x] `tools/release/release.py check`
- [x] `tools/release/release.py consumer-shape --format json --require-ready
  --products-json '["oliphaunt-swift"]'`
- [x] `tools/release/release.py publish-dry-run --products-json
  '["oliphaunt-extension-vector"]' --head-ref HEAD` fails closed when the
  staged exact-extension package is incomplete or missing.
- [x] `python3 tools/release/artifact_target_matrix.py
  liboliphaunt-wasix-aot-runtime` emits friendly `target_id` values for every
  WASIX AOT builder target from product-local target metadata.
- [x] `tools/release/build-sdk-ci-artifacts.sh oliphaunt-js`
- [x] `tools/release/build-sdk-ci-artifacts.sh oliphaunt-kotlin`
- [x] `tools/release/build-sdk-ci-artifacts.sh oliphaunt-react-native`
- [x] `tools/release/build-sdk-ci-artifacts.sh oliphaunt-rust`
- [x] `tools/release/build-sdk-ci-artifacts.sh oliphaunt-wasix-rust`
- [x] `MOON_BIN=$HOME/.proto/shims/moon
  .github/scripts/run-moon-targets.sh oliphaunt-rust:package-artifacts`
- [x] `MOON_BIN=$HOME/.proto/shims/moon
  .github/scripts/run-moon-targets.sh oliphaunt-wasix-rust:package-artifacts`
- [x] `OLIPHAUNT_SWIFT_RELEASE_ASSET_DIR=$PWD/target/test-fixtures/liboliphaunt-swift-release
  tools/release/build-sdk-ci-artifacts.sh oliphaunt-swift` passes against a
  deterministic release-shaped liboliphaunt fixture whose Apple SwiftPM
  XCFramework zip has macOS, iOS device, and iOS simulator slices. This proves
  the Swift SDK package artifact path renders a checksum-pinned public
  `Package.swift.release`, stages `Oliphaunt-source.zip`, and passes
  `python3 tools/release/check_staged_artifacts.py --require-sdk-product
  oliphaunt-swift`. The CI `liboliphaunt-native-ios` builder still owns proof
  that the real native Apple XCFramework asset is produced.
- [x] `GITHUB_EVENT_NAME=workflow_dispatch NATIVE_TARGET=all
  WASM_TARGET=all MOBILE_TARGET=ios python3 .github/scripts/plan-affected.py`
- [x] `GITHUB_EVENT_NAME=workflow_dispatch NATIVE_TARGET=all
  WASM_TARGET=all MOBILE_TARGET=android python3 .github/scripts/plan-affected.py`
- [x] `tools/graph/ci_plan.py` direct probe for
  `{"extension-artifacts-native:build-target"}` selects
  `extension-artifacts-native` without `liboliphaunt-native`, proving extension
  artifact-only work does not create a native-runtime waterfall.
- [x] `tools/graph/ci_plan.py` direct probes for
  `oliphaunt-react-native:mobile-build-android` and
  `oliphaunt-react-native:mobile-build-ios` select only Android or iOS native
  extension artifacts respectively.
- [x] `tools/graph/ci_plan.py` direct probe for
  `oliphaunt-react-native:package-artifacts` selects
  `react-native-sdk-package`, `mobile-build-android`, `mobile-build-ios`,
  `kotlin-sdk-package`, `swift-sdk-package`, Android/iOS native runtime
  builders, and `mobile-extension-packages`; native target selection is exactly
  `android-arm64-v8a`, `android-x86_64`, and `ios-xcframework`.
- [x] `tools/graph/ci_plan.py` direct probe for a single
  `oliphaunt-extension-postgis` change with aggregate artifact/package tasks
  selects only `oliphaunt-extension-postgis`, emits 6 native rows, and emits 1
  WASIX row.
- [x] `python3 tools/release/check_staged_artifacts.py
  --require-sdk-product oliphaunt-rust`
- [x] `python3 tools/release/check_staged_artifacts.py
  --require-sdk-product oliphaunt-kotlin`
- [x] `python3 tools/release/check_staged_artifacts.py
  --require-sdk-product oliphaunt-swift`
- [x] `python3 tools/release/check_staged_artifacts.py
  --require-sdk-product oliphaunt-react-native`
- [x] `python3 tools/release/check_staged_artifacts.py
  --require-sdk-product oliphaunt-js`
- [x] `python3 tools/release/check_staged_artifacts.py
  --require-sdk-product oliphaunt-wasix-rust`
- [x] `python3 tools/release/check_staged_artifacts.py --require-mobile ios
  --require-mobile-prebuilt-extensions` passes after rebuilding
  `pnpm --dir src/sdks/react-native/examples/expo run mobile-build:ios` with
  staged SDK, native runtime, and exact-extension artifacts. The fresh app
  keeps generated static-registry C under compile-only
  `ios/generated/static-registry`, bundles runtime resources under
  `OliphauntReactNativeResources.bundle`, and proves selected
  `liboliphaunt_extension_vector` linkage through CocoaPods and Xcode build
  products.
- [x] Local iOS release-mode installed-app E2E passes with exact-extension
  `vector` using the staged native Apple XCFramework, generated exact-extension
  package, and clean simulator install:
  `OLIPHAUNT_EXPO_ALLOW_NATIVE_BUILDS=0
  OLIPHAUNT_EXPO_REQUIRE_PREBUILT_EXTENSIONS=1
  OLIPHAUNT_EXPO_IOS_EXTENSIONS=vector
  OLIPHAUNT_EXPO_IOS_REPACK_RN=1
  bash src/sdks/react-native/tools/mobile-build.sh ios`, followed by
  `bash src/sdks/react-native/tools/mobile-e2e.sh ios` against
  `target/mobile-build/react-native/ios-local-vector-fix-v4`. The app launches
  from `OliphauntReactNativeResources.bundle`, the bundled template PGDATA uses
  `dynamic_shared_memory_type = mmap`, UTC time zones, and `C` locale settings,
  the final app binary contains
  `_liboliphaunt_selected_static_extensions` plus vector registry symbols, and
  Maestro sees `liboliphaunt-smoke-status-passed`.
- [x] `GITHUB_EVENT_NAME=workflow_dispatch NATIVE_TARGET=ios-xcframework
  WASM_TARGET=all MOBILE_TARGET=all python3 .github/scripts/plan-affected.py`
- [x] Focused mobile builder plans are target-consistent:
  `GITHUB_EVENT_NAME=workflow_dispatch NATIVE_TARGET=android-arm64-v8a
  WASM_TARGET=all MOBILE_TARGET=android python3 .github/scripts/plan-affected.py`
  emits one Android exact-extension row, one Android app row, and
  `mobile_extension_package_native_targets=["android-arm64-v8a"]`; the matching
  iOS probe emits only `ios-xcframework`. Incompatible focused inputs such as
  `MOBILE_TARGET=android NATIVE_TARGET=ios-xcframework` now fail closed in the
  planner.
- [x] Android SDK provisioning is shared and reproducible. Evidence:
  `.github/actions/setup-android` calls `tools/dev/setup-android-sdk.sh`; the
  script bootstraps Android command-line tools when `sdkmanager` is absent,
  installs the pinned platform-tools/platform/build-tools/CMake/NDK packages
  through `sdkmanager`, and passes idempotently on the local Android SDK with
  NDK `27.0.12077973`, CMake `3.22.1`, and compile SDK `36`.
- [x] `bash src/sdks/kotlin/tools/check-sdk.sh check-static`
- [x] `bash src/runtimes/node-direct/tools/build-node-addon.sh`
- [x] `python3 tools/release/build-extension-ci-artifacts.py
  oliphaunt-extension-vector --output-root target/extension-artifacts-validate
  --require-native-target android-x86_64 --require-native-target
  ios-xcframework`
- [x] `./gradlew :oliphaunt-android-gradle-plugin:compileJava :oliphaunt:tasks --no-daemon`
- [x] `swift test --package-path src/sdks/swift --scratch-path
  target/swift-test-extension-resolver-2`
- [x] `tools/release/release.py publish-dry-run` passes in public no-product
  policy/metadata mode. Product-scoped dry-runs still require staged builder
  artifacts from the same-SHA `Builds` workflow and remain covered by the
  release workflow evidence items below.
- [x] Local builder-architecture checks passed after the builder-first CI
  cleanup: `git diff --check`, `actionlint .github/workflows/ci.yml
  .github/workflows/mobile-e2e.yml .github/workflows/release.yml`,
  `node tools/policy/check-moon-product-graph.mjs`,
  `bash tools/policy/check-tooling-stack.sh`,
  `python3 tools/release/check_artifact_targets.py`, and
  `python3 tools/policy/check-release-policy.py`.
- [x] Local PR 38 CI hardening checks passed after fixing the observed builder
  failures: `cargo run -p xtask -- assets verify-committed`, `bash -n` for the
  touched native scripts, `sh -n src/runtimes/node-direct/tools/build-node-addon.sh`,
  `actionlint .github/workflows/ci.yml .github/workflows/mobile-e2e.yml
  .github/workflows/release.yml`, `python3 tools/release/check_artifact_targets.py`,
  `python3 tools/policy/check-release-policy.py`,
  `node tools/policy/check-moon-product-graph.mjs`,
  `bash tools/policy/check-sdk-mobile-extension-surface.sh`,
  `bash tools/policy/check-sdk-parity.sh`, and
  `bash tools/policy/check-repo-structure.sh`.
- [x] Local PR 38 Windows builder follow-up checks passed after making native
  extension source fetch skip PostgreSQL preparation and making the Windows base
  runtime prune exact-extension artifacts before packaging:
  `bash -n src/extensions/artifacts/native/tools/package-release-assets.sh`,
  `git diff --check`, `cargo run -p oliphaunt --bin oliphaunt-resources
  --locked -- --list-extensions`, `cargo run -p xtask -- assets
  verify-committed`, `actionlint .github/workflows/ci.yml
  .github/workflows/mobile-e2e.yml .github/workflows/release.yml`,
  `python3 tools/release/check_artifact_targets.py`,
  `python3 tools/policy/check-release-policy.py`,
  `node tools/policy/check-moon-product-graph.mjs`,
  `bash tools/policy/check-sdk-mobile-extension-surface.sh`,
  `bash tools/policy/check-sdk-parity.sh`, `bash tools/policy/check-repo-structure.sh`,
  and `bash src/runtimes/node-direct/tools/check-package.sh check-static`.
  PowerShell parsing/execution still needs the GitHub Windows runner because
  `pwsh` is not installed in this macOS worktree.
- [x] GitHub Builds run `27380605889` on `ff25ab64` proved the next CI-only
  blockers after the Windows pruning patch: Windows desktop source fetch still
  prepared the WASIX PostgreSQL tree, Windows exact-extension Meson setup needed
  WinFlexBison provisioning, and WASIX runtime artifact tasks were skipped by
  `runInCI: skip`. The follow-up patch makes every native-runtime source fetch
  that only needs pinned checkouts pass `--skip-postgres-prepare`, lets Windows
  native extension builders run `.github/scripts/setup-native-build-tools.sh`,
  marks WASIX artifact-producing Moon tasks `runInCI: true`, and extends the
  executable ownership policy to `src/extensions/artifacts/packages/tools/*`.
  Local checks after this patch passed: `bash -n` for touched shell scripts,
  `actionlint .github/workflows/ci.yml .github/workflows/mobile-e2e.yml
  .github/workflows/release.yml`, `node tools/policy/check-moon-product-graph.mjs`,
  `python3 tools/release/check_artifact_targets.py`,
  `python3 tools/policy/check-release-policy.py`,
  `bash tools/policy/check-repo-structure.sh`,
  `node tools/policy/check-test-strategy.mjs`,
  `cargo run -p xtask -- assets verify-committed`,
  `bash tools/policy/check-tooling-stack.sh`, and `git diff --check`.
- [x] GitHub Builds run `27381488172` on `9181f71a` proved the next CI-only
  blockers: Apple native extension jobs failed on macOS Bash 3.2 empty-array
  expansion in `build-postgres18-macos.sh`, the iOS XCFramework validator
  incorrectly applied mobile-forbidden shm/semaphore checks to the macOS
  framework slice, and the Windows native extension row selected external
  PGXS/PostGIS products even though Windows has no producer for those sources.
  The Android native extension jobs also reached the combined mobile static
  link and failed on duplicate `difference` / `pg_finfo_difference` symbols
  exported by contrib `fuzzystrmatch` and PostGIS `postgis_legacy.o`.
  The follow-up patch guards Apple empty-array expansion, limits the mobile API
  import check to iOS/iOS simulator slices, marks external PGXS/PostGIS Windows
  targets unpublished with explicit reasons, and relaxes policy to require
  explicit native target opt-outs rather than false published coverage. It also
  namespaces PostGIS legacy mobile static symbols, records those mappings as
  exact-extension `staticSymbolAliases`, and teaches generated mobile static
  registry source to keep SQL-visible symbol names while pointing at aliased
  link-time identifiers. Local checks after this patch passed: `bash -n` for
  touched shell scripts, `cargo check --manifest-path src/sdks/rust/Cargo.toml
  --locked`, focused Rust static-registry alias test, `git diff --check`,
  `python3 tools/release/check_artifact_targets.py`,
  `python3 tools/policy/check-release-policy.py`, `python3 -m py_compile` for
  touched Python release/graph modules,
  `bash tools/policy/check-sdk-mobile-extension-surface.sh`,
  `python3 tools/release/artifact_target_matrix.py extension-artifacts-native`,
  and `tools/release/release.py consumer-shape --format json --require-ready
  --products-json '["oliphaunt-extension-vector"]'`.
- [x] GitHub Builds run `27383810080` on `d7ad6eca` proved the next CI-only
  blockers: the WASIX runtime committed asset-input fingerprint was stale,
  Android x86_64 and Linux arm64 native-runtime source fetches failed through
  `ftpmirror.gnu.org` libiconv 502s, Apple extension runtime builds passed the
  embedded `-bundle_loader` through `PG_LDFLAGS` so PostgreSQL's Darwin default
  `BE_DLLLIBS=-bundle_loader ../../src/backend/postgres` won and failed when
  the backend executable link was intentionally tolerated, and the Windows
  exact-extension row still selected `pgcrypto` even though the current Windows
  runtime disables SSL/OpenSSL and does not package that dependency. The
  follow-up refreshes `asset-inputs.sha256`, switches libiconv inputs to the
  canonical GNU URL, routes Darwin PGXS embedded bundle-loader wiring through
  `BE_DLLLIBS`, keeps Bash strict-mode arrays guarded by explicit counts, and
  marks Windows `pgcrypto` unpublished with an OpenSSL runtime dependency
  reason. The native exact-extension matrix now keeps Android/iOS/Linux/macOS
  at 39 products and Windows at 31 before the next Windows `uuid-ossp` follow-up.
  Local evidence after this patch passed:
  focused macOS `OLIPHAUNT_NATIVE_EXTENSION_SQL_NAMES=amcheck`
  `build-postgres18-macos.sh`, `bash -n` for touched shell scripts,
  `cargo run -p xtask -- assets verify-committed`,
  `bun tools/policy/assertions/assert-source-inputs.mjs`,
  `python3 src/extensions/tools/check-extension-model.py --check`,
  `python3 tools/release/check_artifact_targets.py`,
  `python3 tools/policy/check-release-policy.py`,
  `bash tools/policy/check-sdk-mobile-extension-surface.sh`,
  `node tools/policy/check-moon-product-graph.mjs`, and `git diff --check`.
- [x] Builds workflow green on PR for affected builder jobs, including
  Android/iOS release-mode mobile build jobs when selected.
- [x] GitHub Builds run `27384916687` on `eab81d45` proved the Windows
  `pgcrypto` opt-out but exposed one more Windows native exact-extension
  metadata gap: the row still selected `uuid-ossp`; the Windows MSVC producer
  reached `oliphaunt-extension-artifact` for `uuid-ossp` and failed because the
  staged runtime lacked the required control and SQL install files. The same run
  exposed a Darwin external PGXS `pg_textsearch` link gap: its `SHLIB_LINK=-lm`
  override dropped the embedded `BE_DLLLIBS=-bundle_loader ...` path after the
  tolerated backend executable link failure, so iOS/macOS builds saw unresolved
  PostgreSQL backend symbols. The follow-up marks the `uuid-ossp` Windows target
  unpublished with an explicit UUID dependency/control-file reason, reduces the
  Windows native exact-extension row to 30 products until the MSVC producer has
  portable UUID packaging support, and folds Darwin `pg_textsearch`/`pgvector`
  `-lm` linkage into `BE_DLLLIBS` when the embedded bundle-loader path is
  active. Local focused macOS
  `OLIPHAUNT_NATIVE_EXTENSION_SQL_NAMES=pg_textsearch`
  `build-postgres18-macos.sh` passed, and `otool -L` on the packaged module
  shows `@rpath/liboliphaunt.dylib`.
- [x] GitHub Builds run `27386002923` on `3397cd67` proved the Windows
  `uuid-ossp` opt-out and Darwin PGXS link fix: Windows exact-extension
  `windows-x64-msvc` and macOS exact-extension `macos-arm64` both passed. The
  same run exposed two mobile exact-extension blockers: Android
  `android-arm64-v8a` and `android-x86_64` failed because PostGIS
  `postgis_legacy.o` exports token-pasted
  `pg_finfo_oliphaunt_static_postgis_3_difference`, while the static alias
  metadata expected `oliphaunt_static_postgis_3_pg_finfo_difference`; iOS
  `ios-xcframework` failed because mobile static contrib compiles such as
  `dict_xsyn` did not inherit PostgreSQL ICU include flags and could not find
  `unicode/ucol.h`. The follow-up maps `pg_finfo_difference` to the
  token-pasted PostGIS symbol in both mobile object staging and release
  artifacts, and feeds `icu_cflags` into iOS/Android mobile static extension
  compiles. Local evidence after this patch passed: focused Android arm64
  `OLIPHAUNT_MOBILE_STATIC_EXTENSIONS=postgis` produced
  `target/mobile-smoke-android-arm64-postgis/out/liboliphaunt.so` with
  `symbol-aliases.list` mapping `pg_finfo_difference` to
  `pg_finfo_oliphaunt_static_postgis_3_difference`, `llvm-nm` proved the
  matching `postgis_legacy.o` symbols, and focused iOS simulator/device
  `OLIPHAUNT_MOBILE_STATIC_EXTENSIONS=dict_xsyn` builds produced
  `out/liboliphaunt.dylib` while compiling `dict_xsyn.o` with the matching
  `icu-ios-*/include` path.
- [x] GitHub Builds run `27388349669` on `274f86a6` proved the Android
  PostGIS alias and mobile static ICU fixes: native exact-extension
  `android-arm64-v8a`, `android-x86_64`, Linux, macOS, and Windows rows all
  passed, as did WASIX runtime and WASIX exact-extension packaging. The run
  exposed the next iOS-only packaging blocker: `ios-xcframework` got past the
  `dict_xsyn` ICU compile and device static archive production, then failed in
  `build-ios-extension-xcframeworks.sh` because Bash 3.2 plus `set -u` treats
  empty selected dependency arrays as unbound during XCFramework manifest and
  dependency packaging. The follow-up guards the empty-array expansions for
  selected dependencies/extensions/stems and adds a mobile policy assertion for
  the strict-mode guard. Local evidence after this patch passed: `bash -n` for
  the touched shell scripts, `bash tools/policy/check-sdk-mobile-extension-surface.sh`,
  `git diff --check`, and a focused `dict_xsyn` iOS XCFramework packaging
  smoke that produced simulator/device archives under
  `target/ios-xcframework-dict-xsyn-smoke/out` with `dependencies=` in the
  manifest.
- [x] GitHub Builds run `27390718093` on `964cc35` proved the iOS
  XCFramework manifest/dependency guard got past the previous
  `selected_dependencies[@]` failure, but exposed the same Bash 3.2
  strict-mode class in native extension release packaging:
  `package-release-assets.sh` failed at `mobile_dependency_args[@]` while
  packaging iOS products with no mobile dependency archives. The follow-up
  guards empty `mobile_dependency_args` and `extra_args` expansions in both
  iOS and Android package paths, and pins those guards in the mobile extension
  surface policy. Local evidence after this patch passed under Bash 3.2:
  unguarded empty-array harness reproduces `mobile_dependency_args[@]: unbound
  variable`, the guarded harness passes, and the exact CI-shaped
  `extension-artifacts-native:build-target` command for `ios-xcframework`
  completed all 39 selected products with `/bin/bash` 3.2 selected by PATH.
- [x] GitHub Builds run `27392985628` on `e831c4a9` proved the native
  exact-extension matrix and mobile extension package assembly are now green,
  including `ios-xcframework`, both Android exact-extension targets, and
  `build-mobile-extension-packages`. The run exposed the next mobile app
  builder regression: `mobile-build-ios`, `mobile-build-android
  (android-arm64-v8a)`, and `mobile-build-android (android-x86_64)` failed
  before emitting runner logs, with the aggregate `artifact-builders` and
  `required` jobs failing only because those builders failed. Local
  reproduction with downloaded CI iOS native/SDK/mobile-extension inputs
  showed the silent exit came from
  `static_registry_source="$(mobile_static_registry_source_for_library ...)"`
  when the prebuilt liboliphaunt artifact does not have an adjacent
  `liboliphaunt_mobile_static_registry.c`; under `set -e` the helper's final
  missing-file test returned 1 and aborted the script without a diagnostic.
  The follow-up makes Android and iOS static-registry lookup return success
  with an empty result so exact-extension packages can provide the generated
  static registry source, and also hardens React Native runner empty-array
  expansions under Bash 3.2 strict mode. Local evidence after this patch
  passed: Bash syntax checks for the touched runner/policy scripts,
  `bash tools/policy/check-sdk-mobile-extension-surface.sh`,
  `node tools/policy/check-moon-product-graph.mjs`,
  `python3 tools/release/check_artifact_targets.py`, `git diff --check`,
  CI-artifact package lookup for the selected `vector` iOS XCFramework zip,
  and the iOS mobile-build entrypoint progressed to
  `Preparing iOS runtime resources from exact-extension package artifacts:
  vector`; the remaining local stop is expected because the downloaded CI
  `initdb` dylib install names point at the GitHub runner workspace path.
- [x] GitHub Builds run `27400178224` on `e494777f` proved the previous silent
  React Native mobile runner abort is fixed and that the upstream builder
  chain stayed green: native runtime Android/iOS rows, Android/iOS native
  exact-extension rows, and `build-mobile-extension-packages` all passed. The
  remaining leaf failures were the three mobile app builders, all with the
  same CI-only terminal error:
  `oliphaunt-resources: run native PGDATA template initdb: Permission denied`.
  The failure occurs after GitHub artifact handoff, before Xcode or Gradle app
  packaging, and is consistent with downloaded native runtime artifacts losing
  executable bits on PostgreSQL tools such as `bin/initdb`.
- [x] GitHub Builds run `27403805978` on `aac266ca` selected the mobile
  artifact/app lanes again after the runtime tool permission fix and kept the
  native runtime, native exact-extension, SDK, WASIX runtime, and portable
  WASIX extension builders green. The next direct failure is
  `build-liboliphaunt-wasix-aot (windows-x64-msvc)` failing before compilation
  in `.github/actions/setup-wasmer-llvm` while downloading
  `llvm-windows-amd64.tar.xz` with `curl: (52) Empty reply from server`; the
  remaining AOT/package/mobile rows were still running or waiting. The
  follow-up hardens the Wasmer LLVM installer with the same retry-all-errors
  and connection-timeout policy used by other repo downloaders.
- [~] GitHub Builds run `27406731304` on `682840b2` is the current verification
  run for the Wasmer LLVM download hardening. Early evidence is clean:
  `build-plan` passed, early fan-out jobs are succeeding, and no completed
  failures were reported while native runtime, native extension, and WASIX
  runtime rows continued running. The Windows AOT row reached and passed
  `Install Wasmer LLVM 22.1 for AOT generation`, proving the retry-hardened
  setup step clears the previous `curl: (52) Empty reply from server` blocker.
  AOT/package aggregation advanced further, but `mobile-build-ios` then failed
  in `src/sdks/react-native/tools/expo-ios-runner.sh` with
  `mapfile: command not found` on macOS Bash 3.2 after successfully preparing
  iOS runtime resources from exact-extension package artifacts. The follow-up
  replaces that `mapfile` use with a Bash 3-compatible read loop and adds a
  policy guard against reintroducing Bash 4-only `mapfile`/`readarray` usage in
  the iOS mobile runner. This run must still prove AOT artifact completion,
  mobile app builders, and required aggregate before the CI evidence can be
  marked complete.
- [x] GitHub Builds run `27410008857` on `443bf1b8` completed successfully
  with all 44 PR checks green. This proves the Wasmer LLVM setup retry
  hardening, all native/WASIX runtime and exact-extension builders, AOT
  artifact fan-out, artifact/package aggregation, `mobile-build-ios`, both
  Android mobile build rows, `artifact-builders`, and `required` on the same
  SHA. The iOS mobile app build advanced past the previous macOS Bash 3.2
  `mapfile` failure and published the release-mode simulator app artifact.
- [x] Local installed-app iOS validation after the green `Builds` run exposed
  runtime issues that artifact inspection alone did not catch, then proved the
  local fixes. The failure chain was: React Native resources existed under
  `OliphauntReactNativeResources.bundle` but Swift/native-direct bundle
  discovery did not find them; the local `pnpm pack` path excluded
  `ios/resources/**` and did not inject staged mobile assets after install; Rust
  exact-extension packaging generated a host-locale PGDATA template with
  `dynamic_shared_memory_type = posix`; the iOS app did not force-link the pure
  C selected-extension registry object, so `CREATE EXTENSION vector` could not
  resolve `vector`; and simulator data-container reuse could preserve stale bad
  PGDATA. The follow-up adds explicit RN/iOS resource-bundle discovery, shared
  staged asset injection for artifact and local pack installs, mobile-safe Rust
  template initdb/config normalization with a template cache bump, clean
  simulator reinstall by default, and `-u
  _liboliphaunt_selected_static_extensions` when generated static-registry
  sources are present. Local release-mode iOS app build and installed-app E2E
  now pass for selected `vector`.
- [x] GitHub Builds run `27420575821` on `ed24c6e` picked up the installed-app
  fixes but exposed a new Android SDK provisioning flake before any native
  Android source build: `build-native-runtime-android (android-x86_64)` failed
  during `.github/actions/setup-android` while `sdkmanager` downloaded NDK
  `27.0.12077973`, ending with `Error on ZipFile unknown archive` at 21%
  download/unzip progress. The follow-up hardens the shared
  `tools/dev/setup-android-sdk.sh` package install with bounded sdkmanager
  retries and cleanup of partial selected platform/build-tools/CMake/NDK
  directories before retrying, and pins that invariant in
  `tools/policy/check-tooling-stack.sh`. Local evidence after this patch passed:
  `bash -n tools/dev/setup-android-sdk.sh tools/policy/check-tooling-stack.sh`,
  `bash tools/policy/check-tooling-stack.sh`, and `git diff --check`. A
  replacement `Builds` run is required because `27420575821` cannot be the green
  builder evidence.
- [x] GitHub Builds run `27420928633` on `e3b9667` completed successfully with
  all 44 job conclusions green. This proves the Android SDK retry hardening
  cleared the previous corrupt NDK download/setup failure, and that the full
  builder graph still passes afterward: native Android/iOS/desktop runtime
  artifacts, native/WASIX exact-extension artifacts, WASIX portable and AOT
  runtime artifacts, exact-extension package aggregation, mobile
  exact-extension packages, iOS and Android release-mode mobile app builders,
  `artifact-builders`, and `required`.
- [x] GitHub Builds run `27425676382` on `b9320719` completed successfully with
  all 44 job conclusions green after recording the `27420928633` evidence. The
  latest PR-head builder evidence remained fully green for native runtime,
  WASIX runtime/AOT, exact-extension, SDK, mobile app, `artifact-builders`, and
  `required` jobs before the WASIX release version bump below.
- [x] Local release version freshness no longer blocks the selected product
  closure. `tools/release/check_release_versions.py --products-json
  "$(cat target/release-dry-run-local/products.json)" --head-ref HEAD` first
  failed because `liboliphaunt-wasix` and `oliphaunt-wasix-rust` still used
  `0.5.1` while legacy tag `0.5.1` points at the old release commit. The
  follow-up bumps both products to `0.6.0`, updates the WASIX runtime asset/AOT
  crates, pins `oliphaunt-wasix` runtime crate dependencies to `=0.6.0`, refreshes
  root and Tauri example lockfiles, and updates the optional perf-runner
  dependency. Local checks passed after the bump: `tools/release/release.py
  check`, `tools/release/sync-example-lockfiles.py --check`, `cargo metadata
  --locked --format-version 1 --no-deps`, `tools/release/release.py
  check-registries --products-json "$(cat
  target/release-dry-run-local/products.json)" --head-ref HEAD`, and
  `git diff --check`.
- [x] The WASIX Rust publishing surface now uses the WASIX product name instead
  of the generic WASM name. The public Cargo package is `oliphaunt-wasix`, the
  Rust crate/import identifier is `oliphaunt_wasix`, the internal payload crates
  publish as `oliphaunt-wasix-assets` and `oliphaunt-wasix-aot-*`, and CI/release
  artifact paths use `target/oliphaunt-wasix`. Local evidence: hidden-file-aware
  scan for the retired WASM package/import spellings returns no source matches,
  `cargo metadata --locked --format-version 1 --no-deps` resolves the renamed
  packages, `tools/release/release.py check` passes, and
  `tools/release/release.py check-registries --products-json "$(cat
  target/release-dry-run-local/products.json)" --head-ref HEAD` reports
  `crates:oliphaunt-wasix@0.6.0` plus the renamed internal WASIX crates.
- [x] GitHub Builds run `27434296236` on `cf0ef3f2` proved the WASIX rename
  commit still had a stale committed WASIX asset-input fingerprint. The
  `build-liboliphaunt-wasix-runtime` job failed during
  `cargo run -p xtask -- assets verify-committed` with computed fingerprint
  `aed54dc5dbe84544a6627a5fe30d8a7670ea670558e0bc184d57061f8848911e` while
  `src/runtimes/liboliphaunt/wasix/assets/generated/asset-inputs.sha256`
  still held `183cff37e33e3349577c6061a85e9ee96a2e30ee5dfeddc93b0eb7789a1f926a`.
  The follow-up refreshes the committed fingerprint with
  `cargo run -p xtask -- assets input-fingerprint --write`. A replacement
  same-SHA `Builds` run is required because `27434296236` cannot be green
  builder evidence.
- [x] GitHub Builds run `27448574605` on `927457d3` proved the native
  exact-extension source-fetch gap after decoupling artifact packaging from Rust:
  all native extension rows failed before build work because CI runs
  `extension-artifacts-native` with `OLIPHAUNT_MOON_UPSTREAM=none`, so the
  `source-inputs:source-fetch-native-runtime` dependency did not materialize ICU,
  OpenSSL, and extension checkouts. The follow-up makes source checkout
  materialization a Bun-native Git/curl/tar script, removes Cargo/`xtask` inputs
  from source-fetch Moon tasks, wires explicit Bun source fetches into native
  extension/native runtime/WASIX runtime CI jobs, and keeps standalone native
  release helpers on the same source-fetch path. A replacement run on `3ffaaae`
  proved the missing-checkout failure was gone and exposed a Windows Git Bash
  `tar` absolute-drive path issue during libiconv archive extraction; the fetcher
  now passes workspace-relative forward-slash paths to `tar`. The next
  replacement run on `cb43c96` proved that fix and got Windows PostGIS to SQL
  generation, where the producer still treated `uninstall_rtpostgis.sql` as a
  source template; the Windows path now mirrors the PostGIS Makefile by
  preprocessing `rtpostgis.sql` and generating `uninstall_rtpostgis.sql` through
  `utils/create_uninstall.pl`. The `1e88feb` retry got past that point and failed
  later because `extensions/postgis_extension_helper.sql` was not generated; the
  Windows path now preprocesses `postgis_extension_helper.sql.in` before composing
  extension upgrade SQL. The `d3cb9bd` replacement run `27451612217` got past
  the missing helper but failed because the handwritten SQL preprocessor treated
  a commented usage example inside `libpgcommon/sql/AddToSearchPath.sql.inc` as a
  live recursive include; the preprocessor now ignores directives while inside
  block comments and reports explicit include cycles. The `00f268f` replacement
  run `27468133225` proved that fix and all non-Windows native extension rows
  passed, but Windows then failed compiling the bundled PostGIS FlatGeobuf C++
  shim because `liblwgeom.h` includes `proj.h`; the FlatGeobuf compile now uses
  the pinned PROJ include directory and native command log tails are written to
  stderr so follow-up CI failures show the compiler diagnostic directly. The
  `5031bb9` replacement run `27471755925` got past that include gap and failed
  later in `postgis-flatgeobuf-geometrywriter.log` because `geometrywriter.h`
  includes `lwgeom_log.h` before `liblwgeom.h`, so MSVC saw PostGIS'
  GCC-style `__attribute__((format(...)))` declarations before PostGIS'
  compatibility define was visible. The FlatGeobuf compile now force-includes a
  build-local MSVC compatibility header for that bundled C++ shim. The
  `8702131` replacement run `27473015280` proved that compatibility header and
  advanced to `postgis-flatgeobuf-geometryreader.log`, where MSVC then rejected
  GCC's C++ compound-literal extension in `POINT4D` assignments; the Windows
  producer now patches those two checked-out FlatGeobuf assignments to explicit
  `POINT4D.x/y/z/m` field writes before compiling the shim. The `2cb5864`
  replacement run `27473624660` proved the FlatGeobuf static library build
  completed and then failed at Meson setup because the handwritten Windows
  module listed optional `doc/postgis_comments.sql` without generating it; the
  Windows producer now materializes that optional comments SQL before writing the
  Meson module. The `2e42999` replacement run `27474227200` proved that Meson
  setup and all non-Windows native extension rows plus Windows WASIX AOT passed,
  then failed compiling `pg_textsearch` because MSVC saw SQL-callable type
  functions declared without `PGDLLEXPORT` in `types/vector.h` and
  `types/query.h` before their `PG_FUNCTION_INFO_V1` definitions; the Windows
  source patch now gives those declarations the same exported linkage as the
  generated function-info declarations. The `d30dcd7f` replacement run
  `27476719363` proved that `pg_textsearch` compiles and again left only the
  Windows native extension row failing; PostGIS proper then reached Meson
  compilation and failed because its module did not get the FlatGeobuf
  MSVC compatibility shim, so `lwgeom_log.h`/`lwgeom_pg.h` exposed GCC
  `__attribute__` annotations, and because PostGIS has many SQL-callable
  forward declarations without `PGDLLEXPORT`. The Windows PostGIS producer now
  force-includes a small MSVC compatibility header for the Meson module and
  normalizes checked-out PostGIS `Datum ... (PG_FUNCTION_ARGS);` declarations
  to exported linkage before build. The `27fae19b` replacement run
  `27488767029` proved the compatibility header is present in PostGIS compile
  commands and cleared the `__attribute__` failure, while showing that the first
  PowerShell traversal used `Get-ChildItem -Include` in a way that silently did
  not patch declarations on CI; the producer now uses an explicit extension
  filter, a lower no-op count guard, and targeted assertions for the PostGIS
  declarations that MSVC reported with mismatched exported linkage. The
  `cc2e21d` replacement run `27489945425` showed the targeted assertion still
  missed CI's declaration form, so the normalizer now also handles optional
  leading whitespace and existing `extern Datum` declarations. `d7ab3ce` run
  `27490693556` showed Windows still missed the declaration after checkout, so
  the normalizer also tolerates CRLF line endings and optional space before
  `PG_FUNCTION_ARGS`. `f00624a` run `27491174973` got past the source-patch
  assertions and reached PostGIS MSVC compilation, then failed on
  `FALLTHROUGH` expanding to `[[fallthrough]]` in C mode; the forced Windows
  compatibility header now maps `FALLTHROUGH` to `((void)0)` under MSVC.
  `e263edb` run `27491847193` reached later PostGIS compilation and failed on
  the `POSTGIS_DEPRECATE` macro's generated legacy declarations; the Windows
  patch now exports that macro's generated declarations as well. `b94e3f7` run
  `27492582908` then reached deeper `liblwgeom` compilation and failed to
  resolve `ryu/ryu.h`; the Windows PostGIS include roots now include
  `deps/`. `68ab0c3` run `27493306145` reached `liblwgeom/topo` compilation
  and showed that the single Meson target's include order let the server-side
  `postgis/lwgeom_geos.h` shadow `liblwgeom/lwgeom_geos.h`, which pulled
  `fmgr.h` into topology sources without PostgreSQL's core prelude. The
  Windows PostGIS include roots now put `liblwgeom` before `postgis`; source
  files under `postgis/` still resolve their source-local headers first, while
  `liblwgeom/topo` fallback includes resolve to liblwgeom headers. `0b124b9`
  run `27494545976` then compiled all `postgis-3` objects and failed at final
  link because PROJ 9.8's `proj.h` emitted `dllimport` references while the
  producer links pinned static PROJ, and because MSVC lacks POSIX
  `strcasecmp`/`strncasecmp`. `74f403f` run `27495281356` proved the string
  aliases but still linked against `__imp_proj_*`, showing that `PROJ_STATIC`
  is not the PROJ 9.8 export-control macro. The Windows PostGIS and FlatGeobuf
  compatibility headers now define `PROJ_DLL` empty before `proj.h` is
  included, and the PostGIS compatibility header maps those case-insensitive
  string calls to MSVC's `_stricmp`/`_strnicmp`. Local evidence passed:
  `bun tools/policy/fetch-sources.mjs native-runtime --force`,
  `bun tools/policy/fetch-sources.mjs wasix-runtime --force`,
  `node tools/policy/check-moon-product-graph.mjs`,
  `bash tools/policy/check-tooling-stack.sh`,
  `bash tools/policy/check-repo-structure.sh`, Bash syntax checks for touched
  shell scripts, direct execution of the embedded PostGIS SQL preprocessor
  against `postgis_extension_helper.sql.in`, a focused PostGIS Windows source
  patch anchor check, PowerShell tokenization for the touched Windows packager,
  and `git diff --check`.
- [ ] Mobile E2E workflow green on PR/main for selected Android/iOS app
  artifacts from the same successful `Builds` SHA. Current blocker: GitHub
  cannot dispatch `.github/workflows/mobile-e2e.yml` from this PR because the
  new workflow file is not registered on the default branch yet; direct
  `gh workflow run .github/workflows/mobile-e2e.yml --ref
  f0rr0/oliphaunt-release-ready -f
  sha=b93207193561ba4a68ba61b14e42b9ad53157e2f -f platform=all` returns
  `HTTP 404: workflow ... not found on the default branch`.
- [ ] Release workflow dry-run green for selected products. Current local
  blocker after the WASIX `0.6.0` bump is registry identity bootstrap, not
  version freshness: `tools/release/release.py check-registries --products-json
  "$(cat target/release-dry-run-local/products.json)" --head-ref HEAD
  --require-identities` fails because first-public-release package identities
  are still missing for crates.io, Maven Central, npm, and JSR packages,
  including `crates:oliphaunt-wasix` and the internal `oliphaunt-wasix-*`
  crates. The
  release setup guide documents this as expected pre-bootstrap state; hosted
  `publish-dry-run` also enforces this preflight. A future release dry-run will
  also need a same-SHA green `Builds` run for the latest WASIX release/rename
  commit.
- [x] Consumer-shape validation for the full selected product closure is green.
  The checker now treats `oliphaunt-node-direct` as a consumer-facing helper
  product: the private root source package stays unpublishable, optional
  platform npm packages publish with provenance and OS/CPU/libc constraints,
  release metadata declares exactly those optional packages, and the TypeScript
  SDK can keep selecting Node direct by exact optional platform packages.
  Evidence: `tools/release/release.py consumer-shape --require-ready --product
  oliphaunt-node-direct` and `tools/release/release.py consumer-shape
  --require-ready --products-json "$(cat
  target/release-dry-run-local/products.json)"` pass.
- [~] Windows native exact-extension coverage has a producer path for all nine
  previous Windows gaps. The Windows build script now generates Meson
  producers inside the patched PostgreSQL source tree for `pg_hashids`,
  `pg_ivm`, `pg_textsearch`, `pg_uuidv7`, `vector`, `pgcrypto`, and
  `uuid-ossp`, builds pinned static OpenSSL for `pgcrypto`, links the
  first-party portable UUID source into `uuid-ossp`, and stages pgTAP's
  generated SQL/control files without a native module. It also builds a Windows
  PostGIS producer that compiles pinned static GEOS, PROJ, SQLite, json-c, and
  libxml2 dependencies, links `postgis-3`, and stages PostGIS SQL/data plus
  `proj/proj.db`. Target metadata now publishes those nine rows on
  `windows-x64-msvc`, so the native exact-extension matrix reports 39 Windows
  products. Local evidence after this patch passed:
  `python3 src/extensions/tools/check-extension-model.py --write-evidence`,
  `python3 src/extensions/tools/check-extension-model.py --check`,
  `python3 tools/release/release.py check`,
  `python3 tools/release/artifact_target_matrix.py extension-artifacts-native`,
  and `git diff --check`. Remaining work: get GitHub Windows runner proof for
  the expanded MSVC producers.
- [x] GitHub required aggregate green.

## Immediate Next Work

1. Get hosted Mobile E2E evidence once `.github/workflows/mobile-e2e.yml` is
   available on the default branch or another approved same-SHA dispatch path
   exists. Preserve the architecture invariant: installed-app E2E must consume
   same-SHA `Builds` app artifacts and must not rebuild runtimes, SDKs, or
   extension packages.
2. Run a release dry-run after release tags/artifacts are available for the
   selected product closure and after first-public-release registry identities
   are bootstrapped. The strict identity gate is currently expected to fail for
   new crates.io, Maven Central, npm, and JSR package coordinates.
3. Get a same-SHA green `Builds` run for the latest WASIX release/rename
   commit; previous green builder evidence predates that commit and cannot
   satisfy the release workflow's same-SHA artifact gate.
4. Get Windows `extension-artifacts-native` CI evidence for the new 39-product
   Windows row, including the PostGIS dependency and module producer.
