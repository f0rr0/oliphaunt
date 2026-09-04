# CI, Release, and Product Task Audit

Final adversarial release readiness and hosted-limit results are recorded in
[`RELEASE_PIPELINE_READINESS_2026-09-03.md`](RELEASE_PIPELINE_READINESS_2026-09-03.md).

Audit baseline: freshly fetched `origin/main` at
`6b3e16aed489507cc9140c0dacb677785792da7d` (`fix(release): use workspace perf
dependencies (#168)`), inspected on 2026-09-02. The measurements below are a
snapshot of that revision and its GitHub runs.

## Executive verdict

The repository's CI and release processes are substantially over-scoped.
Several visible job names also materially understate or misdescribe the work
they execute. There is no evidence of malicious intent, but “misleading” is a
fair technical description.

## CI and release findings

### 1. Every push to `main` is deliberately exhaustive

The planner ignores affected scope on non-PR runs and selects every
builder/runtime job with the reason `non-PR full CI/runtime run`.

The latest `main` change touched only `tools/perf/runner/Cargo.toml` and
`tools/policy/check-native-boundaries.mjs`, but GitHub run
<https://github.com/f0rr0/oliphaunt/actions/runs/33628129735> launched 100 jobs,
used approximately 879 raw runner-minutes, took 103 minutes wall-clock, and
failed.

| Category | Jobs | Raw runner-minutes |
| --- | ---: | ---: |
| Builds | 57 | 775 |
| E2E | 8 | 30 |
| Checks | 18 | 40 |
| Tests | 12 | 25 |
| Policy | 1 | 7 |

Builds plus E2E accounted for approximately 805 minutes, or 92% of the run,
although the change did not touch product runtime or package inputs. The last
successful `main` run similarly used approximately 905 raw runner-minutes.

### 2. Workflow-only PRs trigger every product builder

A direct change to the `ci-workflows` project adds all builder jobs. PR #169
(<https://github.com/f0rr0/oliphaunt/pull/169>) changed one workflow file by
`+1/-11`. At audit time its run had already materialized 40 jobs, 38 of them
non-skipped, including Android, iOS, Windows, macOS, Linux, extension, WASIX,
Rust, Kotlin, and JavaScript builds.

### 3. Build jobs rerun checks and tests

Producer jobs default to normal Moon upstream dependency execution unless a
workflow explicitly passes `--upstream none`; many also disable Moon caching.

The latest `main` run demonstrated the consequence:

- `Tests / liboliphaunt-wasix-postmaster:test` passed.
- `Builds / wasix-postmaster (macos-arm64)` later reran the same product's
  `check` and `test` tasks.
- The duplicate `test` timed out with exit 124, failing `Builds`, `Required`,
  and `Qualified`.

Thus a job presented as a build can fail because of a test that already passed
in the visible Tests phase.

### 4. “Validate release metadata” is a large unit-test suite

`tools/release/release-check.mjs` first runs metadata validation and then
dynamically discovers every `*.test.mjs` under `tools/policy` and
`tools/release`. It currently discovers 165 files, excludes one dedicated test,
and launches 164 fresh Bun subprocesses per invocation.

CI runs this through both:

- `Checks / release metadata (macOS)`; and
- `release-tools:check` inside `Policy`.

The Checks and Policy names therefore conceal a large test suite, while the
visible Tests phase does not own those tests.

### 5. A normal release repeats the full release test suite seven times

The typical path is:

| Phase | Full `release-check` invocations |
| --- | ---: |
| Prepare release PR | 1 |
| Generated release PR CI | 2 |
| Merge-to-main CI | 2 |
| Publish dry run | 1 |
| Actual publish | 1 |
| **Total** | **7** |

At the current inventory, that is 1,148 fresh test-file processes before
counting narrower repeated metadata validation. Metadata validation is reached
approximately ten times through the same complete release path.

The release-PR workflow also runs the full gate before generating the release
candidate, then validates the generated candidate again. The pre-generation
gate cannot validate the generated versions or changelog state.

### 6. The “dry run” is candidate assembly, not publication simulation

`release-publish.mjs publish-dry-run` validates metadata and registries and
exits before any publication transport executes. The surrounding workflow
downloads qualified artifacts, packages public carriers, and creates a
publication lock. Its accurate name would be **Assemble and approve release
candidate**.

### 7. Actual publish repeats most dry-run preparation

Dry run and publish reuse the same large YAML step anchor. Publish redownloads
CI artifacts, revalidates them, repackages carriers, regenerates the lock, and
then compares that lock with the approved dry-run lock. The reproducibility
comparison is valuable, but repeating the complete assembly is not the only
way to achieve it.

### 8. Branch protection does not independently justify the scope

GitHub branch protection requires only the `Required` status. The workflow
itself defines that aggregate as requiring checks, tests, builds, and E2E. The
exhaustive policy is therefore self-imposed rather than required by another
repository control.

## Qualification-guide audit

The guide at `.codex/skills/qualify-oliphaunt-change/SKILL.md` contains sound
security principles but is factually unreliable in important places:

- It says `release-check` runs repository graph policies before metadata and
  tests; the implementation runs metadata first.
- It calls `release-tools:check` the single hosted graph-validation owner, but
  CI has at least two hosted owners of the same gate.
- It names `graph-tools:check` and `graph-tools:generate`; no `graph-tools`
  Moon project or task exists at the audited revision.
- It says `graph-tools:generate` is the sole writer of `target/graph`, while
  `tools/graph/ci_plan.mjs` directly writes `target/graph/ci-plan.json`.
- Its opening advice says expensive producers and E2E should run only when
  relevant inputs change, while hosted CI deliberately does the opposite on
  every `main` push and every workflow-only PR.
- It asks workflow changes to run `check-workflows.sh` and often the full
  `release-check`, although those gates execute overlapping workflow-security
  and planner tests.
- Its Bash 3.2 rule expands to the entire 164-file test gate for scripts reached
  transitively by `release-check`, far beyond the compatibility behavior being
  checked.
- Its statement that package targets own check/test dependencies explains the
  hosted duplication problem: CI also creates separate check/test jobs.

The guide's exact-SHA, immutable-artifact, publication-lock, attestation,
protected-environment, registry-collision, and post-publication-verification
requirements should remain.

## Recommended lean execution model

| Phase | Recommended responsibility |
| --- | --- |
| PR | Affected formatting, static checks, and tests. Workflow-only PRs run workflow security, syntax, and planner tests only. |
| Main | Affected checks on the exact merge SHA. Put exhaustive matrices on an explicit release qualification or schedule. |
| Release PR | Generate the candidate first, validate it once, then let affected PR CI qualify it. |
| Release qualification | One explicit exhaustive exact-SHA build/E2E run producing immutable artifacts and evidence. |
| Candidate assembly | Consume qualification artifacts and create public carriers, capsule, and lock once. |
| Publish | Verify the approved digest-bound candidate, then perform registry/GitHub mutations without rebuilding or rerunning unit suites. |

At the Moon boundary, choose one ownership model:

1. Keep separate check/test jobs and run producer jobs with `--upstream none`;
   or
2. Let package/build jobs own their dependencies and delete the separate jobs.

Do not do both. Also split the small release metadata/graph validation from the
164-file policy/release unit suite, give each a single owner, and use names that
describe the work actually performed.

## Product-boundary task audit

### Scope and inventory

The canonical publication catalog contains **20 versioned release products**
and **203 registry carriers**. Moon exposes **237 tasks** across 44 task-owning
projects. This section works backward from the publication catalog and then
includes the shared tasks that qualify those products.

| Release boundary | Public delivery |
| --- | --- |
| `liboliphaunt-native` | 35 Cargo, npm, and Maven carriers plus GitHub assets |
| `liboliphaunt-wasix` | 20 Cargo and npm carriers plus GitHub assets |
| `liboliphaunt-wasix-postmaster` | GitHub release assets only |
| Seven external extensions | 122 Cargo, npm, and Maven carriers plus GitHub assets |
| Contrib PG18 extensions | 18 carriers owned and versioned by the native/WASIX runtime products |
| `oliphaunt-broker` | 8 Cargo/npm platform carriers plus GitHub assets |
| `oliphaunt-node-direct` | 4 npm platform carriers plus GitHub assets |
| `oliphaunt-wasix-napi` | 4 npm platform carriers plus GitHub assets |
| Rust, Kotlin, JS, React Native, WASIX Rust, WASIX TS | 10 registry carriers across Cargo, Maven, and npm |
| Swift SDK | GitHub release and SwiftPM source tag |

The contrib boundary is intentionally unusual: `oliphaunt-extension-contrib-pg18`
looks like a product and publishes named packages, but it is not independently
versioned. Its carriers belong to `liboliphaunt-native` or
`liboliphaunt-wasix`. That should be stated explicitly wherever release
products are presented.

Judgment terms below:

- **Aligned:** the name, work, and dependencies match.
- **Overloaded:** useful work, but more than the task name promises.
- **Under-proving:** the task does less than the product claim suggests.
- **Redundant:** another selected task already owns the same proof.

### Pre-refactor per-product task assessment

| Product boundary | Exposed task groups and plain meaning | Judgment and change |
| --- | --- | --- |
| `liboliphaunt-native` | `check` runs patch validation plus nine unit/test helpers; `release-runtime*` build platform runtimes; `host-smoke` runs the C ABI smoke; `smoke` also runs the perf-harness guard and Rust SDK tests; `release-assets` merges target artifacts. | **Overloaded.** `check` is partly a test suite, and `smoke` tests other products. Split `static`, `unit`, `build-<target>`, `abi-smoke`, and `package-assets`. Remove SDK/perf work from the runtime smoke. Delete the duplicate `release-check` alias of `host-smoke`. |
| `liboliphaunt-wasix` | `check` validates the patch stack; `runtime-portable` builds the WASM runtime; `runtime-aot` consumes it to make AOT artifacts; `smoke`/`regression` execute PostgreSQL, proxy, CLI, extension, and client behavior; `release-assets` packages outputs; `release-check` checks artifact policy. | Mostly **aligned**, but `smoke` relies on pre-existing assets without declaring a build/artifact input, while local Moon deps imply builds that hosted CI deliberately bypasses. Rename `release-check` to `artifact-contract`; keep `build-portable -> build-aot` as a real data dependency; pass downloaded artifacts explicitly to smoke/package tasks. |
| `liboliphaunt-wasix-postmaster` | `check` validates source locks, release metadata, script syntax, and static policy; `test` runs 27 Python/shell unit tests of orchestration and failure handling; `prepare-*`, `runtime-build`, `configure`, and `postgres-build` create the runtime; `initdb-*`, `smoke`, `regression`, stress, and recovery tasks exercise behavior; `carrier`/`release-assets` package it. | The fine-grained build chain is valuable. `test` is truthful as an orchestration-unit suite but does **not** prove the running PostgreSQL product; the smoke/regression/recovery tasks do. Remove `test` as a dependency of `carrier`, remove regression as a dependency of `portable-inputs`, and make one `qualify` aggregate depend on unit, behavior, and package tasks. Delete the `release-check -> test` alias. |
| Contrib and external extensions | Each exact-extension project exposes only carrier assembly. Shared native/WASIX artifact projects build selected extensions; shared lifecycle lanes exercise the installed extension set. The contrib project represents 32 SQL extensions; seven external projects represent one SQL extension each. | The deeper carrier audit changes the initial recommendation: **do not split external extensions into native and WASIX versioned products** while both families share one upstream source/version. Native and WASIX targets/carriers are already distinct. Keep shared builders and selected lifecycle proof rather than duplicating four tasks seven times. Contrib should remain one runtime-bound bundle, never 32 leaf products. |
| Extension artifact/model projects | The former `extension-model:check` validated generated/catalog metadata; native/WASIX `check` tasks called that same command again; builders make platform artifacts; package tasks assemble registry carriers. | **Exactly redundant.** The catalog now owns `extensions:lint` once. Builders and carrier assembly consume explicit/downloaded artifact roots rather than smuggling quality gates in as data dependencies. |
| `oliphaunt-broker` | `check` compiles the broker; `test` runs broker tests; `package` checks Cargo package contents; `release-assets` builds the binary/archive and checks notices; aggregation merges platform artifacts. | Individual commands are **aligned**. Dependencies are not: broker check/test pull Rust SDK and native-runtime checks, and producer tasks rerun check/test already scheduled elsewhere. Make check, test, package-shape, and build-assets independent; use `qualify` to aggregate them. Delete the `release-check -> package` alias. |
| `oliphaunt-node-direct` | `check` verifies files/metadata, tests a path classifier, and syntax-compiles C++; `package` reruns that same function plus one workspace assertion; `release-assets` builds, packages, loads, and lifecycle-smokes the addon. There is no product `test` task. | `check` is partly structural testing; `package` **duplicates it exactly** through both its dependency and its own wrapper. Split `static`, `unit`, `package-shape`, `build-addon`, and `addon-smoke`. Source-text assertions about how the build script is written should be replaced by executing the claimed contract. |
| `oliphaunt-wasix-napi` | `check` runs metadata tests, four JS unit suites, `cargo fmt`, `cargo check`, and Cargo tests; `package` reruns all of that and adds one workspace assertion; `release-assets` builds and smoke-tests the packed addon. | Strongly **overloaded and redundant**. `check` is not static, and every package invocation runs the full check twice. Split format/static/unit/package/build/smoke and keep the packed-addon smoke as the behavioral proof. |
| `oliphaunt-js` | `check` builds and type-checks; `test` runs JS unit tests; `package` rebuilds and validates the npm archive; `smoke` executes direct, broker, server, Node, and Deno behavior; `regression` only repeats build/typecheck/unit/package work; `package-artifacts` creates the release carrier. | Good behavioral smoke, but `regression` is **misnamed** and `release-check` repeats the same work behind a large runtime dependency chain. Rename regression to `package-contract` or delete it, make package packaging-only, and put check/test/package/smoke under `qualify`. |
| `oliphaunt-kotlin` | `check` runs Spotless, Detekt, compilation, Android lint, and Maven-publication checks; `test` runs C++ bridge plus JVM/Android unit tests; `package` builds and inspects JAR/AAR outputs; `smoke` runs Android runtime behavior; `maven-staging` creates publication artifacts. | Broad but mostly **aligned**. `regression` is just Gradle `check` plus lint, not a runtime regression. Unit tests do not need `liboliphaunt-native:check`. Remove cross-product gate deps and package-owned check/test deps; rename regression to `gradle-check` or delete it. |
| `oliphaunt-react-native` | `check` builds JS, type-checks, and checks codegen; `test` mainly tests packaging/runner scripts plus JS units; bridge tasks compile Android/iOS bridges; package tasks inspect the npm/iOS/Android shape; mobile build/E2E tasks compile and run the installed Expo app. | Installed-app E2E is the real product behavior and correctly needs its app build. `release-check` fans into the full Swift and Kotlin release checks, while `regression` is mainly package/static work. `smoke` and `smoke-mobile` are exact aliases. Delete the alias and generic release-check; keep platform-specific build/E2E, and aggregate only at qualification. |
| `oliphaunt-rust` | `check` compiles both crates but also runs build-script tests; `test` runs docs, build-crate tests, and nextest; `smoke`, `regression`, and extension regression exercise real native behavior; `package` stages and inspects Cargo packages; consumer-build compiles the packaged release. | Valuable runtime and clean-consumer proofs. `check` hides tests, `test` may skip native behavior when artifacts are absent, and package/release checks grep test-function names to claim coverage. Remove name/source-text assertions, call the actual tests, keep native behavior only in smoke/regression, and make package shape independent. |
| `oliphaunt-swift` | `check` actually builds both the SDK package and root package; `test` runs both package test views; `package` builds a source archive, checks contents/public consumer, and conditionally runs Xcode; `smoke`/`regression` run native Swift tests. | `check` should be called `compile`; no Swift formatter/linter is executed despite `swiftlint` being listed by the doctor. Determine whether root/package tests are genuinely different and keep one if not. Do not make package behavior vary silently by host capability; make Xcode verification an explicit macOS task. |
| `oliphaunt-wasix-rust` | `check` compiles; `test` runs doc/unit/public-API tests and only compiles runtime suites; `package` checks the Cargo archive; `release-check` consumes AOT/extension artifacts and executes one pgTAP logical-tools round trip. | The release-check is a real behavior test but is **misnamed** and overlaps the WASIX runtime's full smoke. Rename it `pgtap-logical-smoke`; run it once in the runtime/product qualification that owns the exact artifacts. Remove source-spelling assertions from package shape. |
| `oliphaunt-wasix-ts` | Separate core/tools `check`, `test`, and `package`; Node/Bun/Deno package smokes; runtime smokes for Node/Bun/Deno/browser; extension browser smokes; package artifact assembly. | The task names are mostly accurate. The 24-task surface is too wide for ordinary CI: package-only host smokes belong on package changes, runtime host/browser smokes on runtime changes, and the complete host matrix on release qualification. Remove core/tools cross-deps unless the tools package actually imports the core package. |

### Format and lint coverage

- Rust formatting is run twice: `policy-tools:fmt-check` calls `cargo fmt`, and
  `repo:prek` runs a `cargo fmt --check` hook again.
- Biome is used only in formatting mode for selected JS/TS/docs paths; it does
  not lint them.
- Kotlin has real formatting and linting through Spotless, Detekt, and Android
  Lint.
- Swift has neither a format check nor SwiftLint execution.
- Shell files receive `bash -n`/`sh -n` in selected locations, but ShellCheck is
  never run despite many ShellCheck directives and the doctor requiring the
  executable.
- C/C++ receives selective syntax compilation, not a general lint or format
  gate.

Recommendation: expose language-accurate `format-check`, `lint`, and `compile`
tasks. Run each once on affected files. Remove the duplicate Cargo-format owner;
either execute ShellCheck/SwiftLint or stop claiming/bootstrapping them.

### Cross-cutting task assessment

| Boundary | What it actually does | Judgment and change |
| --- | --- | --- |
| `policy-tools:tools-compile` | Shell syntax-checks policy scripts, Bun-compiles every `.mjs` under GitHub scripts/examples/policy/graph, compiles one native CI script, and Python-compiles policy files. | Accurate after replacing the vague `check` name. It now fills CI's existing `tools-compile` task class instead of inventing another class. |
| `policy-tools:fmt`, `js-format-check`, `rust-format-check` | Formats the workspace or checks selected JS/TS/docs/tool paths and Rust separately. | The read-only task names are accurate. The developer guide no longer refers to a nonexistent combined `format-check`; duplicated Cargo formatting in `prek` remains a separate cleanup. |
| `ci-workflows:check` | Runs actionlint, zizmor, workflow-security assertions, three GitHub helper tests, one CI-plan test, and the toolchain-bootstrap test. | Useful and mostly accurate. Stop rerunning its policy tests through the dynamic release suite. |
| `repo:check` | A no-op aggregate over tooling semantics, workflow checks, documentation grep policy, release metadata, all-file pre-commit hooks, broker licensing, and native-tools tests. | Accurate only as an aggregate. Do not schedule it beside its children. Rename child tasks precisely and reserve the aggregate for local `qualify-repo`. |
| `repo:prek` | Validates Prek config and applies basic file hygiene, TOML/YAML/JSON parsing, secret/size checks, and Cargo formatting to every tracked file. | Useful hygiene, but all-files execution is unnecessary for most PRs. Use affected files and remove its duplicate Cargo-format hook. |
| `release-tools:check` | Seven metadata/graph/doc checks followed by 164 policy/release test-file processes. | Severely **overloaded**. Split `release-metadata`, `release-policy-tests`, and registry/transport tests. Give each one owner and affected inputs. |
| `sdk-contracts` | Checks generated API documentation, shared fixtures, copied C headers, SDK manifest metadata, native boundaries, and cluster-seed contracts. | The deceptive `doc-examples` marker matcher was removed: it never compiled or compared README examples. Product compile/unit tasks retain executable coverage. `cluster-seeds` is the sole executable checker; the `cluster-seed-contract` project is its taskless data boundary. |
| Shared JS/Rust query cores | JS check verifies six committed generated mirrors; Rust check verifies the canonical source exists and no mirrors are committed. | Rust staging is lean. JS should use the same staging approach or a workspace package instead of committing six mirrors and maintaining a sync task. |
| `source-inputs:unit` | Validates source metadata and runs the source-fetch and PostgreSQL transport tests. | Accurate after splitting out unrelated consumers: WASIX owns its pinned builder-installer tests, while the existing CI toolchain-bootstrap suite owns Maestro. |
| `xtask` Moon tasks | `unit` runs the default-feature test suite; `cluster-seed-runner-check` compiles the optional runner locally; `compile-aot-serializer` compiles the actual AOT feature path. | The CI names now describe the work, and the 44 default-feature tests are no longer absent from declared CI. |
| `xtask` executable | A 13,364-line Rust program implementing WASIX source/fetch/build/install/package, AOT serialization, extension catalog generation, cluster-seed execution, and release staging. | Most of it is real WASIX/extension release machinery. Dead publish/package-size commands and brittle source-spelling guards were removed. Moving the remaining crate would be high-churn path cleanup with no execution saving; split it only when modules need independent cache/change boundaries. |
| Native packaging/proof tools | One crate checks native package mechanics; another runs tests despite being named `check`. | Rename both test runners to `unit`; remove `native-packaging:unit -> check` because Cargo test already compiles the crate. Aggregate both only when native packaging changes. |
| Bench tasks | Many `bench` tasks only validate or plan a benchmark; `bench-run` performs measurements. | Rename plan-only tasks `bench-check` or `bench-plan`. Keep measured runs manual/scheduled and affected. |
| Coverage tasks | Product coverage tasks rerun tests under language coverage tools and aggregate reports. | Valuable as a scheduled/explicit quality signal, not as an implicit prerequisite of build/package/release tasks. |

### Dependency judgment

The graph currently mixes **data dependencies** (“this task consumes that
output”) with **quality-gate dependencies** (“run this check first”). Only the
first kind belongs on build/package tasks.

Correct dependencies to retain:

- WASIX AOT consumes the portable WASM runtime.
- Mobile installed-app E2E consumes the corresponding mobile build.
- Postmaster configure/build/runtime capability tasks consume prior generated
  outputs.
- Final carrier aggregation consumes platform artifacts, either as Moon outputs
  locally or explicit downloaded CI artifacts.

Dependencies to remove or move to an aggregate:

- `test -> check` when the test compiler already compiles the same source.
- `package -> check,test`; package should create/inspect a package, not qualify
  the source again.
- `build/release-assets -> check,test`; CI already gives those gates separate
  jobs, and quality state is not an artifact input.
- Product `check/test -> upstream-product:check`; this creates transitive
  cross-product avalanches. Keep only shared generated-contract dependencies
  that are actually read.
- `release-check` aliases implemented as `true` plus dependencies.

Missing or hidden dependencies to correct:

- Native `smoke` may build a runtime internally rather than exposing that build
  in the graph.
- WASIX smoke tasks require installed assets but do not express an explicit
  artifact input.
- Extension assembly tasks assume CI-downloaded artifacts but have no declared
  input boundary.
- Hosted CI frequently runs Moon with `--upstream none`, so the Moon dependency
  graph and actual hosted execution describe different processes.

### Target task model

Every public product should expose only the tasks it needs from this vocabulary:

| Task | Single responsibility |
| --- | --- |
| `format-check` | Formatting only |
| `lint` | Language/static analyzer only |
| `compile` | Compile/type-check without behavior tests |
| `unit` | Fast product-owned behavior without released artifacts |
| `build` or `build-<target>` | Produce one artifact; depend only on consumed source/generated outputs |
| `package` | Assemble and inspect the registry/GitHub carrier |
| `smoke` | Execute the built/packed product through its public API |
| `regression` | A distinct, named behavior set beyond smoke |
| `e2e` | Installed consumer/application behavior |
| `qualify` | No-op aggregate of the appropriate tasks; local/release orchestration only |

There should be no generic `release-check`. It currently means static artifact
policy, a package alias, a test alias, full package-and-test replay, runtime
behavior, or feature compilation depending on the project.

### Value ranking

Keep first:

1. Clean-consumer package installation/compilation.
2. Smoke tests against the exact built carrier through public APIs.
3. Runtime regression/E2E that exercises PostgreSQL behavior.
4. Exact-SHA artifact identity, locks, attestations, and registry checks.
5. Focused unit, compiler, lint, and format checks.

Cut first:

1. Repeated upstream checks/tests inside producer jobs.
2. Source-text and test-function-name assertions that claim behavior without
   executing it.
3. Exact command aliases and `true` release-check wrappers.
4. Full all-product/all-extension matrices on unrelated changes.
5. Dynamic ownership where adding any release test silently enlarges every
   metadata, PR, dry-run, and publish gate.

### Prioritized implementation sequence

1. Add `qualify` aggregates and make `compile`/`lint`, `unit`, `build`, and `package`
   independent. Change producer CI jobs to consume artifacts with upstream work
   disabled consistently.
2. Split native and WASIX N-API overloaded checks into static/unit/package
   tasks; fix the exact double execution in Node direct and WASIX N-API package
   tasks.
3. Delete/rename every generic `release-check` and every exact alias.
4. Keep shared native/WASIX extension builders but select only affected exact
   products for ordinary CI; reserve the exhaustive 39-extension lifecycle for
   release qualification.
5. Split release metadata from release/policy tests and remove overlap with
   workflow checks.
6. Reduce `xtask` to runtime-heavy WASIX operations; move generic metadata and
   release staging to smaller existing tools.
7. Make formatting/lint ownership truthful and singular.
8. Update the qualification guide only after the new task graph is the actual
   hosted behavior.

## Implemented task-model pass

The refactor following this audit keeps the publication graph and carrier bytes
unchanged while changing task ownership:

- Release products no longer expose `check`, `test`, or `release-check`.
  Product-facing tasks now use `format-check`, `lint`, `compile`, `unit`,
  `package`, behavior-specific names, and `qualify`.
- `package` is independent of format/static/unit work. Producer tasks no longer
  depend on quality tasks merely to gate them; affected CI schedules those
  proofs independently.
- CI's existing check/test matrices now collect both legacy repository-tooling
  tasks and the semantic product task IDs, so the rename does not drop hosted
  coverage.
- Node Direct and WASIX N-API no longer rerun their complete static/unit gate
  from `package`. WASIX N-API formatting, compilation, unit behavior, and
  workspace package shape have separate owners.
- The native runtime's patch validation and nine unit helpers are separate;
  one `unit` aggregate owns the helper suite so affected CI does not select both
  the aggregate and every leaf independently.
- The duplicate extension-model executions in both artifact projects are gone.
  Exact external and contrib projects retain their source/release identities but
  no longer expose identical leaf `package` wrappers; shared native, WASIX, and
  carrier projects own the actual work.
- Generic Moon `release-check` tasks and one-dependency aliases are gone.
  The repository-wide `tools/release/release-check.mjs` executable remains, but
  is documented as release-policy validation rather than a product gate.
- Rust package qualification no longer greps test-function names to claim
  coverage. The actual unit/smoke/regression tasks retain those behavior proofs.
- The qualification guide now selects release policy, committed-asset, and
  extension-model gates independently instead of prescribing all three for any
  version/package/workflow/extension edit. Its nonexistent `graph-tools`
  commands and sole-writer claim were removed.

### Extension boundary decision

| Boundary | Verified machinery | Decision |
| --- | --- | --- |
| PostgreSQL contrib | One 32-member `oliphaunt-extension-contrib-pg18` bundle; versioning is `runtime-bound`; native carriers belong to `liboliphaunt-native`, WASIX carriers to `liboliphaunt-wasix`; it is not one of the 20 independently versioned publication products. | Keep the bundle descriptor because it owns membership, target selection, licenses, checksums, and carrier manifests. It needs no leaf Moon task: the two runtime builders and shared carrier assembler consume it directly. Do not add versions, changelogs, releases, or tasks per contrib member. |
| Seven external extensions | Each has one `upstream-bound` version/source identity. Every product declares seven native targets and one WASIX portable target; registry carriers are separately named for native, WASIX, and (where applicable) host AOT. Shared native and WASIX builders already produce different bytes. | Keep one logical product/version per upstream extension and the existing separate artifact families, but no identical leaf `package` wrapper. Split the product identity only if native and WASIX begin using different upstream sources or versions. |

### Coverage-loss ledger

| Proof or behavior | Before | After | Loss |
| --- | --- | --- | --- |
| Native patch/source policy | Hidden in `liboliphaunt-native:check` | `liboliphaunt-native:lint` | None |
| Native helper behavior | Nine leaves also pulled through `check` | One `unit` aggregate owns the same nine commands | None |
| Node Direct metadata/C++ syntax/classifier/package shape | Static work executed once directly and again inside package | `compile`, `unit`, and `package` each execute their own command once | None |
| WASIX N-API format/metadata/compile/JS+Rust unit/package shape | All work in `check`, then repeated by `package` | `format-check`, `compile`, `unit`, and `package` | None |
| SDK source, unit, and carrier checks | `package` pulled `check`/`test`; producers pulled `package` | Independent `compile`, `unit`, and `package`; artifact producers retain only `package` edges where they consume staged output | None; an intentionally narrow local `package` command now does package work only |
| Extension catalog/model | Model command executed by three tasks | `extensions:lint` is the single model owner; `extensions:unit` owns its parser/component tests | None |
| External extension native/WASIX artifacts | Seven identical leaf wrappers called the shared assembler | Leaf wrappers deleted; shared native/WASIX builders and `extension-packages:package` remain selected from source changes | None; chaos tests prove both families and the shared package job remain reachable |
| Contrib membership and carriers | One runtime-bound bundle plus two runtime owners | Taskless bundle descriptor consumed directly by the two runtime builders and shared carrier assembler | None; no independent contrib product or command existed |
| Release aliases | Multiple `true`/exact-command `release-check` aliases | Underlying commands retained under their semantic owner or `qualify` aggregate | None |
| Rust source/test-name greps | Asserted that selected spellings existed | Deleted; actual unit/smoke/regression execution remains | Only the implementation-spelling assertion, not behavior coverage |
| Postmaster build/recovery ordering | Carrier, stress, recovery, then release packaging | Unchanged | None |

Residual work is deliberately not hidden: Kotlin's static wrapper still combines
formatting, lint, compilation, and publication-shape checks; JS/Kotlin/React
Native `regression` names still describe mostly package/static replay; WASIX
TypeScript has a wide host/browser matrix; release-policy mutation discovery is
still dynamic. These are the next value-ranked cuts, not behavior removed by
this pass.

### Qualification results

- Product task-contract test: passed for every `release-product` Moon project.
- Node Direct `compile`, `unit`, and `package`: passed independently.
- WASIX N-API `format-check`, `compile`, `unit`, and `package`: passed independently.
- Extension model `lint` and `unit`: passed.
- Workflow lint/security, CI matrix, affected-plan, Postmaster release-selection,
  and bootstrap fail-closed suites: passed.
- Shell syntax, typo scan, and `git diff --check`: passed.

No registry publication, hosted mobile E2E, or multi-platform release build was
run locally. Those commands require release artifacts or hosted platform
runners; their selection and dependency graphs were validated without changing
their executable commands.

## Node-product graph chaos pass

The follow-up chaos pass injected representative changed-file lists into
Moon's real `query affected stdin` path, fed the resulting direct tasks into the
CI planner, and independently evaluated the release graph. No source file was
modified merely to simulate a change.

Timing estimates use successful main run
[33366730487](https://github.com/f0rr0/oliphaunt/actions/runs/33366730487)
at `b8cab0be2b86c6b9fab4c279add89113c5797d23`. They are planning ranges,
not SLAs: runner allocation, cache state, and GitHub load remain variable.

| Injected PR change | Corrected CI build closure | Release closure | Predicted hosted cost |
| --- | --- | --- | --- |
| `src/sdks/js/src/client.ts` | JS SDK package plus affected compile/unit/policy lanes. No Node Direct addon. | `oliphaunt-js` | 4–8 min wall, roughly 10–18 runner-minutes. Focused local compile/unit/package/artifact staging completed in 13 seconds. |
| `src/runtimes/node-direct/native/node-addon/oliphaunt_node.cc` | Four Node Direct targets, their aggregate, downstream JS SDK package, and affected checks/tests. | `oliphaunt-node-direct`, then `oliphaunt-js` | 6–10 min wall, roughly 20–30 runner-minutes. Historical addon targets took 1:34–4:11 each and 9:42 in aggregate runner time. |
| `src/runtimes/wasix-napi/src/lib.rs` | Portable WASIX runtime, four target AOT builds, WASIX extension artifacts, four N-API targets, aggregate, downstream WASIX TypeScript carrier smoke, and affected checks/tests. No native extension/runtime/package closure. | `oliphaunt-wasix-napi`, then `oliphaunt-wasix-ts` | 88–100 min wall, roughly 155–185 runner-minutes. The dominant historical chain was 39:15 portable + 24:46 slowest AOT + 10:45 slowest N-API + 10:43 TypeScript carrier. |
| WASIX N-API root README or isolated unit fixture | Affected static/unit lanes only; no artifact builder. | Metadata/release intent still decides whether prose warrants a version. | 3–7 min wall; zero artifact-builder minutes. |
| Combined JS SDK + WASIX N-API source change | Union of the two real closures; still no Node Direct or native-extension avalanche. | `oliphaunt-js`, `oliphaunt-wasix-napi`, `oliphaunt-wasix-ts` | N-API remains the critical path, so approximately 88–100 min wall. |

### Chaos findings and changes

| Finding | Root cause | Change | Coverage effect |
| --- | --- | --- | --- |
| JS SDK source rebuilt all four Node Direct addons. | Node Direct producer inputs named JS SDK source even though `build-node-addon.sh` never reads it. | Removed the reverse JS SDK inputs from Node Direct package, producer, and aggregate tasks. | None; Node Direct source still selects downstream JS qualification. |
| WASIX N-API escalated to all native runtimes, native extensions, and extension carriers. | The planner treated an artifact producer implied as an N-API input as though that producer itself changed. | Planner implications now distinguish directly selected jobs from input-only implied jobs. Direct extension changes still build packages; N-API consumes only WASIX artifacts. | None; every file consumed by N-API remains in the plan. Approximately 370 unrelated historical runner-minutes are avoided per N-API source PR. |
| Clean SDK artifact jobs could fail after the first task-model refactor. | Five artifact builders consume staging files written by their product `package` task; those real data dependencies had been removed with quality dependencies. | Restored `package-artifacts -> package` for JS, React Native, Rust, Swift, and WASIX Rust. Added a graph invariant for all five. | Restores required package output; no quality gate was reattached. |
| Every product source edit selected the then-165-file release mutation suite, and macOS replayed metadata plus the same suite. | Metadata validation and release-tool unit tests shared one `release-tools:check` command and broad `src/**/*` inputs. | Split Moon ownership into `release-tools:metadata`, 152 release-owned tests, and 11 policy-owned tests; three workflow/planner suites remain solely under `ci-workflows:check`. The macOS publication-host job now runs metadata only, while the local exact aggregate retains all three gates. | No release proof removed; each test file has one affected owner and exact release checks still compose the complete set. |
| Policy formatting and workflow-only edits still selected release mutation tests after the first split. | Metadata and release-unit inputs still broadly named all policy and GitHub files. | Metadata no longer names policy files it does not import; release unit names `.github/scripts` rather than workflows/actions. A durable chaos case proves policy/workflow files exclude `release-tools:unit`, while a release helper includes it. | None; workflow structure still selects metadata and workflow checks, and release helper changes still select all release-owned tests. |
| Expanding CI to ten semantic task IDs made affected-matrix planning query Moon about 20 times. | The writer invoked a one-use selector subprocess and then repeated the same task query for every ID, despite already loading the complete affected map. | Filter the single affected map in memory, retain one complete map for capability closure, and delete the unused selector wrapper. The real all-task matrix now resolves with two Moon queries in 6.3s. | None; the existing delayed-output/fail-closed tests and the real 25-static/23-unit all-task matrix passed. |
| `native-tools-proof:unit` appeared in both static Checks and Tests. | The root static `repo:check` aggregate depended on a unit task while CI also selected semantic units directly. | Remove the unit edge from the static aggregate; the unit remains in the Tests matrix. | None; one execution replaces two. |
| N-API prose and isolated unit-test edits launched the complete artifact chain. | Both producer and aggregate tasks used the whole product directory as an input. | Narrowed N-API producer inputs to files actually read by compilation, packaging, and packed-addon smoke. A directly selected producer now explicitly selects aggregation. | Production source and packed-smoke changes still build all carriers; prose/unit-only changes keep static/unit proof. |
| N-API source changes released WASIX TypeScript without testing its packed downstream carrier. | The release graph declared the compatibility edge, but the CI planner used only direct artifact tasks. | A directly selected N-API producer/aggregate now selects `wasix-ts-sdk-package`, which consumes the same-run N-API artifacts and runs its packed host/browser smokes. | Adds real downstream consumer proof and aligns PR CI with the release closure. |
| A product-local `release.toml` selected unrelated SDK, broker, and addon builders; the central release manifest selected almost every artifact producer. | Product behavior/build inputs named global release bookkeeping that their commands never read. | Removed central and unrelated release metadata from product compile/unit/package/benchmark inputs. Product-local release metadata still selects its own carrier, while `.release-please-manifest.json` now selects metadata/graph proof without rebuilding artifacts. | None; release metadata validation and the release dependency graph remain selected, and chaos cases prove the intended product carrier remains reachable. |
| The macOS release-metadata job ran on every PR and executed the full mutation suite. | The job was unconditional and called the overloaded `release-check.mjs`. | The job now runs the metadata-only entrypoint and only when the affected matrix selects `release-tools:metadata`. Push/main and manual all-task runs still require it. | None; all seven metadata stages passed under a traced real execution, and mutation tests retain their Linux owners. |
| The focused graph task invalidated itself and also ran beside the full release suite. | Its `/.moon/**/*` input captured `.moon/cache`, while `/tools/release/**/*` captured every release mutation helper and test. | Limited Moon inputs to configuration files and listed the focused test import/read closure. A release-helper chaos case now rejects duplicate `graph-unit` selection. | None; 27 focused tests pass, and an immediate rerun uses the same cache key. |
| Policy syntax validation spent over a minute launching one Bun build per module, while editing its formatter also selected the 11-file policy mutation suite. | The syntax task treated 129 independent inputs as 129 processes, and the unit input glob included two unrelated task wrappers. | Compile the same module set in one Bun invocation, restrict it to script families it actually parses, and exclude the formatter/syntax wrapper from policy-unit selection. | None; all 129 modules plus shell and Python syntax pass in 1.4s, and a chaos case proves formatter edits retain syntax/format proof without mutation tests. |
| Cached docs smoke claimed its consumed build tree as its own output; docs build and WASIX TypeScript carrier assembly hid quality/smoke prerequisites. | Read-only proof and producer tasks mixed consumed data with owned output or quality ordering. | `docs:build` now runs independently, `docs:smoke` consumes but does not claim the build output, and WASIX TypeScript carrier assembly no longer depends on three smokes that hosted CI already runs explicitly. Added a whole-graph invariant rejecting cached input/output identity and hidden quality gates on non-aggregate producers. | None; independent docs build produced 139 pages, smoke found 49 HTML files and cached stably, and hosted WASIX TypeScript still explicitly executes its complete host/browser smoke list. |

The executable behavior of builders, smoke tests, package validation, release
locks, and publication was not weakened. The only changed release orchestration
is ownership: ordinary product PRs no longer run release-tool mutation tests,
while release candidates still run `release-check.mjs` in full.

Chaos qualification passed: 19 injected graph scenarios, the product task/data
dependency invariant, release-gate mode tests, Postmaster planner regressions,
workflow lint/security, and bootstrap fail-closed tests. The split metadata gate
passed in 37 seconds locally; policy-owned tests passed in 28 seconds and all
152 release-owned files passed in 4m57s. JS compile, 72 units, package shape,
and artifact staging passed together. No multi-platform artifact build was
executed locally.

Actual releases remain deliberately exhaustive: merge-to-main still expands to
the all-product graph, historically about 900 raw runner-minutes and roughly
100–130 minutes wall-clock before the repeated release-workflow gates. This
chaos pass did not narrow that release safety policy; doing so safely requires
making exact-SHA qualification artifacts reusable by candidate assembly and
publish.

Ponytail estimate at that stage: approximately **1,000 task/workflow/wrapper
lines** and **0 external dependencies** could be removed conservatively. The
follow-up below performs the largest low-risk deletion inside `xtask`.

## Whole-graph, cache, source-assertion, and `xtask` follow-up

### Final verdict

The package graph itself is now internally consistent; the remaining large
cost is primarily **selection policy**, not missing dependency edges. Expensive
runtime builds are justified when their production inputs change. They are not
justified for prose, isolated unit fixtures, unrelated tools, or repeated
release phases. Moon's local cache works, but hosted CI does not preserve the
Moon task cache across jobs or runs.

### Dependency graph

Moon resolves **52 projects with 117 project edges** and **232 tasks across 35
task-owning projects with 158 task edges**. Project edges comprise 32
production relationships, 84 build/compatibility relationships, and one
development relationship.

Task edges now have an executable invariant:

| Edge kind | Count | Required meaning | Result |
| --- | ---: | --- | --- |
| `hash` | 46 | Consumer identity includes a producer with declared outputs | All producers declare outputs |
| `outputs` | 11 | Consumer hydrates a producer's declared outputs | All producers declare outputs |
| `ignored` | 101 | Ordering/qualification only; no artifact data is consumed | No producer declares outputs |

`product-task-model.test.mjs` now checks this for the entire task graph, the five
SDK carrier tasks that consume product package staging, and the absence of
`src/ -> tools/` project edges. Moon itself rejects missing targets and cycles
while constructing the graph.

Cross-product judgments:

- External extensions correctly remain one version/source product each with
  distinct native and WASIX artifact/carrier families. Their taskless leaf Moon
  projects carry identity/affected-source ownership; shared projects do the
  builds and packaging.
- Contrib remains runtime-bound and is built into native/WASIX runtime products;
  it needs no independent package task or release.
- WASIX AOT consumes portable WASM, mobile E2E consumes mobile builds, and the
  Postmaster stages consume their predecessor outputs through data edges.
- GitHub artifact aggregators intentionally do not depend on local Moon
  producers: the workflow downloads exact-SHA artifacts from other jobs. Adding
  Moon producer edges would rebuild the same expensive artifacts, especially
  because those jobs run with `MOON_CACHE=off`.
- Release ordering uses production/peer relationships; build-scope compatibility
  does not create a release cycle. In particular, Rust records broker
  compatibility without adding the reverse Moon edge that would cycle through
  `broker -> rust`.

### Are the minutes justified?

| Work | Measured/predicted cost | Judgment |
| --- | --- | --- |
| `xtask:unit` | 4.9 s cold after dependency compilation; 65 ms cached. Final 44-test run: 2.9 s incremental. | Justified and previously missing from declared CI. |
| `xtask:compile-aot-serializer` | 37.7 s cold; 45 ms cached; 2.6 s incremental after source edits. | Justified only because it compiles the release-only Wasmer/LLVM feature path. The cost is seconds, not the reported product-build minutes. |
| Small cached contract task | 2.18 s cold; 62 ms cached. | Confirms hashing and local cache hydration work. |
| `perf-tools:unit` | 49 s to compile its Rust API model cold; 168 ms for the fully cached two-task closure. | Justified: retained checks execute plans, output contracts, no-build behavior, provenance, and mobile probes instead of inspecting source spelling. |
| WASIX N-API production source closure | About 88–100 min wall / 155–185 runner-minutes. | The portable runtime, AOT, N-API carriers, extensions, and downstream packed TypeScript smoke are real behavior. The minutes are justified for production source, not prose/unit-only changes. |
| Unrelated `main` push | Historically about 900 runner-minutes. | Not justified. This is the still-exhaustive non-PR selection policy, not a dependency requirement. |
| Release PR + qualification + dry run + publish | Repeats assembly and policy work across phases. | Exact-SHA qualification is justified once; repeated unit/policy/assembly work is not. Reusing an approved immutable candidate remains the next large saving. |

### Moon cache audit

The workspace enables a seven-day cache lifetime plus CAS output caching,
native hashing, and asynchronous graph/affected tracking. Current task policy
is 121 cached, 29 local-only, and 82 uncached tasks. A 17-task global static run
took 58.7 seconds after the graph edits; the identical rerun hydrated all 17
from Moon's cache in 584 ms.

One focused task initially defeated that policy: `release-tools:graph-unit`
used `/.moon/**/*`, so its own `.moon/cache` writes changed its next hash. The
input is now limited to `.moon/tasks`, `toolchains.yml`, and `workspace.yml`.
After the fix its 27-test run took 24.6 seconds and the immediate identical run
was cached in 105 ms under the same hash.

Hosted CI restores verified Moon/tool archives and Cargo caches, but it does
not restore `.moon/cache`, configure a Moon remote cache, or persist task
outputs between jobs. Thirty heavy workflow invocations explicitly use
`MOON_CACHE=off`. This means “Moon caching exists” is true locally and false as
a cross-job/cross-run hosted claim.

That is not the primary cause of the largest bills: the expensive artifact
jobs deliberately bypass Moon output caching for exact build/packaging
boundaries. Add a hosted/remote cache first for deterministic static/unit tasks
only, after defining trust, eviction, and matrix-key ownership. Do not push
multi-gigabyte platform/release outputs into a generic GitHub cache merely to
claim caching. Moon documents that task hashes use declared inputs, output
hydration requires declared outputs, and CI cache persistence must be configured
explicitly: [project/task cache configuration](https://moonrepo.dev/docs/config/project),
[task inputs and outputs](https://moonrepo.dev/docs/create-task),
[local cache behavior](https://moonrepo.dev/docs/concepts/cache), and
[CI/remote-cache setup](https://moonrepo.dev/docs/guides/ci).

### Source-string assertion cleanup

More than **1,800 lines** of positive source-spelling assertions were deleted.
These checks proved that an implementation contained a particular comment,
identifier, statement order, or exact line, rather than proving behavior.

Removed:

- 140 lines of `grep` assertions over patched Wasmer/Wasmer-JS/WASIX source in
  the TypeScript host build;
- 21 lines asserting Postmaster shell-source ordering/printing/cleanup spelling;
- the large PostgreSQL patch/source marker matrix, patch email-header/slug
  policy, and applied-source performance-marker checks in `xtask`;
- positive marker checks over WASIX build scripts where shell syntax, actual
  builds, manifests, ABI harnesses, and runtime tests are the real proof; and
- 260 lines in the native performance harness that inspected Moon files,
  scripts, Rust/JS source, and documentation instead of executing their
  contracts; its generated-plan assertions and real no-build/provenance/mobile
  probes remain; and
- native platform builder marker scans used as patch-state detection. Android,
  iOS, and Linux now trust the input hash plus fail-closed `git apply`; macOS
  invalidates its whole managed generation when the patch/input hash changes
  and applies patches only to a fresh unstamped source tree;
- one AOT unit test that duplicated exact hashes/byte counts already owned by
  the production target specification.

Retained:

- exact source URLs, versions, SHA-256 pins, patch-series membership, safe paths,
  no duplicates/orphans, patch application, and prepared-source fingerprints;
- shell parsing and compiled C ABI harnesses;
- forbidden legacy ABI and unsafe `--disable-spinlocks` policy checks;
- actual runtime/AOT export surfaces, archive contents, checksums, manifests,
  package installation, smoke, regression, and E2E behavior.

Coverage loss is limited to **early source-only diagnosis**: a semantically bad
patch may now fail at patch application, compilation, artifact validation, or
runtime qualification instead of failing earlier because a chosen text snippet
changed. No product behavior became untested in the aggregate.

The native patch-state change also fixes a correctness hole: the old macOS
marker list could accept a stale prepared tree after a patch changed without
changing one of the selected marker strings. The existing generation hash now
owns that decision.

### `xtask` decision and changes

`xtask` fell from roughly 14,800 to **13,364 Rust lines**. It is still large,
but most remaining code performs real WASIX source acquisition, deterministic
asset construction, extension modeling, AOT serialization, cluster-seed work,
or release staging.

Changes made:

- Moon `check` became `unit` and now runs all 44 default-feature tests; the old
  configuration compiled the binary but silently skipped them.
- `release-check` became `compile-aot-serializer`; it now says exactly what it
  proves.
- Removed unused `release dry-run` and `release publish`. The latter always
  stopped with an error after staging and never published anything.
- Removed `package-size` from `xtask` and from `assets release-build`. The
  generic asset build no longer packages every Cargo workspace crate.
  `repo:package` and each real carrier packaging lane retain size enforcement.
- Kept `release stage`/`package-assets`, extension catalog generation, asset
  commands, and feature-gated runner/AOT code because they have live callers.

Do not move the remaining crate wholesale merely to make the directory tree
look purer; that changes paths and caches without reducing work. The later
product-boundary audit supersedes the earlier decision to leave its ownership
unchanged: delete redundant wrappers, keep WASIX build behavior with the WASIX
runtime, and keep repository release orchestration at the root. Split only at
those real ownership boundaries, not into another generic support project.

### Change/qualification ledger

Focused qualification completed:

- `xtask:unit`: 44 passed;
- `xtask:compile-aot-serializer`: passed;
- `xtask assets check`: passed in source-only mode, including shell syntax and
  compiled bridge ABI validation;
- full Postmaster compile and unit suite: passed in 2m38s;
- 19 injected Node/JS/WASIX N-API/Postmaster/extension/ownership chaos scenarios: passed;
- semantic release-product and whole-task-edge invariants: passed;
- `perf-tools:unit`: passed, including Rust API-model behavior and the retained
  plan/output/no-build/provenance/mobile probes;
- native patch-stack lint and shell syntax for all edited platform builders:
  passed;
- full workflow policy (actionlint, zizmor, workflow security, CI selection,
  and pinned-tool bootstrap tests): passed in 3m08s; the final 19-case planner
  suite passed independently in 59s after adding the ownership regression;
- release metadata passed in 37s, 11 policy-owned tests passed in 28s, and all
  152 release-owned mutation-test files passed in 4m57s;
- Node Direct, WASIX N-API, broker, native/WASIX runtimes, extension model,
  Rust/WASIX Rust, JS, React Native, Swift, Kotlin, and WASIX TypeScript
  compile/unit/package boundaries passed in representative local execution;
- the 17-task global static selector passed, then was fully cached on an
  identical rerun; docs check/build/smoke passed for 44 routes, 139 generated
  pages, and 49 HTML files; and
- Cargo formatting and Git diff whitespace validation: passed.

Linux qualification cannot execute the Darwin, Android, or iOS builds. Those
platform builders retain their existing hosted build coverage; this refactor
was locally proven through syntax, patch-stack integrity, hash-ownership review,
and the Linux-executable no-build paths. This is the only residual validation
gap introduced by the local environment, not a newly untested release behavior.

The local filesystem initially filled while compiling the new unit target. To
continue qualification, only reproducible build outputs were removed:
`target/moon/xtask/unit` from the failed attempt and 3.3 GiB under
`target/moon/oliphaunt-wasix-napi`. They are recoverable by rebuilding; no
source or user-authored data was removed.

Repository placement and naming were audited separately in
[`REPOSITORY_ORGANIZATION_AUDIT_2026-09-03.md`](REPOSITORY_ORGANIZATION_AUDIT_2026-09-03.md).

## Final resolved-Moon-graph audit

This pass inspected Moon's resolved project, task, affected, and action graphs
rather than treating YAML declarations as the graph.

- Removed 31 false `docs -> product` and `release-tools -> product` build
  declarations. Those tasks read declared source/metadata inputs; they do not
  consume built product artifacts. Moon infers the two real docs workspace
  dependencies from `package.json`.
- Removed explicit Cargo/PNPM edges already inferred by Moon, including
  `broker -> rust`, `native-packaging -> rust`, and the docs' workspace
  packages. A resolved-graph invariant now rejects duplicate and self edges.
- Corrected contrib ownership direction: native and WASIX runtimes depend on
  the bundled PostgreSQL contrib definition; contrib no longer pretends to
  depend on its two owners.
- Corrected the stale planner identity `extension-contrib-postgres18` to the
  real Moon ID `oliphaunt-extension-contrib-pg18`, centralized both extension
  project sets, and added a test that every planner selector resolves.
- Reclassified the taskless extension catalog from `tool` to `configuration`.
- Removed command capture, Moon command resolution, fd-backed test spawning,
  and release-directory safety from global task inputs. Their changes now
  affect 32, 15, 17, and 61 tasks instead of invalidating the whole workspace.
  Release-directory safety remains on every importing package/runtime task.
  The root Bun launcher is no longer universal: it affects only the 20 tasks
  in 13 projects that actually execute it, rather than all 232 resolved tasks.
- Fixed the WASIX Rust package-closure proof exposed by hosted CI. Workspace
  path dependencies remain unconstrained for local head-to-head development,
  while the proof now checks the packaged crate's exact runtime pins against
  those local dependency versions.
- Replaced repeated workspace manifests, legal files, release helper sets,
  local source roots, and existing dependency source roots with six shared
  file groups, `**/*`, and Moon project inputs. Raw input entries fell from
  3,172 to 2,744 and hard-coded whole-project paths from 518 to 196. Every
  resolved task `inputFiles` and `inputGlobs` set was byte-for-byte unchanged
  at that checkpoint; the final root-tool cleanup then deliberately narrowed
  the launcher input and relocated the shared extension archive policy.
  Promoting the remaining task-scoped cross-project reads would add 103 false
  project-wide dependencies, including 10 graph cycles.
- Upgraded the verified Moon CLI from 2.3.2 to 2.5.4, its official JavaScript,
  Node, PNPM, and Rust plugins to the matching current OCI digests, and Proto
  from 0.57.4 to 0.61.3. Nested graph queries now use the verified `MOON_BIN`
  and discard Moon-injected `PROTO_*` overrides, avoiding accidental fallback
  to a developer's global Moon/Proto installation.
- Publishable JavaScript package manifests no longer reach into repository
  `tools/`: native Node filesystem cleanup and direct Vitest commands replaced
  two shared wrappers, which were deleted. Shared extension archive policy was
  moved to `src/shared/extension-runtime-contract`. Product-local `tools/`
  directories remain part of their products. However, the subsequent
  executable-boundary audit found many product Moon tasks and product-local
  helpers still invoking root `tools/`. The resolved graph's zero semantic
  `src/ -> tools/` project edges therefore proved only that these dependencies
  were hidden, not absent. That earlier conclusion was too strong and is being
  corrected below.
- Reclassifying build-recipe edges exposed one planner bug: source changes to
  build inputs stopped at build-scoped edges. Release selection now traverses
  every non-development edge until the first independently versioned product,
  preserving independent downstream SDK versions while still releasing the
  runtime produced from a changed build recipe.
- Hosted qualification caught two boundary mistakes before merge. The eight
  WASIX Node-API extension carrier edges remain production dependencies because
  they ship with that runtime; only source/build recipes use build scope. The
  isolated JS and React Native harnesses now invoke their mandatory `test`
  scripts without pnpm's misplaced `--if-present` flag.

No task dependency, artifact hydration edge, release boundary, or behavior
proof was removed. The final focused qualification passed 17 resolved-graph
tests, the policy/static/format suite, all 22 affected-selection chaos tests,
workflow security, actionlint, zizmor, 12 pinned-tool bootstrap tests, and the
full offline WASIX Rust package test closure. A final combined run of graph,
workflow, policy, and all release-tool unit tests passed in 4m53s; all four
JavaScript package builds and 431 unit tests, React Native workspace staging,
native-packaging unit tests, and Kotlin Gradle resource processing also passed.
An unchanged 5.31s graph-unit result was then restored from Moon's local cache
in 132ms, proving the upgraded cache path is active.

The existing `oliphaunt-js` coverage threshold remains a recorded issue:
both the old wrapper-equivalent invocation and direct Vitest coverage report
77.96% against the configured 80% line floor. This refactor did not lower the
threshold or conceal that pre-existing failure.

## Product task ownership correction (2026-09-04)

Principle: a product owns small, ecosystem-native build, test, and package
interfaces. Coverage, benchmarking, repository policy, cross-target assembly,
and publishing are consumers of product outputs; a product must not call back
into those root concerns. Shared implementation belongs only to a real product
or library contract, never to a generic `src/build` or per-product copy.

Implemented first because behavior could be preserved exactly:

- moved the seven measured coverage targets from product projects to
  `coverage-tools:<product>` and removed the five product `check-sdk.sh`
  coverage dispatch modes. The coverage runner still calls Cargo llvm-cov,
  SwiftPM, Gradle Kover, and Vitest directly and owns the same report outputs;
- deleted the duplicated Rust/JavaScript native, Swift/Kotlin/React Native
  mobile, native-runtime, and WASIX product benchmark aliases. The surviving
  entry points are explicit `perf-tools:native-plan`, `native-measure`,
  `mobile-plan`, `mobile-measure`, `wasix-plan`, `wasix-node-measure`, and
  `wasix-browser-measure` tasks;
- removed the root `repo:bench`/`repo:bench-run` duplicates. They obscured which
  runtime was measured and repeated commands already owned by `perf-tools`;
- deleted `tools/policy/check-coverage.sh`. It asserted literal strings in Moon
  YAML rather than coverage behavior. `repo:coverage-policy` now directly runs
  the existing semantic TOML validator.

The resolved task count fell from 232 to **222** with no coverage runner,
benchmark harness, threshold, or output contract removed. Local proof passed
all three benchmark plans, coverage-tool self-checks, the semantic coverage
policy, repository tooling checks, and a full resolved-Moon configuration
query. Measured runs remain deliberately local and uncached; this pass did not
pretend to reproduce device- or host-specific measurements.

### Product boundary simplification and adversarial proof

The second ownership pass applied a stricter rule: product ownership permits a
small native `compile`, `unit`, and `package` command, not a product-specific CI
framework. Repository policy, cross-product integration, performance,
coverage, release assembly, and registry checks stay outside the product.

Changes:

- deleted the five SDK `check-sdk.sh` dispatchers, the native `check-track.sh`,
  the broker/Node Direct/WASIX Node-API package dispatchers, three WASIX Rust
  check dispatchers, the React Native runner source-assertion tests, and the
  925-line performance source-string harness;
- replaced those dispatchers with ecosystem commands in Moon. The only new
  product helpers stage package-manager source where a workspace package is not
  itself publishable; they use Cargo or `package.json.files` as the inventory
  instead of maintaining a parallel source-file list;
- moved installed-app and cross-product JavaScript behavior to
  `integration-examples`, and moved registry/release artifact assembly to
  `release-tools`. Product `package` tasks now produce their own source package;
  release tasks consume that output instead of hiding release policy inside the
  product;
- split the WASIX TypeScript tools package into the real
  `oliphaunt-wasix-tools-ts` product rather than exposing its lifecycle through
  the main binding; and
- removed the 232-line native runtime lock wrapper after the direct commands
  proved not to share mutable test state. It had been moved into the product
  during the first pass, which changed its address without reducing the
  machinery.

Adversarial execution found two correctness bugs:

1. Moon multiline `script` tasks continued after a failed intermediate
   command. Every multiline task now starts with `set -e`; no later success can
   conceal an earlier compiler or test failure.
2. The WASIX Rust `unit` task enabled runtime/extension features and then failed
   five tests when generated runtime artifacts were absent. Before the
   fail-fast fix those failures were reported as a successful task. Source unit
   now runs the 192 artifact-independent library tests plus public API,
   documentation, and compile-only runtime/client suites. Actual generated
   runtime behavior remains in the WASIX runtime smoke/regression and release
   boundaries.

The React Native unit boundary now includes its iOS staging behavior; the prior
standalone task was not part of `qualify`. Real product behavior was retained.
Removed checks asserted source spelling, wrapper dispatch, or configuration
text; no runtime, package-install, archive-content, ABI, extension, or registry
contract was removed.

Moon 2.5 `options.internal` now hides 25 native/Postmaster/source-fetch implementation
phases while preserving them as resolved dependencies. The public surface is
**176 tasks** and the complete dependency graph is **201 tasks**. This is a UI
and ownership reduction, not omitted execution.

Local proof:

- 30 SDK, binding, and add-on compile/unit/package tasks passed in 21.9s; an
  identical run restored all 30 from Moon cache in 556ms;
- 19 product-edge/affected-selection tests, 17 release graph tests, three
  performance plans, integration examples, documentation, policy tests, and
  workflow/action security all passed;
- all four directly changed Rust/WASIX source-package tasks passed and were
  restored from cache in 212ms; and
- the complete release mutation suite passed in 4m56s.

One local reproducibility defect was fixed while exercising the real portable
WASIX release dependency. `source-inputs:source-fetch-*` used to report success
while deliberately doing nothing outside CI, leaving the consumer to fail later
with a missing checkout. An explicit Moon source-fetch task now passes
`--force`, so it actually materializes or verifies its declared source output
on every host.

The final boundary review found and removed two remaining disguises:

- Node Direct's package-local `build-node-addon.sh` was actually a 383-line
  release pipeline: it compiled two addons, ran lifecycle behavior, built
  archives and optional npm packages, wrote checksums, and applied release
  policy. It now lives in `release-tools` as
  `package-node-direct-runtime.sh`; the private package no longer advertises it
  as a normal `build` script. The product exposes only its direct native source
  compile and cleanup-path unit check, while the real compiled-addon lifecycle
  proof remains part of release artifact validation.
- Kotlin release packaging used to invoke Gradle a second time after the
  product `package` task. The product task now publishes the exact AAR, plugin
  JAR, POM, and metadata set into a Moon output directory once. Release tooling
  depends on that output and only validates and stages it. An uncached local
  run completed the producer in 1.6s with warm Gradle state and the release
  validator/stager in 3.0s; no second SDK build remains.
- The WASIX TypeScript binding and its tools package likewise already emitted
  release-contract-valid npm tarballs, but release staging rebuilt both. It now
  copies and validates the product outputs. A direct release staging run took
  1.9s after the product package tasks completed.

The obsolete CI-plan `coverage_job_products` projection was also deleted. No
workflow or caller consumed it, and moving coverage to explicit
`coverage-tools:<product>` tasks had left it permanently empty.

The wall-clock audit found one unjustified graph override: any change anywhere
under the `ci-workflows` project forced every artifact builder plus the native
extension lifecycle. That bypassed Moon's task inputs and made a four-line CI
cleanup look like a whole-product release. The override is gone. A workflow
change now selects the workflow, tooling, and release-metadata checks and zero
artifact builders; full main/manual qualification still selects every builder.
A chaos test locks that distinction.

The seven SDK release tasks also each named all of `tools/release/**` as an
input. That made a Kotlin staging-module or Node Direct validator edit rebuild
every SDK package. The blanket inputs are now limited to the existing shared
archive/target contracts and each task's actual entrypoint and product module.
Chaos queries now map the Kotlin module only to Kotlin package plus Maven
staging, and the Node Direct validator only to Node Direct build plus aggregate
validation. Shared npm-source and Cargo-source helpers invalidate only their
real product families.

The forced producer/stager replay then caught a Swift archive-mode regression:
`swift package archive-source` preserved the checkout's group-writable legal
files, but the release contract requires portable `0644` notice members. The
Swift package producer now normalizes those two modes before archiving. SDK
release tasks also no longer hash an entire product tree in addition to their
declared package-output dependency; this removed Moon warnings from SwiftPM's
derived `.build` symlinks and avoids redundant invalidation. Swift and React
Native release staging now default their carrier input to the same canonical
target path used by CI, while retaining CI overrides for downloaded
cross-runner artifacts.

The cold local `release-tools:wasix-ts-sdk-package` path then passed end to end
in 39m36s. The portable runtime producer consumed 38m35s (PostgreSQL, ICU,
PostGIS, remaining extensions, and package validation); the SDK staging plus
real packed browser/database/tools smoke consumed 57s. This establishes both
the true cold upper bound and where the cost belongs: runtime-affecting changes,
not ordinary SDK, documentation, policy, or workflow changes.

An adversarial follow-up rejected one attempted boundary fix: copying the
shared 573-line runtime preflight into product-local files only changed its
address. The native half is now a 110-line artifact-path/readiness contract;
it no longer probes ICU configuration, runs a throwaway `initdb`, inventories
extensions, audits dynamic linkage, or exposes unused Android/iOS/CLI modes
before the real smoke tests. Those smoke and regression tests remain the
behavioral proof.

That follow-up also found two React Native release-package proofs orphaned by
the deleted `check-sdk.sh` dispatcher. The 10-case extension materialization
and tamper suite now belongs to `release-tools:unit`, and the actual packed
React Native tarball again runs the ICU Expo/bare autolinking contract during
release staging. Both passed locally. This is a real correction to the earlier
claim that wrapper deletion had preserved every reachable proof.

Two more product-local meta-checkers were removed rather than relocated.
Postmaster's 141-line `check-product.sh` duplicated release metadata, searched
for retired wording, and maintained a 27-file test list. Its `lint` task now
uses the existing semantic source-lock verifier plus native shell/Python syntax
checks; `unit` discovers and runs all 29 product tests, including two the
manual list had omitted. Twenty-eight source-only tests run in `unit`; the
remaining linear-memory test needs the built memory-profile binary, so one
explicit internal integration task runs from `release-assets` instead of being
an orphan or pretending to be unit-level. Node Direct's unused 126-line
package-metadata checker was also
deleted, while its release-only pinned Node fallback installer, extractor, and
fault suite moved together to `release-tools`. WASIX Node-API release metadata
and carrier-contract tests likewise left the product unit task; the redundant
metadata spelling checker was deleted and the six-case carrier contract now
runs under release tooling. Its product unit task retains the six portable
command/libc tests and four Rust behavior tests.

Residual root-tool boundary: SDK, binding, broker, Node Direct, and WASIX
Node-API product tasks no longer invoke repository release/performance/coverage
machinery. Native, WASIX, Postmaster, extension-artifact, extension-catalog, and
source-input projects still execute root `tools/xtask` or release-contract
helpers. The source-fetch implementation itself now lives with its owner under
`src/sources/tools`; it still reuses the root process-capture and extension
license libraries. The remaining calls are pre-existing production build
machinery and were not renamed or copied into a generic `src/build`. They remain
the next real extraction boundary; the graph test is deliberately worded as a
check of Moon project-dependency metadata, not a false claim that every
executable path dependency is gone.

### Final graph and WASIX package boundary review

The final pass removed another hidden coupling without turning products into
miniature CI systems:

- Rust and JavaScript fixtures are represented by the taskless
  `shared-test-fixtures` project. Product tests use a semantic project input;
  they no longer repeat fixture file inventories in Rust source or Moon YAML.
- Cross-package WASIX TypeScript installed-package checks moved from both npm
  products to `wasix-ts-integration:runtime`. The product tasks only
  type-check, run their own unit tests, and build/package their own npm source.
  The root integration task consumes those package outputs plus the separately
  built portable and Node-API runtime carriers.
- `release-tools:wasix-ts-sdk-package` now only validates and stages release
  artifacts. Browser behavior is no longer concealed inside a task named
  `package`.
- The WASIX Node-API producer was missing the AOT runtime and WASIX extension
  package edges that its build actually reads. Those producers are now explicit
  dependencies. WASIX extension staging selects only the WASIX family, so it
  does not pull native extension builds into this path.
- CI runs the three artifact-injection stages in order: product packages,
  installed-package integration, then release assembly. This preserves the
  same-run portable/NAPI artifact downloads without asking Moon to rebuild
  upstream producers in the consumer job.
- The browser CDP client now rejects pending calls when the socket closes and
  bounds every request at 30 seconds. A browser failure can no longer hang well
  beyond the task deadline.
- Broad product-tree inputs were removed from the integration task. Producer
  task edges already carry the required artifacts; the redundant inputs made a
  WASIX NAPI README or isolated unit-fixture edit select every runtime builder.
  The existing affected-selection chaos test caught this and now passes.
- The Rust SDK's redundant `smoke` alias and its 22-line command dispatcher
  were deleted. `regression` and `extension-regression` now state their exact
  preflight and Cargo commands directly. Four unused React Native example
  `true`-command aggregates were also deleted; their Android/iOS build, device
  E2E, and release-drill tasks remain unchanged.
- Adversarial review rejected deleting the React Native runner fault tests with
  the old SDK dispatcher. Their real failure, receipt-tamper, Gradle-limit, and
  staging checks now live in one root integration task instead of the SDK's
  `unit` task. Literal runner-source assertions were removed, and the exhaustive
  509-line iOS simulator was reduced to the three contracts CI relies on:
  terminate on an app failure, accept a valid receipt, and reject a receipt
  bound to another tree. The root task passed in 27s; the untrimmed restoration
  had taken 3m19s under Moon.
- The first hosted run of commit `87078ee3` exposed a planner bug hidden by the
  local fixture: capability propagation read `moon query tasks`, which omits
  internal tasks, then failed when a public native unit task depended on an
  internal source-fetch test. It now reads Moon's complete `task-graph --json`;
  the fixture includes that exact public-to-internal edge. The generic
  `integration-tests` project was also split into bounded React Native runner
  and WASIX TypeScript integration projects, allowing the runner check to use
  Moon's standard `unit` classification and the visible label `React Native
  Runner Integration / Unit` without a planner exception. The exact hosted
  base/head matrix command and the full 2m03s workflow suite pass locally.
- The next hosted run reached the macOS metadata job and exposed one stale
  assertion: it still required every extension to be a production dependency
  of the WASIX Node-API product, even though extension artifacts are now an
  explicit dependency of the release producer that actually consumes them.
  The obsolete product-level assertion was removed. A task-graph test now locks
  the two real build inputs, `liboliphaunt-wasix:runtime-aot` and
  `release-tools:wasix-extension-packages`, without coupling the addon product
  to every extension project.
- The same run exposed a synthetic Postmaster fixture that made modules unique
  by appending arbitrary bytes after valid WebAssembly. The first byte was
  interpreted as a code-section ID, so all three release builders correctly
  rejected the malformed module. The fixture now appends a valid custom
  section; Node's WebAssembly validator accepts the generated module.
- Both React Native app builders exposed that the simplified npm package had
  dropped two generated extension manifests previously copied by the deleted
  SDK dispatcher. The package task now includes those exact generated inputs
  and places them under `src/generated`, where the Expo plugin, Android build,
  and iOS staging code already expect them. The rebuilt tarball contains both
  manifests and passes the package's selection-neutral contract check.
- `Source Inputs / Check` was still a misleading mixed suite: source acquisition,
  WASIX Docker bootstrap, and the Maestro mobile installer. It is now
  `Source Inputs / Unit` and runs only source-fetch plus PostgreSQL transport
  behavior. The WASIX project owns its two pinned builder-installer tests, and
  Maestro joins the existing CI toolchain-bootstrap suite. No test was removed;
  the three focused local runs passed in 13s, 6s, and 2.5s respectively.
- The source fetcher, archive validators, scope model, offline verifier, and
  their tests moved from the misleading root `tools/policy` directory to their
  actual `src/sources/tools` owner. Each fetch task now uses one bounded tools
  glob while excluding test-only and offline-verifier files, so adding the ZIP
  validator can no longer be omitted from its cache inputs and changing a test
  cannot rebuild runtimes. The all-source convenience task is now the explicit,
  local-only `fetch-all`; production builds use the focused internal fetch tasks.
- That move exposed a second blanket planner override: any `source-inputs` file,
  even a unit fixture, forced native extension, broker, and Rust SDK builders.
  The override is gone. A chaos proof locks zero product builders for a source
  test while a production fetcher change still reaches native, WASIX,
  Postmaster, and extension consumers through real task edges. The missing
  `wasix-postmaster` input was also added to the all-source validation/fetch
  tasks.
- The repository script compiler now uses CI's existing `tools-compile` task
  class instead of the deceptive `policy-tools:check` name. Source-fetch test
  fixtures are excluded from the separate policy mutation suite, and the local
  guide no longer advertises a nonexistent combined format-check task.
- Native implementation edits no longer invalidate `oliphaunt-broker:compile`:
  that task checks only broker/Rust SDK code and does not consume or link a
  native artifact. Runtime regressions retain the real dependency. Native and
  WASIX patch-stack lint now watches only the manifests, patches, consumers,
  and generated audit document it reads; stale extension/toolchain/`xtask`
  inputs were removed, and the previously omitted native audit document was
  added.
- Removed `sdk-contracts:doc-examples` and its script. It only matched identical
  comment IDs between README code fences and arbitrary test/source locations;
  it did not compare or execute snippets. SDK compile, unit, package, and
  runtime checks are unchanged. The obsolete marker comments were removed
  except for the separate Kotlin docs-route marker still consumed by the docs
  product checker.
- The remaining SDK contract run is warning-free under pinned Moon: prohibited
  Rust query-core mirrors use optional globs so their absence is not reported as
  a hash error, and native-boundary inputs exclude derived Swift/Gradle/Xcode
  SDK trees that the checker never reads.
- Deleted the two SDK parity compatibility shells. They only repeated
  `sdk-contracts:check` and `extensions:lint`; documentation and audit
  commands now call those cached, affected Moon owners directly.
- Replaced every bare cross-project Moon input (which means the dependency's
  entire `**/*` tree) with a named code, source, contract, fixture, runtime, or
  package surface. README and Moon-config edits no longer compile, test, cover,
  or rebuild consumers unless the task really packages that prose or topology.
- Deleted the empty `third-party-wasix` placeholder. WASIX source scopes still
  consume the real shared pins and `wasix.toml`; Postmaster keeps its separate
  private pin project. Source-fetch, runtime, and release graph tests passed.
- Merged the task-only `extension-model` pseudo-project into the real
  `extensions` catalog. Its lint now declares the evidence and generated files
  it actually reads. Build and package consumers use narrower catalog groups,
  so evidence records and package helper edits no longer masquerade as runtime
  source changes.
- Renamed the native extension `qualify` wrapper to the truthful local
  `build-host` task, removed quality gates from its build dependencies, and
  replaced its hard-coded macOS ARM default with the existing host-target
  resolver. Hosted target builds remain explicit and unchanged.
- The shared-fixture check no longer scans every JSON/properties file for an
  exact byte-for-byte copy. It still validates the canonical manifest, files,
  JSON keys, and query-response contract; product tests still consume the same
  fixtures. The only lost signal is a non-behavioral copy-placement policy.

The resolved graph is **54 projects, 195 tasks, and 154 task edges**. Twenty-eight
implementation tasks are internal, leaving **167 public tasks**. Cache policy is
115 normal, 13 local-only, and 67 uncached tasks; the latter are deliberate
hosted/runtime/release side-effect boundaries rather than missing cache flags.

Local execution evidence:

- after the input refactor, the unchanged `extensions:lint` restored from
  Moon's local cache twice in 74ms and 79ms;
- cold portable WASIX production took 20m53s; the identical follow-up restored
  the runtime from Moon's local cache in 901ms (3.6s including source
  verification);
- the independently publishable WASIX Node-API Linux carrier passed Node npm,
  Node pnpm, Bun pnpm, Deno pnpm, and Electron pnpm installed-package rehearsals
  in 3m24s after its upstream artifacts were staged;
- the two TypeScript product package tasks passed together in 9.1s, the complete
  installed Node/Bun/Deno/Electron/browser/PostGIS/tools integration passed in
  4m25s, and release artifact assembly passed in 3.8s;
- the Rust native and WASIX binding unit/package closures passed together in
  40.2s; and
- the inlined Rust SDK native regression rebuilt its declared runtime upstream
  and passed all five ABI-smoke and two SQL-regression cases in 3m07s overall
  (17.5s in the SDK task); and
- graph, workflow, documentation, tooling, performance-plan, policy, and the
  complete release mutation suite passed together in 5m06s.

One first NAPI rehearsal ended at the Electron copy with `ENOSPC`. It had
already passed Node, Bun, and Deno and was not a graph or behavior failure.
Removing two exact generated Cargo target directories recovered 13 GiB; the
unchanged rerun then passed Electron. No source, cache, or release artifact was
deleted.

No end-to-end product behavior proof was removed in this pass. The retained
integration checks exercise package installation and database behavior rather
than asserting source strings. The deliberately dropped proof surface is the
exhaustive fake iOS runner permutation set (malformed/unknown receipt fields,
every ICU mismatch direction, and repeated missing-file variants); the focused
failure/tamper test plus both hosted installed-app E2E lanes cover the operational
contract with much less test machinery. The remaining complex product-local
build helpers are retained only where they directly build that product (for
example, applying and building the pinned patched Wasmer host); moving or
copying those helpers would merely rename the same machinery.
