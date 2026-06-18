# Maintainer Development Guide

This page is maintainer documentation for repository validation, generated
artifacts, and local release workflows. It is not end-user product
documentation.

Run the local gates before opening a PR:

```sh
moon run dev-tools:doctor
tools/dev/bootstrap-tools.sh
moon run :check && moon run :test
moon run ci-workflows:check
tools/policy/check-supply-chain.sh
```

Tool versions for Moon, Node, pnpm, Bun, and Deno are pinned in `.prototools`.
Bun is required for the TypeScript SDK checks because `@oliphaunt/ts` supports
Bun through the npm artifact; local checks use `tools/dev/bun.sh` when the shell
does not already provide the pinned Bun. Deno is optional for normal local checks
and uses `tools/dev/deno.sh` on demand for JSR package validation.

Tool choices and rejected alternatives are recorded in
[tooling.md](tooling.md). Update that decision record before adding a new
repo-wide tool or hand-rolled release helper.

Moon is the product graph and affected-task entrypoint. A fresh checkout should
install the pinned proto/Moon toolchain from `.prototools`, then call Moon
directly:

```sh
moon query projects
moon query affected --upstream none --downstream deep
moon run :coverage --affected
```

Use `moon query affected` to inspect affectedness and `moon run <target>` for
explicit local targets. GitHub CI executes the exact planned target list with
Moon so jobs do not expand into unrelated downstream work. Normal commands use
Moon's own concurrency instead of a forced single-worker debug mode.

The validation entrypoint is split by maintainer workflow:

- `moon run liboliphaunt-native:host-smoke`: no-build host C ABI/runtime smoke for the
  current native target. It compiles and runs the consumer-style ABI harness and
  the full C smoke against the release-runtime artifact for macOS, Linux, or
  Windows. `OLIPHAUNT_TRACK_BUILD=never` makes missing or stale artifacts fail
  immediately instead of entering any build path;
- `moon run liboliphaunt-native:release-check`: extension-enabled native product
  track. It runs the C smoke, Rust native runtime regression, and gated native
  extension matrix while reusing existing native artifacts whenever their
  fingerprints are current. Peer SDK release checks stay as first-class Moon
  product tasks instead of being hidden inside this aggregate;
- `moon run repo:check`: file hygiene and formatting;
- `tools/policy/check-wasm-artifacts.sh`: source-controlled asset input verification
  plus AOT crate template checks;
- `tools/policy/check-rust-lint.sh`: dependency invariants and clippy;
- `tools/policy/check-rust-test-topology.sh`: fast policy check proving Rust
  doctests and executable tests are owned by product Moon tasks instead of a
  broad root Cargo wrapper;
- `moon run ci-workflows:check`: local `actionlint` and `zizmor` checks using
  the same zizmor config and severity/persona as CI. `actionlint` covers
  workflow syntax, expression, and shell wiring; `zizmor` covers workflow
  security findings. Keep both, but do not add another workflow linter unless
  it replaces one of these responsibilities;
- `moon run liboliphaunt-wasix:smoke`: hard-requires portable assets plus host AOT,
  installs them into ignored paths, and runs the real runtime tests;
- `moon run liboliphaunt-wasix:smoke`: the runtime smoke subset;
- `moon run integration-examples:check`: Tauri/Rust/frontend example checks;
- `moon run liboliphaunt-native:smoke`: native-only C ABI smoke and
  Rust native SDK tests. This delegates to the same fast product-track harness
  as `oliphaunt-track quick`, so it reuses `target/liboliphaunt-pg18` by default
  and only builds missing artifacts. Set `OLIPHAUNT_TRACK_BUILD=never` to prove
  the command will not rebuild, `missing` to build absent artifacts, or `always`
  for a deliberate rebuild. Set `OLIPHAUNT_VALIDATE_EXTENSIONS=1` to switch the
  command to the gated extension matrix. The native dylib is stamped and reused
  unless edited C ABI sources, PostgreSQL embedded object inputs, compiler, or
  patch/build inputs change; set `OLIPHAUNT_FORCE_RELINK=1` for a deliberate
  relink. Extension artifact builds are separately fingerprinted and reused
  across runs unless native C ABI, PostgreSQL patch/build, compiler, or
  extension source inputs change. Set `OLIPHAUNT_FORCE_EXTENSION_REBUILD=1` for
  a deliberate clean extension rebuild;
- `src/runtimes/liboliphaunt/native/tools/check-track.sh [host-smoke|quick|rust|extensions|sdks|external-pgrx|full]`:
  native-only liboliphaunt product validation. This is the preferred iteration lane
  for the new product track because it avoids the WASIX release lane, exports the
  local `target/liboliphaunt-pg18` runtime for Rust/Swift/Kotlin/RN tests, and only
  runs `src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh` when native artifacts are
  missing. Extension/full modes first call the build script's no-build
  `--check-extension-artifacts-current` freshness probe; they only enter the
  normal build path when the stamped extension fingerprint or required artifacts
  are stale or absent. The readiness check consumes
  `src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh --print-required-extension-artifacts`,
  so it validates the complete artifact inventory used by the build instead of a
  sample subset. Set
  `OLIPHAUNT_TRACK_BUILD=never` to fail immediately instead of building,
  `missing` to build only absent or stale required artifacts, or `always` for a
  deliberate rebuild;
- `tools/perf/check-native-perf-harness.sh`: fast no-build guard
  proving the native perf script plans direct/broker/server/native-PostgreSQL
  work with explicit `perf-runner support, not the legacy WASIX lane;
- `moon run oliphaunt-rust:check`: Rust SDK tests and SDK shape checks for
  `oliphaunt`, the Tauri/Rust desktop SDK. This command reuses an
  existing `target/liboliphaunt-pg18` runtime only when the matching
  liboliphaunt dylib, PostgreSQL tools, normal extension files, and embedded
  extension modules are all present. That keeps env-gated native SQL and
  opt-in extension tests from running against a partial native runtime;
- `tools/policy/check-sdk-parity.sh`: fast ownership guard that checks Rust,
  Swift, Kotlin, and React Native docs/package boundaries stay aligned;
- `moon run oliphaunt-swift:check`: SwiftPM tests plus an iOS simulator
  build when Xcode is available;
- `moon run oliphaunt-swift:smoke`: fast PostgreSQL 18 iOS
  simulator compile probe for the embedded patch touchpoints. It reuses a
  stamped cross-configured source tree and compiles only the backend objects
  that carry liboliphaunt host I/O, lifecycle, static-extension, and mobile shell
  command changes;
- `moon run oliphaunt-swift:package`: validates the Swift source package
  shape without building platform release artifacts;
- `moon run liboliphaunt-native:build-ios-xcframework`: explicitly builds and
  freshness-checks iOS simulator and device `liboliphaunt.dylib` slices from
  the same PostgreSQL 18 patch stack, then packages them as
  `liboliphaunt.xcframework`;
- `moon run oliphaunt-kotlin:smoke`: builds and
  freshness-checks the Android arm64 `liboliphaunt.so` artifact used by the
  Android SDK and React Native smoke lane;
- `moon run oliphaunt-kotlin:check`: Kotlin Multiplatform checks,
  including native cinterop tests on the host platform;
- `moon run oliphaunt-react-native:smoke-android`: Android React Native
  installed-app harness over the Expo development-client sample;
- `moon run oliphaunt-react-native:smoke-ios`: iOS React Native
  installed-app harness over the Expo development-client sample;
- `moon run oliphaunt-react-native:check`: React Native TypeScript,
  Codegen, packaging, and native source checks;
- `moon run oliphaunt-react-native:smoke-mobile`: aggregate local Expo
  development-client installed-app lane. It runs both platform-specific smokes
  against the packed SDK and real native artifacts;
- `pnpm --dir src/sdks/react-native/examples/expo run smoke:android`: real Android Expo
  development-client smoke for the installed React Native package. It reuses
  current native artifacts, generates the ignored Expo `android/` project only
  when missing, packages `liboliphaunt.so` plus runtime/template resources, starts
  Metro when needed, installs the app, and waits for
  `OLIPHAUNT_EXPO_SMOKE_PASS`;
- `pnpm --dir src/sdks/react-native/examples/expo run smoke:ios`: real iOS Expo
  development-client build/smoke harness for the installed React Native package.
  For simulator builds it produces or reuses the current iOS simulator
  `liboliphaunt.dylib` automatically when no explicit artifact override is set,
  packages the same runtime/template resources, patches only the ignored
  generated `ios/` Podfile for local Swift pods, rejects macOS dylibs, and can
  run in `OLIPHAUNT_EXPO_IOS_BUILD_ONLY=1` mode when CoreSimulator is
  unavailable;
- `tools/policy/check-crate-package.sh`: package all published crates and enforce
  crates.io size limits;
- `tools/policy/check-feature-powerset.sh`: cargo-hack feature combination checks;
- `tools/policy/check-semver.sh`: cargo-semver-checks public API compatibility;
- `tools/policy/check-supply-chain.sh`: cargo-deny dependency policy checks;
- `moon run :check && moon run :test && moon run :package && moon run :coverage`: default PR parity lane;
- `moon run :check && moon run :test && moon run :smoke`: fast contributor lane for repo, lint, source
  tests, and examples;
- `moon run :regression`: broader SQL, protocol, extension, and runtime regression suites;
- `tools/release/release.py publish-dry-run --wasm`: release-workspace package checks plus publish
  dry-runs for internal crates after CI-generated AOT artifacts have been
  downloaded.

Moon caches deterministic task results when their declared source inputs and
task dependencies have not changed. Local `:smoke` targets use `cache: local`,
so repeated `moon run :smoke` runs can return a cached result for the same source
graph. Use `moon run <product>:smoke --cache off` when you need a live
device, simulator, or runtime probe regardless of the cache. Generated report
aggregates, such as `repo:coverage`, depend on upstream task outputs with Moon
2.3 `cacheStrategy: outputs`, so downstream cache invalidation follows the
artifact contract instead of every private upstream source edit.

Kotlin and React Native Android SDK validation uses Gradle's configuration
cache by default so repeated local runs do not reconfigure the same Android/KMP
graphs. Set `OLIPHAUNT_GRADLE_CONFIGURATION_CACHE=0` only when diagnosing
Gradle configuration-cache behavior itself.

The hook split is intentionally small:

- pre-commit: file hygiene and formatting
- release readiness: `tools/policy/check-rust-lint.sh`,
  `tools/policy/check-rust-test-topology.sh`, and
  `tools/policy/check-wasm-artifacts.sh`
- CI/release: path-aware combinations of the same validation modes, workflow
  linting, feature powerset, public API compatibility, crate packaging,
  native AOT runtime tests, Cargo publish dry-runs, and supply-chain
  policy

Install local hooks and pinned CLI tools when needed. The bootstrap installs
`cargo-binstall` first and uses binary installs for Rust tools before falling
back to source builds.

```sh
tools/dev/bootstrap-tools.sh
tools/dev/install-hooks.sh
```

`src/bindings/wasix-rust/crates/oliphaunt-wasix/tests/runtime_smoke.rs` starts the real WASM backend and
is intentionally slower than the protocol unit tests.

## Maintenance Utilities

The repository includes maintenance commands:

- `oliphaunt-wasix-dump` is the logical dump CLI entry point.
- `oliphaunt-wasix-proxy` exposes a local PostgreSQL socket backed by the embedded
  runtime.
- `xtask assets template` generates the architecture-independent PGDATA
  template from the split WASIX `initdb` module. Portable WASIX, PGDATA
  templates, and native AOT payloads remain generated-only.

Asset and source checks:

```sh
cargo run -p xtask -- assets verify-committed
cargo run -p xtask -- assets fetch
cargo run -p xtask -- assets check --strict-local
cargo run -p xtask -- assets check --strict-generated
cargo run -p xtask --features template-runner -- assets template
cargo run -p xtask -- assets source-spine --check-patch-applies
cargo run -p xtask -- assets audit-upstream --strict
cargo run -p xtask -- assets input-fingerprint --write
cargo run -p xtask -- package-size --enforce
```

## Local Runtime Development

Local development has three supported modes.

Fast contributor mode does not require Docker, upstream source checkouts, or
generated native AOT payloads. Use it for ordinary Rust, docs, tests, examples,
and workflow edits:

```sh
moon run :check && moon run :test && moon run :smoke
cargo check --workspace --all-targets
cargo test --workspace --no-default-features
```

For the shortest source-only path, use:

```sh
moon run :check && moon run :test
```

For native liboliphaunt work, prefer the native-only track. It keeps the C ABI,
Rust SDK, Swift/Kotlin/React Native SDK package lanes, extension matrix, and
local runtime smoke tests separated from the legacy WASIX release machinery:

```sh
moon run liboliphaunt-native:host-smoke
src/runtimes/liboliphaunt/native/tools/check-track.sh quick
src/runtimes/liboliphaunt/native/tools/check-track.sh sdks
src/runtimes/liboliphaunt/native/tools/check-track.sh full
```

`native-dev` is the normal inner loop for native code and docs: it uses the
Rust-only native validation lane, verifies SDK ownership/parity, and checks
whitespace without compiling the legacy product lane. `native-dev-no-build`
uses the same checks with `OLIPHAUNT_TRACK_BUILD=never`; use it when the local
runtime should already exist and an unexpected rebuild would hide iteration
cost. `quick` adds the C smoke:
it reuses `target/liboliphaunt-pg18` when present, runs the C smoke, and runs the
Rust native SDK tests. `rust` skips the C smoke but still exports or creates the
native runtime before Rust env-gated tests, so it is the faster Rust-only native
validation lane. `moon run oliphaunt-rust:regression` uses the basic native
runtime and runs SQL/protocol regression across direct, broker, and server mode.
`moon run oliphaunt-rust:extension-regression` is the separate
extension-artifact lane; it depends on `liboliphaunt-native:release-check` and is
intentionally not part of normal PR CI. `extensions` and `full` use the build
script's no-build extension freshness probe before running the matrix, which avoids both
unnecessary rebuilds and the failure mode where a core-only runtime is
accidentally treated as extension ready. `sdks` validates SDK ownership/parity,
then runs the Rust, Swift, Kotlin, and React Native package checks. See
[`docs/maintainers/sdk-parity-policy.md`](../../docs/maintainers/sdk-parity-policy.md) for the SDK ownership contract. `full` enables
native extension artifacts and the extension matrix in addition to the SDK
checks. Use
`OLIPHAUNT_TRACK_BUILD=never` when you want to prove the harness is not
rebuilding anything.

Host-platform artifact mode is for runtime work on the current machine. It
builds or packages only the current host target, leaves all generated payloads
in ignored paths, and then runs the real runtime tests:

```sh
host="$(rustc -vV | awk '/^host:/{print $2}')"
cargo run -p xtask -- assets fetch
cargo run -p xtask --features aot-serializer -- assets build-host
moon run liboliphaunt-wasix:smoke
```

Local AOT generation requires the Wasmer LLVM 22.1.x build for the
maintainer-only serializer. That build includes the LLVM target set Wasmer's
LLVM backend expects, including LoongArch and WebAssembly. Set
`LLVM_SYS_221_PREFIX` to an extracted
`wasmerio/llvm-custom-builds` 22.x archive, or use downloaded-artifact mode to
avoid local LLVM setup.

When the portable WASIX assets are already current and only the host AOT crate
needs to be refreshed, skip the source/Docker build and generate host AOT from
the existing generated portable assets:

```sh
host="$(rustc -vV | awk '/^host:/{print $2}')"
cargo run -p xtask -- assets aot --target-triple "$host"
cargo run -p xtask -- assets package-aot --target-triple "$host"
moon run liboliphaunt-wasix:smoke
```

Downloaded-artifact mode is the intended way to test a CI-produced runtime
locally without rebuilding Postgres/WASIX. Download the successful `Checks`
workflow runtime artifacts for the exact commit and install the host target
payloads into the same ignored generated locations used by the local build path:

```sh
host="$(rustc -vV | awk '/^host:/{print $2}')"
cargo run -p xtask -- assets download --sha <sha> --target-triple "$host"
moon run liboliphaunt-wasix:smoke
```

For Rust-only work where the asset inputs have not changed, the same command
can install the latest compatible `main` bundle after verifying the
asset-input fingerprint:

```sh
host="$(rustc -vV | awk '/^host:/{print $2}')"
cargo run -p xtask -- assets download --latest-compatible --target-triple "$host"
moon run liboliphaunt-wasix:smoke
```

Released artifact bundles can be installed without the GitHub CLI because they
are public GitHub release assets:

```sh
host="$(rustc -vV | awk '/^host:/{print $2}')"
cargo run -p xtask -- assets download --release <tag> --target-triple "$host"
moon run liboliphaunt-wasix:smoke
```

Release validation can download every supported target from the exact `Checks`
workflow SHA:

```sh
cargo run -p xtask -- assets download --sha <sha> --all-targets
tools/release/release.py publish-dry-run --wasm
```

Developers should not be expected to build every target locally. Local runtime
work validates the host target; the `Checks` workflow's WASM runtime/AOT lane is
the authority for the full macOS, Linux, and Windows AOT matrix.

Contributors do not need upstream source checkouts for normal Rust, docs,
examples, or package validation. Maintainers fetch sources only when rebuilding
the portable WASIX runtime, extensions, `initdb`, `pg_dump`, or the generated
PGDATA template. Portable WASIX artifacts, generated PGDATA templates, and
native AOT artifacts are generated under `target/oliphaunt-wasix/**` locally or by
CI; they are not committed to git.

Rust-only PRs download the latest compatible `Checks` workflow bundle, verify its
asset-input fingerprint, install it into ignored generated paths, and run the
runtime test suite on every supported host target. The `Checks` pull-request
job uses Moon affectedness over `postgres18`, `third-party`,
`source-toolchains`, `extensions`, and `oliphaunt-wasix:release-check`, plus a small producer path
allowlist, to decide whether the expensive asset build is required. Non-asset
PRs become an explicit no-op after source-controlled input checks.
Asset-producing PRs verify source pins, the committed asset-input fingerprint,
extension catalog metadata, generated metadata policy, and then run the full
portable/AOT producer workflow before merge. `main`, scheduled runs, and
explicit maintainer dispatches remain trusted producer lanes for release
artifacts.

Release process details are tracked in [release.md](release.md).
Maintainer-only progress notes live under `docs/internal/`; completed
implementation work is summarized in [DONE.md](../internal/DONE.md), and the
implementation backlog is tracked in [TODO.md](../internal/TODO.md).
