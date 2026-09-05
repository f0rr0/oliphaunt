# Monorepo simplification: architectural reassessment

## Recommendation

Keep Moon and the ecosystem build tools. Reduce the number of places that decide
what to build, what depends on it, and what counts as proof. Prioritize reusable
artifact boundaries and the measured critical path over directory moves or
arbitrary test deletion. The implementation below removes repeated work from
the measured critical path; hosted timing for the new graph is still pending.

This is the target architecture plus an implementation ledger. Only changes
listed under **Implemented in this branch** are complete. It supersedes the
earlier audit's blanket justification of the 67 uncached tasks and its
implication that graph invariants prove task semantics.

## Evidence and limits

Inspected on 2026-09-04: freshly fetched `origin/main` at
`e20791d85b13151ef6eee023ff4b8cf39de0e123`; PR #173 at
`ac35e58ae0a257fd91ea2919d95011508d8db61f`. The implementation recorded below
is newer than that green PR SHA and requires a new hosted run.

| Completed CI run | Wall time | Executed jobs | Summed job time |
| --- | ---: | ---: | ---: |
| [Latest main](https://github.com/f0rr0/oliphaunt/actions/runs/33801742528) | 135.5 min | 109 | 917.9 min |
| [Latest PR #173](https://github.com/f0rr0/oliphaunt/actions/runs/33877271711) | 125.1 min | 87 | 900.2 min |

Calculated from GitHub job/run timestamps, excluding skipped jobs. Summed job
time is not billed time; runner types have different costs. Different events,
scope, queueing and cache states prevent a causal speedup claim. These runs do
not substantiate a recent massive regression, but both remain very expensive.
PR `Required` passed; `Qualified` was skipped by its event condition.

The PR critical path includes 52.6 minutes for Postmaster portable inputs,
followed by 61.3 minutes for its macOS release-asset job. Inside that macOS job,
Moon reports `runtime-build` at 46m11s, `initdb-stress` at 1m11s, and
`backend-wave-stress` at 46s. Deleting those two stress checks would barely affect
the critical path. Native iOS extension artifacts separately took 64.5 minutes.

Current resolved Moon graph: 55 projects, 198 tasks, 156 edges; 26 internal tasks;
117 normal-cache, 13 local-cache, 68 uncached. Use `moon task-graph --json` for
this inventory: `moon query tasks` omits internal tasks.

Tracked-file footprint, including comments/tests/data: `tools/` has 517 files /
176,086 lines; `tools/release/` accounts for 353 / 114,614; `tools/xtask/` for
14 / 13,469. The CI workflow alone is 3,290 lines. These identify review areas,
not safe deletion totals. The open PR already reports 15,104 deleted versus
5,381 added lines across 314 files; deletion count has not translated into a
comparable reduction in full-run cost.

## Ranked changes

| Priority | Finding and concrete change | Guarantee to retain |
| --- | --- | --- |
| 1 — native | Make real producer outputs explicit and reusable. Postmaster `runtime-build` / `postgres-build` and native `release-runtime` currently produce files without declaring Moon outputs. Cache their complete, target-specific deliverables; split portable production from host compiler/executor production so independent hosts can start concurrently. | Cold builds work; patch/toolchain/target changes invalidate; missing outputs hydrate or rebuild; restored binaries retain executable modes and provenance. |
| 2 — shrink | Remove hidden qualification from builders. Postmaster `runtime/bin/build-runtime.sh` contains 86 `cargo test` invocations, including test-list probes, followed by release builds. Group tests by actual crate/feature/platform requirements and run explicit behavioral targets. Its `portable-inputs` depends on regression, and `release-assets` depends on stress/recovery. Put those proof edges on `qualify`; tests depend on prepared sources, not release binaries they do not consume. | All patched Wasmer behavior, memory isolation, concurrent connections, recovery and target-specific tests remain scheduled. Preserve distinct feature sets; do not combine compiler/headless profiles indiscriminately. |
| 3 — delete/shrink | Retire hand-written dependency implications in `tools/graph/ci_plan.mjs:addImpliedJobs` as real Moon artifact edges become sufficient. Today Moon deps, planner job sets, and workflow `needs` jointly encode the execution model. Keep a small runner/artifact transport adapter. | Every selected consumer has all producers, platform artifacts and required proof jobs; no missing-job success. GitHub still needs cross-runner transport and a static job skeleton. |
| 4 — shrink | Separate package-owned assembly from release control. `tools/release` mixes carrier creation, binary validation, licensing, registry publication and graph loading. `src/sources/tools/fetch-sources.mjs` imports a release-layer license auditor; product packagers import root release helpers. Preserve small pure shared libraries, but product code must not invoke the release planner. | Archive safety, licenses, ABI compatibility, integrity, exact candidate identity and publication recovery remain. Do not replace one large tool with a generic framework in every product. |
| 5 — native | Complete source-level sharing through existing [PR #166](https://github.com/f0rr0/oliphaunt/pull/166). `src/shared/js-core/moon.yml` still generates six checked-in mirrors into three consumers. Import a workspace module and bundle or publish it using normal package tooling. | Packed SDKs work outside the checkout; no unpublished workspace dependency leaks. Do not maintain a second implementation of that PR here. |
| 6 — delete/shrink | Remove source-spelling tests after their intended invariant is either executable or explicitly retired. Postmaster's Python ownership verifiers parse Rust implementation text. The current task-model test accepts missing producer outputs as ordering edges and recognizes quality only through selected tags, so it misses real hidden work. | Keep parsed public-manifest checks, negative tamper tests, clean-consumer installation and runtime behavior. A string assertion on an emitted manifest/output is not automatically a bad test. |

`xtask` is not the only or largest problem. Retain compiled operations that
actually need Rust/Wasmer APIs, such as AOT serialization. Delete redundant
dispatch/orchestration as Moon/native commands assume it. Relocating its entire
13k-line implementation into a product would not accomplish this.

## Implemented in this branch

- Postmaster production and qualification are separate task roots.
  `runtime-build` builds release binaries only; `runtime-patch-tests` runs the
  existing patched-Wasmer test battery against prepared sources. Neither task
  silently runs the other.
- `portable-inputs` now packages only production inputs. Target
  `release-assets` only assembles the product. The workflow explicitly runs the
  retained regression, patched-runtime, recovery, backend-wave, and
  linear-memory proofs in the same pre-upload jobs.
- The patched-runtime battery runs once in the Linux portable job instead of
  once in each of the three target release jobs. It has no macOS-only cases.
  No test command was removed and failure detection remains before artifacts are
  uploaded.
- Postmaster runtime and PostgreSQL build tasks declare their produced files.
  Caching remains disabled until the target/env key and hosted persistence are
  proven; declaring an output alone is not represented as a speedup.
- WASIX extension staging now follows the produced runtime plus its own package
  code and canonical extension metadata instead of the broad release-artifact
  inventory. The runtime `VERSION` is the package version owner.
- Rebuilding a prepared WASIX source tree now refreshes the derived PostgreSQL
  tree before checking it, and the patched PostgreSQL archive rule removes stale
  members before recreating archives.
- Removed 1,711 lines of Postmaster Python that parsed Rust source spelling and
  tested that parser. The retained Rust suite directly exercises ownership,
  handoff, lifecycle, concurrency, and fail-closed behavior. Cargo test-list
  assertions remain because they prevent a renamed filter from silently passing
  with zero tests.
- Postmaster runtime build inputs use one future-proof source glob that excludes
  documentation and Python unit tests; changing those no longer rebuilds Wasmer.
- Deterministic archive creation, archive reading, and safe symlink
  materialization now live in the normal `artifact-packaging` shared project.
  Product packagers consume that project directly instead of reaching into
  `tools/release` or using its Bun wrapper.
- Extension target profiles and WASIX installation rules now live with the
  existing extension runtime contract. Native and WASIX extension packagers use
  the same source-level contract while retaining distinct target outputs.
- Postmaster now owns only per-target product assembly. Combining independently
  built target assets is a repository release operation named
  `release-tools:postmaster-release-assets`; its workflow job remains fail-closed
  unless the exact Linux ARM64, Linux x64, and macOS set is present.

Still open: hosted cache persistence, host/portable Postmaster producer
separation, removal of planner implications after equivalent Moon/data edges
exist, removal of the remaining native/SDK product-to-`tools/` imports, PR #166
integration, and evidence-led review of remaining source-spelling tests. These
are not hidden behind this change.

## One owner for each kind of dependency

There are three related models, with different responsibilities:

1. **Package/version dependencies:** native ecosystem manifests state what a
   published consumer requires. A new runtime release does not select SDK
   releases automatically. Existing `release-graph.mjs:buildPlan` already stops
   at the first independently publishable boundary; preserve that behavior.
2. **Execution/data dependencies:** Moon task edges say which workspace outputs
   a command consumes. Project dependencies alone do not describe these files
   or guarantee a correct build order. Source imports use narrow shared inputs;
   generated artifacts use producer tasks and declared outputs.
3. **Publication:** release tooling selects versions and promotes qualified
   package bytes in dependency order. It does not rediscover product builds.

The intended data flow is:

```text
pinned Postgres + patches + toolchain
  -> native / portable WASIX / Postmaster artifacts
  -> target-specific bindings and extension artifacts
  -> SDK packages and installed-consumer tests
  -> qualified candidate -> dry-run validation -> publication
```

This is a family of target-specific paths, not an instruction to rebuild every
node whenever any ancestor changes. Shared extension source can have separate
native and WASIX outputs without inventing separate source projects or forcing
separate versions. Contrib stays part of its runtime distribution; a descriptor
for discovery/installation is not a reason for an independent release lifecycle.

Dependency direction should be products -> narrowly scoped shared workspace
libraries, and CI/release tools -> products. Products must not import `tools/`.
Put genuinely shared implementation in a normal workspace package only when
multiple consumers need it; its API should operate on explicit files/data, not
query Moon, discover products or launch another pipeline. Keep the existing
`src/runtimes`, `src/bindings`, `src/sdks`, `src/extensions` organization; enforce
these boundaries before contemplating renames.

On one host, invoke Moon directly for the selected task closure. Across hosts,
use a small fixed workflow stage structure and target matrices to transport
declared artifacts. Do not replace `addImpliedJobs` with a new general-purpose
workflow compiler or generate a second dependency database.

Keep two explicit consumer paths: **released dependency pins** for SDK-only
work, and **workspace integration** for changes spanning runtime and SDK. The
latter has real producer edges and injects exact locally built artifacts. Never
silently switch to a registry fallback if a selected local artifact is absent.
Release preparation can bump the chosen runtime and SDK pins together; that is
an explicit selection, not a consequence of project reachability.

### Express that in each ecosystem

| Ecosystem | Released dependency | Local joint development |
| --- | --- | --- |
| JavaScript / Node / React Native | Explicit platform-package versions; independent addon/runtime pins | Workspace imports for shared source; explicit staged native artifacts for integration. Bare `workspace:*` packs the current workspace version, so it is not by itself an old-runtime pin. [pnpm docs](https://pnpm.io/workspaces) |
| Rust | Cargo crate versions; explicit version/integrity for any separately downloaded native payload | Cargo path/patch overrides and product build-script artifact inputs. Cargo's `path` plus `version` supports local source and registry publication, but does not make arbitrary native files Cargo dependencies. [Cargo docs](https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html) |
| Kotlin / Java / Android | Maven coordinates and appropriate AAR/JAR/native variants | Gradle project/composite-build substitution; native outputs enter declared Gradle inputs. Do not add a second Gradle scheduler in JavaScript. [Gradle docs](https://docs.gradle.org/current/userguide/composite_builds.html) |
| Swift / iOS | Versioned Swift package; binary target URL/checksum where applicable | Local package or binary-target path for integration. Keep Apple artifact validation. [SwiftPM docs](https://docs.swift.org/swiftpm/documentation/packagemanagerdocs/addingdependencies/) |

These are target recommendations, not claims that all current packages already
implement them. Moon's ecosystem integration is richer for JavaScript/Rust than
Kotlin/Java; explicit cross-language edges remain necessary. [Moon toolchains](https://moonrepo.dev/docs/concepts/toolchain)

## Make caching real before enabling more flags

The workspace enables local CAS, but hosted setup only persists tool archives;
there is no configured Moon remote task cache or persistence of Moon task
results. Heavy workflow commands explicitly set `MOON_CACHE=off`.
`setup-rust-tools` defaults cache writes to false; only the portable liboliphaunt
WASIX CI caller opts into the Cargo save policy. Postmaster's separate Cargo
target directories also require deliberate workspace mappings. Therefore
“cache: true” in a Moon file is not evidence of hosted reuse.

First correct declared output ownership and cache keys, then use a supported
remote task cache for deterministic work and correctly scoped compiler caches
for expensive builds. Keep same-run artifact transport for release candidates;
a cache hit does not authorize publication. Do not archive all of `target/` or
all Moon internal state. [Moon cache](https://moonrepo.dev/docs/concepts/cache),
[CI persistence guidance](https://moonrepo.dev/docs/guides/ci#caching-artifacts)

Moon v2 supports dependency `cacheStrategy: outputs` to invalidate consumers
when produced bytes change. It also defaults dependencies without outputs to
ordering-only invalidation. Use that distinction deliberately after declaring
the real outputs. Normal globs/shared file groups suffice for source inputs;
handwritten inventories of implementation files should not be a parallel build
model. [Moon task configuration](https://moonrepo.dev/docs/config/project#cache-strategy)

## Predictable event policy

| Event/change | Expected work |
| --- | --- |
| SDK-only PR | Affected source checks, SDK package, installed consumer against pinned native dependency; no Postgres rebuild. |
| Runtime/extension PR | Changed producer targets and their actual downstream behavior/ABI consumers; do not force unrelated SDK version bumps. |
| Joint runtime + SDK PR | Workspace integration using the exact new artifacts, plus released-package shape/dependency checks. |
| Release PR | Chosen version/pin changes, final package assembly and relevant consumer checks. Reuse unchanged compilation, not stale versioned archives. |
| Main | Qualify the exact resulting SHA. Reuse valid deterministic outputs; run required integration. Retain current exhaustive release requirements until reusable evidence is proven. |
| Product/release dry run | Same candidate assembly/validation and native registry dry-run commands where supported; no publishing. Report any unexercised hosted authorization. |
| Publish | Promote the exact qualified bytes; verify identity, permissions and registry state. No hidden source rebuild or repacking. |

Do not move required platform tests to nightly merely to make a PR green.
That changes detection latency and merge guarantees, even if shipped product
behavior is unchanged. Keep on-device tests that uniquely exercise sandbox,
loader or lifecycle behavior; remove repeated manual evidence collection where
an automated installed-app test proves the same thing. Registry authentication,
quotas and availability remain external checks, not properties Moon can prove.

## Implementation order and acceptance

1. Finish the current small dirty fixes with their required runtime proof, or
   leave them explicitly separate. Avoid further push/cancel cycles: they waste
   full builds and prevent complete qualification evidence.
2. Refactor the measured Postmaster bottleneck first: producer outputs, separated
   behavioral tests, grouped Cargo invocations, correct compiler-cache scope,
   concurrent independent host production. Preserve the full test set initially.
3. Migrate one representative SDK path end to end, including old-runtime pins
   and workspace mode. Then apply the same boundary rules to remaining products.
4. Delete planner implications and release/product coupling made obsolete by
   those paths. Integrate PR #166 rather than recreating source sharing.
5. Prune redundant tests, manifests and guide instructions with a coverage-loss
   ledger: removed command -> retained proof -> changed detection timing, if any.

Acceptance must exercise cold, warm and missing-output runs; newly added source
files; patched inputs; changed target/toolchain; an SDK pinned to an older
runtime; joint development; corrupt or incomplete artifacts; and a clean packed
consumer outside the workspace. Check observed command execution as well as the
planned graph. A test that only agrees with planner tags cannot prove this.

Report task durations, queue time, artifact-transfer time and cache hits
separately from existing Moon/GitHub reports. Set time budgets from repeated
cold/warm measurements; do not promise a five-minute native rebuild without
evidence. No new metrics service, build system, directory-wide rename or
universal product framework is needed for this work.

## Work recorded in this reassessment

Implemented the first measured cut without changing the pre-upload behavioral
guarantee:

- Split Postmaster patched-runtime qualification from production and run it once
  in the portable job, rather than in every target build. Target packaging no
  longer hides regression, stress, recovery or memory checks; the workflow names
  those qualification roots explicitly.
- Declared Postmaster runtime and PostgreSQL outputs, narrowed invalidation to
  files tasks consume, and removed broad release metadata from WASIX extension
  assembly.
- Deleted 1,711 lines of Rust-source-spelling parsers/tests. The retained Rust
  tests exercise the same runtime ownership and lifecycle behavior directly.
- Fixed two rebuild failures discovered by warm-run chaos testing: Postmaster
  portable and target packagers now replace only their own exact archive, and
  the patched PostgreSQL archive recipe removes stale members before rebuilding.
- Moved the pure archive and extension-install contracts into shared source
  projects. The move changes ownership and invalidation edges, not archive bytes
  or accepted package shape. Repository-wide Postmaster asset aggregation moved
  in the opposite dependency direction, from the product to release tooling.

Observed local runs, all with the repository-pinned Moon 2.5.4 toolchain and
`MOON_CACHE=off` for production graphs:

| Proof | Result |
| --- | --- |
| Full portable liboliphaunt WASIX runtime | Passed cold in 21m50s |
| WASIX AOT target from that runtime | Passed in 3m48s |
| Exact Postmaster portable workflow roots | Passed cold in 16m30s; patched-runtime tests took 12m35s while independent production ran concurrently |
| Postmaster patched-runtime suite after parser deletion | Passed again in 6m15s warm |
| Exact Linux Postmaster target workflow roots | Passed in 4m48s and did not execute the patched-runtime suite |
| Portable archive rebuilt twice consecutively | Passed in 9.0s and 8.3s |
| Existing target release archive rebuilt | Passed in 31.8s |
| Postmaster lint and unit tasks | Passed; unit completed in 2m38s |
| Product graph assertions | 19 passed |
| Workflow/security/planner/bootstrap policy suite | Passed: 8 security tests, 36 planner scenarios and 13 bootstrap tests; `actionlint` and `zizmor` clean |
| Release artifact-target contract | Passed for 42 runtime/helper rows, 8 exact-extension products, 312 extension rows, 203 registry carrier minima and 7 SDK packages |
| Shared artifact packaging contract | Passed: 29 archive/symlink tests; Postmaster portable and target package rebuilds passed |
| Shared extension runtime contract | Passed: 7 target-profile and WASIX install tests; WASIX staging produced all 39 extensions |
| Complete release-tool mutation suite after the move | Passed in 4m57s |

No behavioral test command was removed. The source parser deletion changes only
the kind of proof: implementation spelling is no longer enforced, while the
runtime behavior remains exercised. Hosted cache reuse is not claimed, and the
new GitHub timings must be compared only after the updated SHA completes.

During local qualification, generated compiler/build directories under
`target/` were removed when disk pressure required it. They are reproducible
outputs; no source or release input was deleted.
