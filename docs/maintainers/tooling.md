# Tooling Decisions

Status: normative tooling decision record. Last verified: 2026-07-16. Owner: repository maintainers.

Oliphaunt is a polyglot product monorepo. Tooling has to make product work
predictable without hiding ecosystem-native behavior.

## Roles

- Moon is the product/task graph, affectedness engine, local cache, and CI task
  executor.
- Release Please manifest mode owns release PRs, versions, and changelogs.
- The protected release workflow owns exact-SHA product tags and draft GitHub
  releases.
- Product-local `release.toml` files own package metadata release-please does
  not model: owner, kind, publish targets, registry packages, release
  artifacts, compatibility-version files, and derived version files.
- Runtime products select published target presets in Moon
  `project.release.artifactTargets`; exact extension products own explicit
  support and evidence in `targets/artifacts.toml`.
- Product-native build tools own product behavior: Cargo, SwiftPM/Xcode,
  Gradle, npm/JSR, Expo, React Native Codegen, and PostgreSQL build scripts.
- Bun helpers under `tools/release/*.mjs` and `.github/scripts/*.mjs` own the
  public and protected release check, dry-run, publish, tag, and draft-release
  command surface.

Do not add a second source graph, release graph, or root alias layer over Moon.
Do not add a repo-wide tool because it is popular in one language ecosystem.

## Moon

Install Moon through proto from `.prototools` and run `moon` directly:

```sh
moon query projects
moon query tasks
moon query affected --upstream none --downstream deep
moon run :check
moon run :test
moon run :coverage
```

Moon task names carry stable intent:

- `check`: static, typecheck, lint, codegen, or build-only validation.
- `test`: product-native unit or contract tests.
- `package`: package-shape checks and publish dry-runs.
- `smoke`: one runtime happy path.
- `regression`: broader SQL, protocol, extension, lifecycle, or runtime
  regressions.
- `bench`: benchmark plan/report validation.
- `bench-run`: measured benchmark execution.
- `coverage`: measured product-native line coverage.

Every task must declare explicit inputs. Tasks with deterministic output that
other tasks consume must declare outputs. Use Moon tags for CI lanes and ad-hoc
selection; do not create root script aliases for new lanes.

Moon dependency scopes are meaningful:

- `production` and `peer` are release-affecting compatibility edges.
- `build` is for tests, fixtures, generated metadata, package-shape checks, and
  other non-release coupling.

## pnpm

pnpm is not the global build orchestrator. Its repo-level role is:

- install JavaScript-family workspace dependencies from `pnpm-lock.yaml`;
- provide JavaScript package-manager commands for docs, TypeScript, and React
  Native packages.

The root `package.json` intentionally has no scripts. Run the corresponding
Moon target or the product-native package command; a second alias layer makes
affectedness, cache behavior, and ownership harder to inspect.

Cargo, Gradle, SwiftPM, Xcode, npm/JSR publish, Expo, and PostgreSQL build
scripts stay product-owned and are invoked through Moon tasks where repository
or CI orchestration is needed. `node_modules/` directories are normal ignored
local install state; they must never be tracked.

## Scripts

Use shell for setup, process orchestration, platform packaging glue, and thin
CI wrappers. Policy code that parses repository files and asserts invariants
should live under `tools/policy/assertions/assert-*.mjs` and run with Bun. Keep
`check-*` scripts as Moon/CI entrypoints when they aggregate checks or wrap
ecosystem-native tools.

## Bootstrap toolchain sources

The manifests in `src/sources/toolchains/` are the source of truth for
downloaded maintainer toolchains. `bun.toml` and `deno.toml` pin both the
official archive SHA-256 and the extracted executable SHA-256 for every
supported macOS, Linux, and Windows host target. `android-sdk.toml` pins the
Linux and macOS command-line-tools archives and the exact SDK package
identities used by builds. Version inputs in composite actions are compatibility
guards: they must agree with the manifest; they do not select arbitrary bytes.

CI does not delegate Node, Moon, or pnpm acquisition to `actions/setup-node`,
Corepack, or `moonrepo/setup-toolchain`. `node-runtime.toml` pins the official
Node archive and extracted runtime binary for every supported host.
`moon-cli.toml` and `pnpm.toml` pin their archives, component hashes, executable
modes, and extracted-tree identities. `moon-plugins.toml` pins both each OCI
manifest digest and the manifest-bound WASM blob. `npm-publisher.toml` applies
the same archive and complete-tree contract to the npm CLI used by publication
and exact-candidate consumer checks. The proto version in Moon configuration is
a compatibility contract only; CI does not hydrate tools through proto.

Bootstrap downloads are HTTPS-only, bounded, checksum-verified, validated for
archive layout and entry type, extracted into private staging directories, and
promoted by a same-filesystem rename. A valid local executable is preserved. A
corrupt or wrong-version cache is repaired, and an interrupted replacement
restores the prior directory. Do not add `continue-on-error` setup-action or
unchecked `curl | unzip` fallbacks.

GitHub cache entries are acceleration only. Every restored binary, wrapper,
plugin, component, mode inventory, and complete package tree is revalidated
before its path is exported. Moon plugins are copied into a fresh private
`MOON_HOME`, and `MOON_TOOLCHAIN_FORCE_GLOBALS=true` prevents Moon from
silently hydrating another runtime. On Windows, composite actions convert
Git-Bash paths back to native paths before writing `GITHUB_PATH`; pnpm store
creation converts the native path to POSIX only for the Bash filesystem call.

Android command-line-tools are byte-pinned. Packages installed through
`sdkmanager` are not immutable repository blobs: the bootstrap requests the
exact NDK, CMake, build-tools, and platform package identities, then validates
their installed `source.properties` and build-critical executables/resources.
`platform-tools` is an intentionally
unversioned moving Android repository package and is validated by the presence
of an executable `adb`; do not describe it as byte-reproducible.

The Android setup action enables the Gradle cache only for Gradle/Expo
consumers. Native-only Android artifact jobs pass `gradle-cache: "false"`, so
`actions/setup-java` does not register an irrelevant Gradle post-cache step.
When native ccache is enabled, its directory is created before cache restore so
an empty first run does not emit a cache path-validation warning.

The Linux Kotlin/Native test lane has a dedicated setup-java Gradle cache
identity selected by
`src/sdks/kotlin/gradle/cache-scopes/linux-native-tests.txt`. The shared
dependency inputs are not sufficient for this lane: another Gradle consumer
can populate the same immutable setup-java key without the host-native test
variants, and a successful job is required before setup-java can save a more
complete entry. Change the marker only when intentionally invalidating this
lane's cache, and qualify that change with a cold `linuxX64Test` run.

Kotlin plugin and dependency resolution try Google Cloud's fixed, hosted Maven
Central mirror before canonical Maven Central. The mirror is an availability
path for valid Central coordinates when a shared GitHub-hosted runner IP is
temporarily refused; canonical Central remains the missing-module fallback.
Do not add retries for an HTTP 403, a mutable repository override, or another
uncontrolled repository. A mirror or cache change must be proven from a fresh
Gradle home, and mirror payloads used as evidence must match canonical Central
by checksum. Gradle dependency verification should be introduced only as one
complete, reviewed rollout covering every supported host and configuration;
an incomplete host-generated metadata file is not a release safeguard.

## CI

GitHub Actions owns runners, credentials, artifact upload, and platform matrix
fan-out. Moon owns which tasks are affected and how tasks depend on each other.
Every GitHub-hosted runner uses an explicit OS-version label. Mutable
`ubuntu-latest`, `macos-latest`, and `windows-latest` aliases are forbidden by
workflow policy, including suffixed variants. A runner-image upgrade is an
intentional dependency change: inspect the image/toolchain delta, rerun the
platform binary compatibility contract, and qualify every affected release
target before changing the pin.
The repository build toolchain is exact Rust 1.93.1 in
`rust-toolchain.toml`; crate `rust-version = "1.93"` fields are the distinct
consumer MSRV contract and must not be used as a mutable CI toolchain selector.
Linux broker packaging also pins the official Rust 1.93.1 Bookworm OCI index
by digest because the final glibc symbol bindings are a linker-input contract,
not a property guaranteed by `rust-toolchain.toml`. Its sealed build is
networkless and read-only. The separate digest-pinned Fedora 39 image is used
only to rehearse the glibc 2.38 ABI after verifying the container's observed
glibc version; Fedora 39's end-of-life security status is not a production OS
support claim.
Windows jobs configure the runner-owned Visual Studio developer shell through
`.github/scripts/setup-msvc.ps1`; they do not depend on a third-party Node
action for compiler environment discovery. The setup accepts only Visual Studio
installation major 18, selects x64 tools from `HostX64/x64`, and verifies the
VC145 redistributable closure. It records the observed Visual Studio, VC tools,
Windows SDK, compiler/linker, and runner-image versions without patch-pinning a
runner-owned toolchain that GitHub may service in place. Apple jobs select the
exact `/Applications/Xcode_26.5.app/Contents/Developer` bundle and require the
observed Xcode minor to remain 26.5. The Xcode build identifier, Apple SDK
versions, and runner-image version are evidence rather than patch pins. macOS
setup removes the unused runner-provided `aws/tap` before formula lookup instead
of disabling Homebrew's tap-trust enforcement.

CI flow:

1. The affected job uses Moon queries to select stable job names from task tags
   named `ci-<job>` and to emit the exact Moon task targets for each job.
2. The affected job emits dynamic `Checks / <target>` and `Tests / <target>`
   matrices plus one compact `Policy` task batch from Moon-selected targets.
   `Checks` are normal static/lint/typecheck-style package or tool checks.
   Policy targets are invariant assertions that parse repository files,
   workflow YAML, release metadata, generated graphs, or package topology.
   Package checks and tests keep task inheritance; the policy batch runs its
   selected targets with `--upstream none` so it does not re-run package
   prerequisites that already have their own visible jobs. A task that truly
   needs the Android SDK declares the `ci-android-sdk` Moon tag. The planner
   projects that capability into runner setup, so unrelated check, policy, and
   test shards do not install Android tooling.
3. Product build jobs call `.github/scripts/run-planned-moon-job.sh <job>`.
4. The planned-job wrapper reads the affected job target map, then delegates to
   `.github/scripts/run-moon-targets.sh`, which runs
   `moon run` with the selected targets. This is for planned artifact targets
   whose producer jobs may be selected by release-product implications rather
   than by direct file affectedness. Jobs that consume downloaded artifacts pass
   `OLIPHAUNT_MOON_UPSTREAM=none`; other build jobs keep Moon upstream task
   inheritance enabled. SDK `package-artifacts` tasks depend on the product
   `package` task and consume its package-shape outputs instead of rerunning
   package assertions inside the artifact staging script.
5. GitHub matrix fans out only target dimensions such as OS, CPU, ABI, native
   runtime target, broker target, Node direct target, WASIX AOT target, Android
   emulator, and iOS simulator.

The required PR gate is thin: visible `Checks / <target>`, `Policy`,
`Tests / <target>`, `Builds / <artifact>`, and installed-app
`E2E` jobs all fan out from the affected plan, while Moon models package-local
prerequisites. The final `Required` job aggregates the `Checks`, `Tests`,
`Builds`, and `E2E` phase gates plus `release-intent`; the selected `Policy`
batch is included in the `Checks` gate. Mobile installed-app `E2E`
consumes built app artifacts from the same CI run and does not rebuild runtimes,
SDKs, or extension packages.

Mobile CI target fan-out is derived from published
`liboliphaunt-native` artifact rows generated from the product's Moon
`artifactTargets` declaration and the release target preset. Android jobs use
rows whose surfaces include `react-native-android`; iOS jobs use rows whose
surfaces include `react-native-ios`. Do not hardcode mobile ABI target lists in
CI planners.

Keep workflow names and job names product-oriented. Put implementation details
in step names.

## Moon Cache Policy

Moon is allowed to cache task results when inputs, dependency task outputs,
toolchain-sensitive files, environment variables, and outputs represent the
work. It does not know about simulator/device state, installed apps, local
ports, Docker daemon state, code-signing identities, registry state, or copied
runtime artifacts unless those are modeled as inputs.

Cache deterministic static checks, package-shape checks, generated freshness,
docs builds, unit tests, and coverage reports when they declare inputs and
outputs.

Use `cache: local` for developer smoke tasks that are useful to replay when
local source inputs have not changed.

Force live execution for CI/mobile/device proof with `MOON_CACHE=off`; those
lanes prove the current runner, simulator/device, signing environment, app
artifact, and runtime artifact.

Cache benchmark plan checks, never measured benchmark runs. `bench` validates
matrix and report shape; `bench-run` measures current hardware and runtime
state.

Use `runInCI: skip` for expensive dependency-only tasks that must stay valid in
CI action graphs but must not run as broad CI work. Use `runInCI: false` only
for tasks CI must never invoke.

## Release Tooling

Release Please owns the generated release PR, product-version bumps, and
changelogs without forcing non-JavaScript products into fake `package.json`
files. It supplies the reviewed component/version state used to derive tag
names, but it does not create tags or GitHub releases.

What release-please does not own:

- platform binary builds;
- extension artifact builds;
- checksums and attestations;
- registry credential checks;
- package-native publish commands;
- verifying already-published GitHub release assets;
- exact-SHA product tags and draft GitHub releases.

Those stay behind the Bun release entrypoints, the protected workflow, and
product-native release tasks.

Do not reintroduce release-plz, git-cliff product changelog ownership, a central
release graph, or broad clean-registry reinstall gates as routine CI policy.

## Debugging

Use Moon's graph and cache diagnostics before adding scripts:

```sh
moon project-graph
moon action-graph oliphaunt-react-native:package-artifacts
moon hash <hash>
moon run <target> --cache off --log trace
```

If a task is slow, first check whether its inputs are too broad, outputs are
missing, dependency scopes are wrong, or CI is proving runner state that cannot
be safely cached.

Graph policy fixtures are split by contract:

- `tools/graph/synthetic/affected.toml` checks Moon owner/downstream behavior.
- `tools/graph/synthetic/release.toml` checks release product selection.
- `tools/graph/synthetic/coverage.toml` checks coverage routing.

Do not add mixed synthetic cases that assert unrelated contracts in one table.

### Advisory reference audits

Low textual reference counts are cleanup leads, not correctness failures. Agents
may inspect them with `moon run dev-tools:helper-reference-audit` and
`moon run dev-tools:source-reference-audit`. Both tasks are intentionally local,
uncached, and excluded from CI because public entrypoints and generated or
indirect references require human or agent review before removal.

## Policy Design

Policy checks protect externally meaningful contracts, not the current spelling
of an implementation. Prefer these forms, in order:

1. parse a manifest, package, workflow, lock, checksum, or evidence record and
   assert a stable invariant;
2. execute a package-shape, clean-consumer, failure-path, or runtime test;
3. use a narrow security scan when the unsafe behavior is itself textual.

Do not assert function names, step display names, source line order, prose
fragments, or exhaustive file inventories. Refactoring should fail policy only
when it changes a contract. `repository-semantics.mjs` owns the small set of
cross-repository layout and toolchain invariants; focused checkers own release,
SDK, extension, workflow, dependency, and evidence behavior.

The repository-local skills under `.codex/skills/` are the operational runbooks
for agent-built changes. Use `qualify-oliphaunt-change` for selecting proof,
`add-oliphaunt-extension` for extension metadata and carriers, and
`release-oliphaunt` for candidate qualification and publication. Update the
relevant skill when an operational workflow changes; do not encode a tutorial
as source-text assertions in CI.

## Tool Ownership

Keep code in the narrowest owning domain: product behavior beside the product,
shared source/asset operations in `tools/xtask`, performance behavior in
`tools/perf`, graph selection in `tools/graph`, release contracts in
`tools/release`, and repository invariants in `tools/policy`. Split a module
when it has independent inputs, outputs, or failure modes. File names and helper
boundaries are implementation details, not policy APIs.
