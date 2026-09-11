# Maintainer Development Guide

Status: normative local-development guide. Last verified: 2026-09-03. Owner: repository maintainers.

This page is maintainer documentation for repository validation, generated
artifacts, and local release metadata checks. It is not end-user product
documentation.

Bootstrap the pinned local toolchain once:

```sh
tools/dev/bootstrap-tools.sh
```

This installs Prek, cargo-nextest, Actionlint, and Zizmor. Use
`tools/dev/bootstrap-tools.sh --workflows` when only the workflow validators are
needed. Optional tools such as cargo-deny, cargo-hack, and cargo-semver-checks can
be installed with Cargo when their checks are needed.

For each change, follow `.codex/skills/qualify-oliphaunt-change/SKILL.md`:
inspect Moon affectedness, run focused checks first, and expand only when the
changed contract requires it. Inspect affectedness, then run explicit owner
checks. For example, for the native Rust SDK:

```sh
moon query affected --upstream none --downstream deep
moon run oliphaunt-rust:format-check oliphaunt-rust:lint oliphaunt-rust:test
```

Run `moon run ci-workflows:check` for workflow changes and
`cargo deny check` for dependency or
supply-chain policy changes; neither is an unconditional pre-PR ceremony.

Tool versions for Moon, Node, Bun, and Deno are pinned in `.prototools`.
Bun is required for the TypeScript SDK checks because `@oliphaunt/ts` supports
Bun through the npm artifact; local checks use `tools/dev/bun.sh` when the shell
does not already provide the pinned Bun. Deno is optional for normal local checks
and uses `tools/dev/deno.sh` on demand for Deno npm-package validation.

Windows native builds obtain WinFlexBison from the exact upstream archive pinned
in `tools/dev/winflexbison.toml`. The shared native setup verifies
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
moon query affected --upstream none --downstream deep
moon run oliphaunt-rust:coverage --affected --include-relations --downstream deep
```

Use `moon query affected` to inspect affectedness and `moon run <target>` for
explicit local targets. GitHub CI executes the exact planned target list with
Moon so jobs do not expand into unrelated downstream work. Normal commands use
Moon's own concurrency instead of a forced single-worker debug mode.

The validation entrypoint is split by maintainer workflow:

- `moon run liboliphaunt-native:host-smoke`: release-shaped, no-build host
  C ABI/runtime smoke. It depends on the native release-runtime producer and
  refuses any implicit rebuild inside the smoke;
- `cargo clippy -p <package> --all-targets --locked -- -D warnings`: focused Rust lint;
- `moon run ci-workflows:check`: workflow syntax and security checks plus the
  behavior tests for helpers invoked by Actions;
- `moon run liboliphaunt-wasix:smoke`: hard-requires portable assets plus host AOT,
  installs them into ignored paths, and runs the real runtime tests;
- `moon run oliphaunt-wasix-ts:test-consumer`: installed Node/Bun/Deno/Electron
  packages against the actual runtime, with producer prerequisites;
- `moon run oliphaunt-wasix-ts:test-browser`: Chrome package, storage and
  extension behavior against the WASIX browser host;
- `moon run oliphaunt-wasix-ts:test-browser`: local browser proof, including its
  declared runtime and seed prerequisites. It serves
  COOP/COEP headers and requires Chrome/Chromium to exercise `pgtap`, recover two
  PostgreSQL error paths, return `42`, and exit cleanly. Add `--pg-uuidv7` for the
  private native-module canary;
- `moon run integration-examples:test`: mocked Tauri launcher and mobile proof-receipt tests;
- `moon run liboliphaunt-native:lint liboliphaunt-native:test`: cached native
  Shell syntax and native unit tests without building a runtime;
- `moon run oliphaunt-rust:test-integration`: native direct, broker, and server
  behavior against the current host runtime. Extension behavior remains the
  separate `oliphaunt-rust:test-extensions` lane;
- `moon run perf-tools:native-measure`: optional native RTT measurement, using
  the same benchmark runner available locally;
- `bun run --cwd benchmarks/perf/wasix-node bench:streaming`: quick local WASIX
  TypeScript transport benchmark. It reuses staged packages and portable assets,
  compares the root direct and explicit `/worker` contracts, exercises bounded COPY,
  backpressure, event-loop delay, process RSS, the local server, `pg_dump`, and
  `psql`, and prints a readable report (`-- --json` prints the complete JSON).
  Process RSS deltas are descriptive because the quick run reuses one process.
  If inputs are absent, first run
  `moon run oliphaunt-wasix-tools-ts:package liboliphaunt-wasix:runtime-portable`;
- `moon run oliphaunt-rust:build`: Cargo compilation of `oliphaunt` and
  `oliphaunt-build`. Artifact-relay build-script behavior is owned by `test`;
  package and native runtime evidence remain separate `package` and `test-integration`
  targets;
- `moon run oliphaunt-rust:test`: the hosted-equivalent Rust source-test lane.
  It runs documentation tests, `oliphaunt-build` tests, and all `oliphaunt`
  source tests. A focused command such as `cargo test -p oliphaunt --lib`
  remains useful while iterating. Runtime-dependent tests have their own owner
  tasks and artifact prerequisites;
- `moon run oliphaunt-rust:package`: creates the final `oliphaunt` and
  `oliphaunt-build` crates and inspects their contents. The separate
  `test-consumer` task compiles the extracted packages with their real packaged
  dependencies. WASIX uses the same `package` / `test-consumer` distinction.
  Source tests and runtime integration remain separate;
- Native package producers copy the canonical C header. Their consumers compile
  it as part of normal builds; the shared seed and protocol fixtures exercise
  behavior through the SDKs;
- `moon run oliphaunt-swift:build`: SwiftPM compilation of the SDK package;
- `moon run oliphaunt-swift:test-native`: Swift SDK tests against the current native
  host runtime. Installed iOS app tests are a separate lane;
- `moon run oliphaunt-swift:package`: validates the Swift source package
  shape without building platform release artifacts;
- `moon run liboliphaunt-native:build-runtime-ios-xcframework`: explicitly builds and
  freshness-checks iOS simulator and device `liboliphaunt.dylib` slices from
  the same PostgreSQL 18 patch stack, then packages them as
  `liboliphaunt.xcframework`;
- `moon run oliphaunt-kotlin:format-check oliphaunt-kotlin:lint oliphaunt-kotlin:build`: Kotlin formatting, lint, and common/JVM and
  Android compilation. Publication-shape checks run during `package`; isolated
  tests remain in `oliphaunt-kotlin:test`;
- `moon run integration-examples:react-native-android-e2e`: Android React Native
  installed-app harness over the Expo development-client sample;
- `moon run integration-examples:react-native-ios-e2e`: iOS React Native
  installed-app harness over the Expo development-client sample;
- `moon run oliphaunt-react-native:build`: React Native TypeScript and packaging-helper compilation.
  Run `oliphaunt-react-native:typecheck` and `oliphaunt-react-native:lint-codegen`
  for source diagnostics. Package-shape work belongs to `oliphaunt-react-native:package`;
- `bun run --cwd examples/react-native-expo smoke:android`: real Android Expo
  development-client smoke for the installed React Native package. It reuses
  current native artifacts, generates the ignored Expo `android/` project only
  when missing, packages `liboliphaunt.so` plus runtime/cluster-seed resources, starts
  Metro when needed, installs the app, and waits for
  `OLIPHAUNT_EXPO_SMOKE_PASS`;
- `bun run --cwd examples/react-native-expo smoke:ios`: real iOS Expo
  development-client build/smoke harness for the installed React Native package.
  For simulator builds it produces or reuses the current iOS simulator
  `liboliphaunt.dylib` automatically when no explicit artifact override is set,
  packages the same runtime/cluster-seed resources, patches only the ignored
  generated `ios/` Podfile for local Swift pods, rejects macOS dylibs, and can
  run in `OLIPHAUNT_EXPO_IOS_BUILD_ONLY=1` mode when CoreSimulator is
  unavailable;
- `moon run <product>:package`: stage and verify the selected product package;
- `cargo hack check -p <package> --feature-powerset --no-dev-deps`: cargo-hack
  feature combination checks;
- `cargo semver-checks check-release -p <package>`: cargo-semver-checks public
  API compatibility against the published version (use an explicit
  `--baseline-rev <commit>` before first publication);
- `cargo deny check`: cargo-deny dependency
  policy checks;
- `moon run <product>:test-integration`: the selected product's real runtime
  behavior, when that task exists. Use `test-consumer` for installed artifacts
  and `test-browser` for browser execution. Inspect the owner's tasks rather
  than running every platform's packaging, coverage, or device tests globally;
- `moon run release-tools:check`: the canonical full local release-policy gate.
  The direct equivalent is
  `bash tools/release/release-check.sh`. This release-owned
  metadata and mutation gate does not replace affected product source checks, `test`,
  or `package` tasks;
- `bash tools/release/release-metadata-check.sh`: internal
  protected-workflow replay after a generated release commit has passed its
  structured verifier or after the exact hosted `Qualified` record has been
  reverified against a clean checkout. It is not a replacement for the full
  local gate. Candidate artifact dry-runs run only through the protected GitHub
  `Release` workflow after exact-SHA qualification.

Moon caches deterministic task results when their declared source inputs and
task dependencies have not changed. Local `:smoke` targets use `cache: local`,
so repeated `moon run :smoke` runs can return a cached result for the same source
graph. Use `moon run <product>:smoke --cache off` when you need a live
device, simulator, or runtime probe regardless of the cache. Product tasks declare their own inputs and outputs; coverage remains an optional
product-local command.

Kotlin and React Native Android SDK validation uses Gradle's configuration
cache by default so repeated local runs do not reconfigure the same Android/KMP
graphs. Set `OLIPHAUNT_GRADLE_CONFIGURATION_CACHE=0` only when diagnosing
Gradle configuration-cache behavior itself.

The hook split is intentionally small:

- pre-commit: file hygiene and formatting
- release readiness: the affected product source checks, unit, and package tasks
- CI/release: path-aware combinations of the same validation modes, workflow
  linting, feature powerset, public API compatibility, crate packaging,
  native AOT runtime tests, frozen Cargo publication dry-runs, and supply-chain
  policy

Install local hooks and pinned CLI tools when needed. Maintainer bootstrap
release assets are an explicit source contract in
`tools/dev/maintainer-tools.toml`: every supported Linux and macOS
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
bash tools/dev/install-hooks.sh
```

`sdks/rust-wasix/tests/runtime_smoke.rs` starts the real WASIX backend and
is intentionally slower than the protocol unit tests.

## Maintenance Utilities

The repository includes maintenance commands:

- `oliphaunt-wasix-dump` is the logical dump CLI entry point. Its typed
  `--database`, `--username`, and repeatable `--extension` options configure
  the embedded server; arguments after `--` shape `pg_dump` output.
- `oliphaunt-pgwire-server` exposes a local PostgreSQL socket backed by the embedded
  runtime.
- `database-resources` produces selectable standard/ICU seed profiles from the
  runtime compiler output. WASIX seeds use the portable physical format; native
  seeds have explicit desktop or mobile physical targets. Runtime packages do
  not own these resource archives.

Asset and source checks (source transport also requires GNU `timeout`; install
`coreutils` on macOS):

```sh
bash third-party/tools/fetch-sources.sh production-all --force
bash third-party/tools/fetch-sources.sh wasix-runtime --verify-only
cargo run -p xtask -- assets check --strict-generated
moon run database-resources:package-wasix
bash runtimes/liboliphaunt-wasix/assets/build/prepare_postgres_source.sh
moon run oliphaunt-rust:package
```

## Local Runtime Development

Local development has three supported modes.

Fast contributor mode does not require Docker, upstream source checkouts, or
generated native AOT payloads. Use it for ordinary Rust, docs, tests, examples,
and workflow edits:

```sh
moon query affected --upstream none --downstream deep
moon run oliphaunt-rust:format-check oliphaunt-rust:lint oliphaunt-rust:test
```

For native liboliphaunt work, run only the product boundary you changed:

```sh
moon run liboliphaunt-native:host-smoke
moon run oliphaunt-rust:test-integration
moon run extension-artifacts-native:build-target oliphaunt-rust:test-extensions
```

`liboliphaunt-native:host-smoke` proves the C ABI. The Rust regression uses the basic native
runtime and runs SQL/protocol regression across direct, broker, and server mode.
`moon run oliphaunt-rust:test-extensions` is the separate
extension-artifact lane; it depends on `extension-artifacts-native:build-target` and is
intentionally not part of normal PR CI. The host artifact builder uses
the build script's no-build freshness probe before running the matrix, which avoids both
unnecessary rebuilds and the failure mode where a core-only runtime is
accidentally treated as extension ready. `sdks` validates SDK ownership/parity,
then runs the Rust, Swift, Kotlin, and React Native package checks. See
[`docs/maintainers/sdk-parity-policy.md`](./sdk-parity-policy.md) for the SDK ownership contract. `full` enables
native extension artifacts and the extension matrix in addition to the SDK
checks. Use
`OLIPHAUNT_TRACK_BUILD=never` when you want to prove the harness is not
rebuilding anything.

Host-platform artifact mode is for runtime work on the current machine. It
builds or packages only the current host target, leaves all generated payloads
in ignored paths, and then runs the real runtime tests:

```sh
host="$(rustc -vV | awk '/^host:/{print $2}')"
bash third-party/tools/fetch-sources.sh production-all --force
bash runtimes/liboliphaunt-wasix/tools/build-runtime-portable.sh
bash runtimes/liboliphaunt-wasix/tools/build-aot-target.sh
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
bash runtimes/liboliphaunt-wasix/tools/serialize-aot.sh --target-triple "$host"
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
bash runtimes/liboliphaunt-wasix/tools/download-assets.sh --run-id <id> --target-triple "$host"
# Or select the successful CI run for one exact commit:
bash runtimes/liboliphaunt-wasix/tools/download-assets.sh --sha <full-40-character-sha> --target-triple "$host"
moon run liboliphaunt-wasix:smoke
```

Workflow-run downloads require the authenticated GitHub CLI. The downloader
accepts only the requested run or exact SHA and validates the packaged runtime
and AOT manifests and checksums before installation.

Released artifact bundles can be installed without the GitHub CLI because they
are public GitHub release assets:

```sh
host="$(rustc -vV | awk '/^host:/{print $2}')"
bash runtimes/liboliphaunt-wasix/tools/download-assets.sh --release <tag> --target-triple "$host"
moon run liboliphaunt-wasix:smoke
```

Release downloads validate the published checksum manifest, archive checksums,
and packaged runtime/AOT manifests before installation.

Release validation can download every supported target from the exact `CI`
workflow SHA:

```sh
bash runtimes/liboliphaunt-wasix/tools/download-assets.sh --sha <full-40-character-sha> --all-targets
bash tools/release/release-check.sh
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

Generated Cargo and npm carriers are assembled directly from private staging trees. Payload splitting uses the finished compressed archive size and reuses the fitted bytes. Maintained Rust SDK source packages use `tools/packaging/package-cargo-source.sh`, which lets Cargo select source files and describe compile targets. Product consumer checks compile the unpacked crates; carrier assembly does not rebuild each generated crate.

Moon runs Shell tasks with Bash on Unix and Git Bash on Windows. CI machine setup
uses PowerShell only to initialize the MSVC environment. The task graph resolves
this configuration on Linux; actual Windows compiler and package execution still
requires Windows qualification.
