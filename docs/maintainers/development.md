# Maintainer Development Guide

Status: normative local-development guide. Last verified: 2026-09-03. Owner: repository maintainers.

This page is maintainer documentation for repository validation, generated
artifacts, and local release metadata checks. It is not end-user product
documentation.

Bootstrap the pinned local toolchain once:

```sh
moon run dev-tools:doctor
tools/dev/bootstrap-tools.sh
```

For each change, follow `.codex/skills/qualify-oliphaunt-change/SKILL.md`:
inspect Moon affectedness, run focused checks first, and expand only when the
changed contract requires it. A normal affected source feedback pass is:

```sh
moon query affected --upstream none --downstream direct
moon run :check :compile :format-check :js-format-check :rust-format-check :lint :tools-compile --affected
moon run :test :unit :tools-unit --affected
```

Run `moon run ci-workflows:check` for workflow changes and
`tools/dev/bun.sh tools/policy/check-supply-chain.mjs` for dependency or
supply-chain policy changes; neither is an unconditional pre-PR ceremony.

Tool versions for Moon, Node, pnpm, Bun, and Deno are pinned in `.prototools`.
Bun is required for the TypeScript SDK checks because `@oliphaunt/ts` supports
Bun through the npm artifact; local checks use `tools/dev/bun.sh` when the shell
does not already provide the pinned Bun. Deno is optional for normal local checks
and uses `tools/dev/deno.sh` on demand for Deno npm-package validation.

Windows native builds obtain WinFlexBison from the exact upstream archive pinned
in `src/sources/toolchains/winflexbison.toml`. The shared native setup verifies
the archive size and digest, safe ZIP layout, complete extracted-tree digest,
and both executable digests before adding the atomic cache payload to `PATH`.
Do not replace this path with a live Chocolatey lookup; Chocolatey is retained
only for Strawberry Perl when the hosted image does not already provide it, and
that fallback must prove the expected executable after every install attempt.

Tool choices and rejected alternatives are recorded in
[tooling.md](tooling.md). Update that decision record before adding a new
repo-wide tool or hand-rolled release helper.

Moon is the product graph and affected-task entrypoint. A fresh checkout should
install the pinned proto/Moon toolchain from `.prototools`, then call Moon
directly:

```sh
moon query projects
moon query affected --upstream none --downstream direct
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
- `moon run liboliphaunt-native:host-smoke`: release-shaped, no-build host
  C ABI/runtime smoke. It depends on the native release-runtime producer and
  refuses any implicit rebuild inside the smoke;
- `moon run repo:check`: file hygiene and formatting;
- `moon run liboliphaunt-wasix:assets-verify`: source-controlled asset input verification
  plus AOT crate template checks;
- `tools/dev/bun.sh tools/policy/check-rust-lint.mjs`: dependency invariants
  and clippy;
- `moon run ci-workflows:check`: workflow syntax and security checks plus the
  behavior tests for helpers invoked by Actions;
- `moon run liboliphaunt-wasix:smoke`: hard-requires portable assets plus host AOT,
  installs them into ignored paths, and runs the real runtime tests;
- `moon run liboliphaunt-wasix:runtime-portable oliphaunt-wasix-ts:package`, then
  `node tools/integration/wasix-ts/smoke-browser.mjs`: local browser proof. It serves
  COOP/COEP headers and requires Chrome/Chromium to exercise `pgtap`, recover two
  PostgreSQL error paths, return `42`, and exit cleanly. Add `--pg-uuidv7` for the
  private native-module canary;
- `moon run integration-examples:check`: Tauri/Rust/frontend example checks;
- `moon run liboliphaunt-native:lint liboliphaunt-native:unit`: cached native
  patch-stack and source-level tests without building a runtime;
- `moon run oliphaunt-rust:regression`: native direct, broker, and server
  behavior against the current host runtime. Extension behavior remains the
  separate `oliphaunt-rust:extension-regression` lane;
- `moon run perf-tools:native-plan`: validates the native benchmark plan without
  building or measuring a runtime;
- `pnpm --dir tools/perf/wasix-node bench:streaming`: quick local WASIX
  TypeScript transport benchmark. It reuses staged packages and portable assets,
  compares the root direct and explicit `/worker` contracts, exercises bounded COPY,
  backpressure, event-loop delay, process RSS, the local server, `pg_dump`, and
  `psql`, and prints a readable report (`-- --json` prints the complete JSON).
  Process RSS deltas are descriptive because the quick run reuses one process.
  If inputs are absent, first run
  `moon run oliphaunt-wasix-tools-ts:package liboliphaunt-wasix:runtime-portable`;
- `moon run oliphaunt-rust:compile`: static Cargo checks for `oliphaunt` and
  `oliphaunt-build`. Artifact-relay build-script behavior is owned by `unit`;
  package and native runtime evidence remain separate `package` and `regression`
  targets;
- `moon run oliphaunt-rust:unit`: the hosted-equivalent Rust source-test lane.
  It runs documentation tests, `oliphaunt-build` tests, and all `oliphaunt`
  library, executable, and integration tests. A focused command such as
  `cargo test -p oliphaunt --lib` is useful while iterating, but excludes the
  executable tests under `src/bin/**` and is not qualification evidence;
- `moon run oliphaunt-rust:package`: creates and inspects the publishable Rust
  SDK package only. Run `compile`, `unit`, and `package` together for the compact
  pre-push gate; none silently owns the others;
- `moon run sdk-contracts:check`: fast generated API, SDK registry, C ABI
  header-copy, and native-boundary contract validation. Use
  product `compile`, `unit`, and `package` targets for behavior and package proof;
- `moon run oliphaunt-swift:compile`: SwiftPM package description and build checks
  for the SDK package and repository root package;
- `moon run oliphaunt-swift:smoke`: Swift SDK tests against the current native
  host runtime; on macOS it also requires the iOS simulator preflight;
- `moon run oliphaunt-swift:package`: validates the Swift source package
  shape without building platform release artifacts;
- `moon run liboliphaunt-native:build-ios-xcframework`: explicitly builds and
  freshness-checks iOS simulator and device `liboliphaunt.dylib` slices from
  the same PostgreSQL 18 patch stack, then packages them as
  `liboliphaunt.xcframework`;
- `moon run oliphaunt-kotlin:smoke`: builds and freshness-checks the selected
  Android ABI's `liboliphaunt.so` artifact, then runs the Android SDK smoke;
- `moon run oliphaunt-kotlin:check`: Kotlin formatting, lint, common/JVM and
  Android compilation, and Android-only Maven publication-shape checks. Unit
  tests remain in `oliphaunt-kotlin:unit`;
- `moon run oliphaunt-react-native:smoke-android`: Android React Native
  installed-app harness over the Expo development-client sample;
- `moon run oliphaunt-react-native:smoke-ios`: iOS React Native
  installed-app harness over the Expo development-client sample;
- `moon run oliphaunt-react-native:compile`: React Native TypeScript build and
  typecheck, Codegen, and native source-contract checks. Package-shape work is
  owned by `oliphaunt-react-native:package`;
- `moon run oliphaunt-react-native:smoke`: aggregate local Expo
  development-client installed-app lane. It runs both platform-specific smokes
  against the packed SDK and real native artifacts;
- `pnpm --dir examples/react-native-expo run smoke:android`: real Android Expo
  development-client smoke for the installed React Native package. It reuses
  current native artifacts, generates the ignored Expo `android/` project only
  when missing, packages `liboliphaunt.so` plus runtime/cluster-seed resources, starts
  Metro when needed, installs the app, and waits for
  `OLIPHAUNT_EXPO_SMOKE_PASS`;
- `pnpm --dir examples/react-native-expo run smoke:ios`: real iOS Expo
  development-client build/smoke harness for the installed React Native package.
  For simulator builds it produces or reuses the current iOS simulator
  `liboliphaunt.dylib` automatically when no explicit artifact override is set,
  packages the same runtime/cluster-seed resources, patches only the ignored
  generated `ios/` Podfile for local Swift pods, rejects macOS dylibs, and can
  run in `OLIPHAUNT_EXPO_IOS_BUILD_ONLY=1` mode when CoreSimulator is
  unavailable;
- `tools/policy/check-crate-package.sh`: package all published crates and enforce
  crates.io size limits;
- `tools/dev/bun.sh tools/policy/check-feature-powerset.mjs`: cargo-hack
  feature combination checks;
- `tools/dev/bun.sh tools/policy/check-semver.mjs`: cargo-semver-checks public
  API compatibility;
- `tools/dev/bun.sh tools/policy/check-supply-chain.mjs`: cargo-deny dependency
  policy checks;
- `moon run :check :compile :format-check :js-format-check :rust-format-check :lint :tools-compile && moon run :test :unit :tools-unit && moon run :package && moon run :coverage`:
  explicit full local parity lane, including measured coverage;
- `moon run :check :compile :format-check :js-format-check :rust-format-check :lint :tools-compile && moon run :test :unit :tools-unit && moon run :smoke`: full source/runtime lane for repo, lint, source
  tests, and examples;
- `moon run :regression`: broader SQL, protocol, extension, and runtime regression suites;
- `moon run release-tools:check`: the canonical full local release-policy gate.
  The direct equivalent is
  `tools/dev/bun.sh tools/release/release-check.mjs`. This release-owned
  metadata and mutation gate does not replace affected product `compile`, `unit`,
  or `package` tasks;
- `tools/dev/bun.sh tools/release/release-metadata-check.mjs`: internal
  protected-workflow replay after a generated release commit has passed its
  structured verifier or after the exact hosted `Qualified` record has been
  reverified against a clean checkout. It is not a replacement for the full
  local gate. Candidate artifact dry-runs run only through the protected GitHub
  `Release` workflow after exact-SHA qualification.

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
- release readiness: `tools/dev/bun.sh tools/policy/check-rust-lint.mjs` and
  `moon run liboliphaunt-wasix:assets-verify`
- CI/release: path-aware combinations of the same validation modes, workflow
  linting, feature powerset, public API compatibility, crate packaging,
  native AOT runtime tests, frozen Cargo publication dry-runs, and supply-chain
  policy

Install local hooks and pinned CLI tools when needed. Maintainer bootstrap
release assets are an explicit source contract in
`src/sources/toolchains/maintainer-tools.toml`: every supported Linux and macOS
host has an exact URL, archive SHA-256, extracted-binary SHA-256, archive
layout, and size bound. The installer accepts only bounded HTTPS downloads,
checks the complete archive before extraction, rejects unexpected or non-file
members, and promotes a staged binary and its identity marker atomically. A
matching version string alone is not a cache hit.

`cargo-binstall` may fall back only after a transport failure or an unsupported
binary host. That fallback is an isolated, exact-version `cargo install
--locked` build and is promoted through the same rollback-safe path; it never
reuses a partial download. `actionlint` has no source fallback because the
repository does not pin a Go toolchain. Update the manifest and the fault tests
together when either maintainer tool is upgraded.

```sh
tools/dev/bootstrap-tools.sh
tools/dev/bun.sh tools/dev/install-hooks.mjs
```

`src/bindings/wasix-rust/crates/oliphaunt-wasix/tests/runtime_smoke.rs` starts the real WASIX backend and
is intentionally slower than the protocol unit tests.

## Maintenance Utilities

The repository includes maintenance commands:

- `oliphaunt-wasix-dump` is the logical dump CLI entry point. Its typed
  `--database`, `--username`, and repeatable `--extension` options configure
  the embedded server; arguments after `--` shape `pg_dump` output.
- `oliphaunt-wasix-proxy` exposes a local PostgreSQL socket backed by the embedded
  runtime.
- `xtask assets cluster-seeds` generates the architecture-independent PGDATA
  seeds from the split WASIX `initdb` module. Portable WASIX, cluster seeds,
  and native AOT payloads remain generated-only.

Asset and source checks:

```sh
cargo run -p xtask -- assets verify-committed
cargo run -p xtask -- assets fetch
cargo run -p xtask -- assets check --strict-local
cargo run -p xtask -- assets check --strict-generated
cargo run -p xtask --features cluster-seed-runner -- assets cluster-seeds
cargo run -p xtask -- assets source-spine --check-patch-applies
cargo run -p xtask -- assets audit-upstream --strict
moon run repo:package
```

## Local Runtime Development

Local development has three supported modes.

Fast contributor mode does not require Docker, upstream source checkouts, or
generated native AOT payloads. Use it for ordinary Rust, docs, tests, examples,
and workflow edits:

```sh
moon run :check :compile :format-check :js-format-check :rust-format-check :lint :tools-compile --affected && moon run :test :unit :tools-unit --affected
```

For native liboliphaunt work, run only the product boundary you changed:

```sh
moon run liboliphaunt-native:host-smoke
moon run oliphaunt-rust:regression
moon run extension-artifacts-native:build-host oliphaunt-rust:extension-regression
```

`liboliphaunt-native:host-smoke` proves the C ABI. The Rust regression uses the basic native
runtime and runs SQL/protocol regression across direct, broker, and server mode.
`moon run oliphaunt-rust:extension-regression` is the separate
extension-artifact lane; it depends on `extension-artifacts-native:build-host` and is
intentionally not part of normal PR CI. The host artifact builder uses
the build script's no-build freshness probe before running the matrix, which avoids both
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
locally without rebuilding Postgres/WASIX. Select either the exact successful
`CI` workflow run or the full 40-character commit SHA and install the host
target payloads into the same ignored generated locations used by the local
build path:

```sh
host="$(rustc -vV | awk '/^host:/{print $2}')"
cargo run -p xtask -- assets download --run-id <id> --target-triple "$host"
# Or select the successful CI run for one exact commit:
cargo run -p xtask -- assets download --sha <full-40-character-sha> --target-triple "$host"
moon run liboliphaunt-wasix:smoke
```

Workflow-run downloads require the authenticated GitHub CLI. The downloader
accepts only the requested run or exact SHA and validates the packaged runtime
and AOT manifests and checksums before installation.

Released artifact bundles can be installed without the GitHub CLI because they
are public GitHub release assets:

```sh
host="$(rustc -vV | awk '/^host:/{print $2}')"
cargo run -p xtask -- assets download --release <tag> --target-triple "$host"
moon run liboliphaunt-wasix:smoke
```

Release downloads validate the published checksum manifest, archive checksums,
and packaged runtime/AOT manifests before installation.

Release validation can download every supported target from the exact `CI`
workflow SHA:

```sh
cargo run -p xtask -- assets download --sha <full-40-character-sha> --all-targets
tools/dev/bun.sh tools/release/release-check.mjs
```

Developers should not be expected to build every target locally. Local runtime
work validates the host target; the `CI` workflow's WASIX runtime/AOT lane is
the authority for the full macOS, Linux, and Windows AOT matrix.

Contributors do not need upstream source checkouts for normal Rust, docs,
examples, or package validation. Maintainers fetch sources only when rebuilding
the portable WASIX runtime, extensions, `initdb`, `pg_dump`, `psql`, or the generated
cluster seed. Portable WASIX artifacts, generated cluster seeds, and
native AOT artifacts are generated under `target/oliphaunt-wasix/**` locally or by
CI; they are not committed to git.

The `CI` pull-request job uses Moon affectedness over `postgres18`, `third-party`,
`source-toolchains`, `extensions`, and the WASIX artifact inputs, plus a small producer path
allowlist, to decide whether the expensive asset build is required. Non-asset
PRs become an explicit no-op after source-controlled input checks.
Asset-producing PRs verify source pins, extension catalog metadata, generated
metadata policy, and then run the full portable/AOT producer workflow before
merge. `main` and explicit maintainer dispatches remain trusted producer lanes
for release artifacts.

Release process details are tracked in [release.md](release.md). Historical
progress notes under `docs/internal/` are archived and non-normative; they are
not the current backlog or release checklist.
