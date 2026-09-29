# CI inventory and correction backlog — 2026-09-29

Audit baseline: `origin/main` at `32ce7b29510b74333e799601b69a71fd28122e80`
(#225). Evidence, inventories and timings below describe that baseline. The
implementation status is recorded first. Checked items mean implemented and
locally checked; they do not assert hosted qualification. Local timing comparisons
are identified separately from hosted end-to-end savings.

## First correction batch — local implementation

Branch: `f0rr0/fix-ci-cache-reuse`. This batch changes cache/setup plumbing;
product selection, compiler flags, runtime tests and release admission remain
unchanged. Hosted warm-run timings are still required before claiming savings.

| Finding | Implemented | Remaining verification/work |
| --- | --- | --- |
| CI-06 | Postmaster maps its four Cargo output directories from checked-in workspaces, without including their parent | Measure hosted restore/save and warm compilation. Use the executor's patched dependency context for runtime metadata; preserve upstream dependency-only cache policy |
| CI-07 | Android ABIs now use the existing target-scoped, bounded native extension ccache restore/save path | Measure warm hit rate and produced-artifact equivalence; no desktop cache expansion |
| CI-08 | One caller-resolved save policy reaches Rust, LLVM, Gradle and all four reusable producer/package workflows | Verify manual opt-in/opt-out on GitHub; source/action checks pass locally |
| CI-13 | Both normal and replay iOS installed-app jobs disable PostgreSQL build-tool installation | Android provisioning separation is implemented in the second batch; simulator/Xcode verification remains enabled |
| CI-16 | Deleted the unused summary action | Mobile execution-definition consolidation is implemented in the second batch |
| CI-19 | Normal WASIX and Postmaster use one cached builder setup with the existing recipe label, context and cache scope, before Postmaster compilation | Measure hosted Buildx reuse; shared acquisition deadlines now bound source/bootstrap retries |

Local validation includes the workflow/security/planner gate, real pinned
Postmaster source preparation and locked Cargo metadata for its cache owners,
metadata collection before generated dependencies exist, shared builder-label
reuse, and the pinned Rust-cache cleanup on fixture output using the configured
paths. The affected artifact-packaging, native-extension packaging and WASIX TS
unit tasks, plus CI-tool formatting/lint, passed locally. The failed Wasmer-root
metadata probe identified why cache metadata must use the executor's patched
dependency configuration; that probe does not indicate a runtime-build regression.

## Second correction batch — local implementation

The changes retain product coverage and release admission. Existing Moon tasks,
source fetchers, artifact validators and platform tools own the work; there is no
new CI framework. Same-run artifact transfers preserve their existing validation.

| Findings | Implemented | Remaining proof or limitation |
| --- | --- | --- |
| CI-02 | Timeout fixtures separate preparation from the deliberate child timeout and cover delayed startup plus an expired deadline | Full release-tool suite passes; no production retry or timeout relaxation |
| CI-03/12/13 | Rust and Deno defaults come from their manifests; Android uses its SDK manifest; Expo's installed React Native version catalog must match the explicitly provisioned Expo NDK | Native NDK remains unchanged. Clean hosted Gradle build must confirm no implicit download. Replay installs no native compiler/CMake; source checks request only their capabilities |
| CI-04/05 | Evidence generation uses all five required modes; the existing uncached WASIX regression task owns its producer dependencies and fresh observations | Truncated materialization evidence is rejected. Planner retains the existing requirement that portable WASIX production receives lifecycle qualification, without repeating its four producer dependencies |
| CI-09/23 | Per-host WASIX AOT and Node-API work share a reusable workflow; Linux consumers wait only for Linux; browser/TS packaging starts after source gates | Final all-host aggregates remain. manylinux keeps its container boundary; no incompatible Cargo cache reuse is claimed |
| CI-11 | WASIX lifecycle is grouped under E2E, alongside native lifecycle | Candidate-bound native release evidence is completed in the third batch |
| CI-14 | Matrix labels use short capability names; full selected tasks appear in the job summary | Product/aggregate display names are completed in the fifth batch; protocol IDs stay stable |
| CI-16/26 | CI and replay use one installed-app action. Maestro and its installer/flow are removed; continuous current-launch logs feed the existing structured receipt validator | Failure, crash, capture death, app death and stale PASS rejection are tested. Actual iOS simulator and Android emulator runs remain required |
| CI-17 | Browser-host Git and crate sources use the shared bounded, exact-pin fetcher and safe archive extraction | Live exact sources, transport fault tests and the full browser/TS package build pass; acquisition now precedes runtime-dependent consumers |
| CI-20 | Producer input groups exclude unrelated Markdown and unit fixtures; SDK README packaging does not select runtime compilation | Actual Moon affected-selection regressions pass. Postmaster's shipped README gets a cheap producer in the third batch |
| CI-21 | WASIX compilation cache has a compatible fallback. Reuse requires the current Moon input hash and verified compiler-output checksums; source preparation, staging and profile validation still run | Cold/warm, corrupted output and changed-input fault tests pass. Full hosted compiler output and warm timing still need validation |
| CI-22 | Android static compilation overlaps one Linux support producer. Both ABI packagers consume that same-run support output instead of compiling Linux again | SQL-only package fixture passes and missing inputs fail closed. Actual Android native artifacts still need hosted qualification |
| CI-24 | The existing transfer runner submits dependency-ready batches to Moon, allowing independent tasks to overlap | Real pinned Moon fixture proves sibling overlap, join ordering and no transferred-producer replay; existing task-failure checks pass |
| CI-25 | A frozen, validated iOS carrier can replace only the unchanged React Native package metadata dependency in ordinary affected runs | Changed native inputs, missing/corrupt cache and explicit product/full qualification retain producers. Same-SHA empty diffs are handled without invoking Moon on empty stdin |

New intermediate handoffs retain 30 days so failed jobs can be rerun throughout
GitHub's [supported rerun window](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).
Release-input/proof retention is unchanged. Browser-host Cargo state has its own
source/toolchain-keyed cache, and its built host files travel with SDK consumer
inputs so consumers do not silently compile the browser host again.

Local verification covers the exact pinned workflow/security gate, actual Moon
planning and transfer execution, Android installer fault cases, native extension
packaging, WASIX build orchestration, React Native and WASIX TypeScript owner
checks, extension metadata/evidence checks, source-fetch fault cases, and the full
release-tool suite. The browser host compiled and the TypeScript npm package
passed its package validator (`oliphaunt-wasix-ts:package`, 7m55s locally). The
mobile receipt tests and actual Moon transfer fixture also pass under a locally
built GNU Bash 3.2.57; this checks shell compatibility, not macOS platform APIs.
Test logs are in `/tmp/oliphaunt-ci-cache-fixes` for this local
session. A complete Linux workflow run cannot establish Apple/Windows/device
behavior: those platform runs and cache hit/timing measurements remain outstanding.
No new GitHub run or exact-SHA `Qualified` result is claimed for this working tree.

| Verification command | Local result |
| --- | --- |
| `bash tools/ci/check-workflows.sh` with pinned Moon 2.5.4 | Passed actionlint/security checks, 66 planner tests, six artifact-transfer tests, cache/setup tests and real Moon scheduling fixtures |
| `bash tools/release/release-check.sh` | Passed metadata and release implementation checks, including delayed-start timeout fixtures |
| `moon run oliphaunt-react-native:test` and relevant format/lint/typecheck tasks | Passed; actual Apple transport checks remain macOS-only |
| `moon run oliphaunt-wasix-ts:test oliphaunt-wasix-ts:typecheck oliphaunt-wasix-ts:format-check` | Passed, including 352 SDK tests |
| `moon run oliphaunt-wasix-ts:package` | Compiled the pinned browser host, built the SDK and validated the npm archive |
| `bash src/third-party/tools/source-fetch-core.test.sh` and `bash src/third-party/tools/fetch-sources.sh production-all --validate-only` | Passed exact-pin, retry/failover, archive validation and checkout-preservation checks |

## Third correction batch — rebuilds, release proof and coverage

| Findings | Implemented | Verification and limit |
| --- | --- | --- |
| CI-01 | All five previously unwired SDK runtime tasks now have hosted execution owners: four in native consumers and WASIX resources in the WASIX regression job. They consume existing same-run artifacts, require positive test execution, and remain uncached | Rust SQL/runtime, mobile broker, Swift, Kotlin and both WASIX seed resource tests pass locally against real payloads. These Linux host tests do not replace device/platform qualification |
| CI-10 | Coalesced four identical Cargo feature/target configurations and removed a duplicate executor library compilation already covered by the complete product executor suite | Invocation/selection comparison preserves all previous selections while reducing 25 Cargo invocations to 20. Distinct compiler and compiler-free feature profiles remain separate; hosted compile savings are unmeasured |
| CI-11 | Native aggregate/shard proof is bound into the release candidate and revalidated before native extension-carrier publication, including runtime-owned contrib. Aggregate proof has the same 90-day retention as WASIX, includes all shard receipts, and supports reruns | Candidate write/verify and tamper fixtures pass, including wrong source/run, missing shards, incomplete published extension coverage and modified evidence. SDK-only releases retain their existing consumer qualification |
| CI-20 | Postmaster's shipped README has a cheap declared producer. Release assembly consumes its output, while prose-only affected CI avoids the runtime build and regression closure | Actual Moon affected/full-release planning tests pass. Runtime/compiler source changes still select their original producers |

The native suites exposed an unused `pg_config` preflight requirement that did
not match shipped runtime archives; the shared preflight now requires only the
actual runtime inputs. A runnable staging fixture checks missing inputs,
inherited-path isolation, optional tools/broker, cleanup and exit propagation.
Swift preparation no longer regenerates bindings already owned by its Moon
dependency; the standalone Swift wrapper retains explicit generation. Kotlin's
runtime task similarly reuses the declared binding producer.

Local checks include the full release-tool suite, candidate/receipt tests,
workflow/security and actual Moon planner/transfer checks, and the five real
SDK runtime tasks. The Postmaster source/fault suite and native evidence owner
tests also pass. The complete patched Wasmer compiler/runtime suite still
requires hosted qualification; the Cargo selection comparison proves retained
selections, not their runtime outcomes. Native payloads were rebuilt and packaged from this working
tree. WASIX resource tests used the unchanged runtime/resources downloaded from
successful baseline CI run `36567197390` at `32ce7b2`; that local exercise is not
exact-SHA qualification of these changes. Logs are under
`/tmp/oliphaunt-ci-remaining`. Full hosted platform runs and cold/warm timing
remain required before claiming a measured CI speedup.

## Fourth correction batch — acquisition deadlines

Source fetching and repository-owned bootstrap downloads now use one shared
shell deadline. Retries, mirrors, lock waits and dependent requests spend the
same budget. APT update/install defaults to 15 minutes, complete source scopes
to 30 minutes, and individual source pins to 15 minutes. The
[maintainer pattern and budget table](../maintainers/testing.md#acquisition-deadlines)
define the scope, override, cleanup and package-manager boundaries.

Verification passed: `source-inputs:test`, `dev-tools:test`,
`dev-tools:test-mobile-setup`, `ci-tools:test`, `ci-workflows:llvm-install-unit`,
WASIX orchestration/installer tests, Postmaster builder identity tests and the
complete pinned workflow gate. Deadline fixtures cover final-attempt expiry,
shared retry/mirror budgets, lock ownership, child termination, cancellation,
APT update-to-install admission and preservation of valid Android packages.
Helper and PostgreSQL transport tests also pass under GNU Bash 3.2.57 on Linux.
Live WASIX sources fetched and verified exact pins; the final Docker recipe
completed APT in 56.2 seconds, installed the pinned compiler assets and passed
compiler smoke/version checks. Its warm build reused every layer, and the
recipe label passed Postmaster validation. Actual Moon affected queries select
all helper consumers. Logs: `/tmp/oliphaunt-acquisition-*`. Hosted platform and
wall-clock qualification remain outstanding; no release qualification is claimed.

## Fifth correction batch — platform review and remaining efficiency

The acquisition review corrected GNU timer discovery when Windows System32's
`timeout.exe` shadows Git Bash's Coreutils executable. It prefers `gtimeout`,
then a verified GNU `timeout`, then `/usr/bin/timeout`. Android setup checks this
prerequisite before inspecting or repairing SDK caches, and its macOS action
installs Coreutils when needed. Missing timer support must not masquerade as
corrupt command-line tools. The browser-host patch loop now works on Bash 3.2
and propagates failure to read its patch list.

| Findings | Implemented | Verification and limit |
| --- | --- | --- |
| CI-14 | Visible jobs distinguish Builds, Packages, Tests and E2E; mobile ABI labels identify seed production, mixed JavaScript/ICU work is explicit, and runtime labels use WASIX | Stable job IDs, aggregate gates and release/replay job-name references are preserved. The public `wasm_target` dispatch input remains compatible |
| CI-15 | Eleven planning, proof-aggregate and artifact-consuming finalizer jobs skip Moon task-output restore/save | Real graph checks prove no normally cached local task subtree remains in these jobs. The transfer adapter runs artifact-dependent work with `MOON_CACHE=off`. Verified tool archives still use their existing cache |
| CI-18 | Independent planner observations run through four native `xargs` workers, each with its own output file | All 93 parsed JSON outputs matched the serial run. Local elapsed time fell from 92.60 to 59.32 seconds (36%); this is the observation phase, not total CI wall time. A fault check rejects failed workers and covers paths containing spaces |

The pinned workflow gate passed, including 66 planner tests, seven artifact
transfer/policy tests, scheduling fixtures and workflow/security checks.
Timer discovery, retry/deadline and process-cleanup fixtures pass on Bash 3.2.57
on Linux. The Android installer and bootstrap installer fixtures also pass
with child shells using Bash 3.2. These are shell compatibility checks, not
Windows, macOS, iOS simulator or Android emulator qualification.

The source-acquisition owner task passed again against the reviewed helper
(3m19s). A real Docker build completed its pinned APT transaction in 61.4 seconds
and compiler acquisition in 15.4 seconds, then verified wasixcc 0.4.3, Clang
21.1.2 and Binaryen 130. These runs followed a local machine restart that
interrupted the earlier build attempts; interrupted attempts are not counted
as passing checks. The full browser-host build also passed with Bash 3.2.57
selected for the script and child shells, including real source acquisition,
patch application, Rust compilation, WASM optimization and Rollup (7m40s).

A fresh read-only cache inventory found 284 Moon entries totaling 291.6 MB,
including 128 under 1 KB. Rust caches totaled 8,197.2 MB and LLVM 1,065.1 MB.
No remote caches were deleted. Retention/pruning of those larger caches still
needs warm restore/save and hit-rate measurements. Baseline successful source
jobs took roughly 23–201 seconds, with setup often dominant; warm timings alone
do not establish safe cold-run deadlines. Uncached release checks still consume
Git/release history. An isolated offline Cargo probe confirmed that packaging a
dependency first does not let a later standalone package resolve its unpublished
version; selecting both crates in the same invocation succeeds. Retain that
multi-crate staging, rather than deleting the repeated dependency selections.

### Still open

- CI-10: measure remaining distinct Postmaster feature/profile costs before
  changing their guarantees or overlapping portable and host compilation.
- CI-15: budget/prune the large compiler caches using actual warm restore/save
  size and hit rates; jobs without reusable Moon outputs now skip that cache.
- CI-18: measure cold source-group setup costs before changing group deadlines;
  prove release-check inputs before caching them. Cargo's unpublished dependency
  staging remains necessary; consolidate package ownership only if measured cost
  justifies changing that graph.
- CI-19: measure hosted cache reuse and acquisition tails against the implemented
  budgets; source/bootstrap transactions now share deadlines across retries and mirrors.
- Hosted verification: compare equivalent cold/warm runs and unchanged artifact
  contracts, including both Android ABIs, iOS simulator and all WASIX hosts.

## Assessment

The second pass found larger structural waste than the first: duplicate
toolchain and host-runtime builds, affected selection that promotes documentation
or unit-test changes into full compiler pipelines, and whole-platform barriers
between otherwise independent producers and consumers. The backlog now contains
**26 findings**, including eight new structural findings, CI-19 through CI-26.

For wall time, work on both long chains: Postmaster and WASIX runtime/AOT/SDK.
Fixing only the longest job moves the bottleneck rather than removing it.
For ordinary PR feedback, narrow compilation inputs before tuning small tests.
For runner cost, remove duplicate host builds and ineffective caches. These
three objectives overlap, but their savings must not be added together.

The highest-return order is:

1. Share the already-cached WASIX Docker builder with Postmaster; fix its Rust
   cache mapping and the WASIX compilation-cache restore policy.
2. Stop documentation and isolated unit-test changes from scheduling unrelated
   compilation; separate package changes from compiler input changes.
3. Remove cross-host WASIX barriers and start independent browser-host work
   early; overlap Postmaster host compilation only after measuring cache fixes.
4. Reuse Android's duplicate Linux support build and avoid serializing it with
   independent Android compilation; persist the useful extension compiler cache.
5. Remove Maestro's status-label-only role from SDK smoke, preserving exact-launch
   receipts and failure detection. Address Android-to-iOS package coupling.

At the audit baseline, correctness fixes CI-01 through CI-05 were also needed.
CI-01 through CI-05 are now implemented; hosted platform qualification remains.
Several recent failures detected real product/release defects; indiscriminate
test deletion would lose useful proof without addressing the largest delays.

There is no justification here for a new CI framework, another product
registry, a generalized evidence service, a new retry service, or wholesale
workflow generation. Moon, product manifests, the existing candidate record,
and GitHub Actions already provide the required pieces.

## Scope and evidence

Inspected all seven workflows, their local actions and execution adapters,
the expanded Moon project/task graph, product/SDK task definitions, release
admission and artifact transfers, and representative underlying scripts/tests.
The inventory contains **56 Moon projects, 373 tasks across 45 task-owning
projects, 27 release manifest entries, and 15 local composite actions**.
The seven workflow files define 76 job entries before matrix expansion and
reusable-workflow calls. These are different counts, not competing inventories.

An exhaustive current-tree source matrix selects 122 check targets in 21 groups,
3 policy targets, and 54 test targets in 17 groups. Actual affected/product runs
select fewer. There are 33 `ci-<job-id>` task mappings, including native lifecycle.

Downloaded the latest 100 workflow records and inspected the failed job
inventories for every failed CI/Release run in the September 25–29 subset.
That subset contained 53 runs: CI had 14 successes, 8 failures, 14 cancellations,
12 skipped runs and one running run; Release had two successes and two failures.
**This is not a flake rate.** These were different commits and scopes;
cancellations include ordinary supersession/merge cancellation, and skipped
runs include the deliberate PR-close tombstones.

Timing figures use GitHub job `started_at`/`completed_at`, summed without OS
billing multipliers. They are runner-minutes, not billed minutes or CPU time.
Latest-attempt job lists can mix retained successes with rerun jobs. The clean
successful first-attempt run below is the cost baseline; the rerun's elapsed
hours are not treated as continuous computation.

| Run | Purpose / result | Executed jobs | Runner-minutes | Wall time |
| --- | --- | ---: | ---: | ---: |
| [36492755110](https://github.com/f0rr0/oliphaunt/actions/runs/36492755110) | Merged release candidate `7b192697`; success | 105 | 800.8 | 122.0 min |
| [36480008083](https://github.com/f0rr0/oliphaunt/actions/runs/36480008083) | Corresponding release PR; success | 104 | 764.7 | About 95 min |
| [36521743783](https://github.com/f0rr0/oliphaunt/actions/runs/36521743783) | Focused Apple release-workflow fix; success | 9 | 4.3 | About 4 min |
| [36523497369](https://github.com/f0rr0/oliphaunt/actions/runs/36523497369) | Full manual `34e49318`; Android recovered, qualification receipt failed | Mixed attempts | Not a comparable single-attempt sample | Excluded |
| [36567197390](https://github.com/f0rr0/oliphaunt/actions/runs/36567197390) | Current main `32ce7b29`, manual full qualification | Running during collection | Excluded from complete-run totals | Excluded |

The baseline's work distribution was:

| Responsibility | Jobs, including aggregates | Runner-minutes |
| --- | ---: | ---: |
| Planning | 2 | 1.0 |
| Checks | 15 | 23.3 |
| Tests | 14 | 27.3 |
| Builds, packaging and build-owned consumer checks | 64 | 713.2 |
| E2E | 8 | 35.7 |
| Required + Qualified | 2 | 0.3 |

Native extension producers accounted for **225.8 minutes** across seven targets;
Postmaster portable/target/finalization jobs for **147.2 minutes**. Together
they account for roughly 47% of baseline runner time. Optimizing small JSON
receipt validators will not materially change that bill.

## Second-pass wall-time analysis

Times below are minutes since the start of successful run `36492755110`, not
durations that can be summed across overlapping jobs.

| Chain / checkpoint | Started | Finished | What controls the next stage |
| --- | ---: | ---: | --- |
| Cheap checks/tests ready | — | 6.6 | Heavy producers can start |
| Postmaster portable + qualification | 6.6 | 78.7 | Every Postmaster host waits for the whole job |
| Postmaster macOS + qualification | 78.8 | 120.8 | Longest host; final aggregation follows |
| WASIX portable producer | 10.7 | 54.1 | Runtime, tools, extensions and seeds share one producer job |
| WASIX AOT hosts | 54.2 | 78.1 | Linux x64 finished at 67.5; consumers wait for Windows |
| WASIX Node-API hosts | 78.1 | 91.7 | Linux x64 finished at 84.6; TS waits for Windows |
| WASIX Linux regression | 78.7 | 96.2 | Linux-only proof starts after the AOT matrix barrier |
| WASIX TS package + consumers | 91.8 | 102.4 | Includes independent 6m34s browser-host compilation |
| iOS app / installed E2E | 49.1 / 62.9 | 62.7 / 73.9 | Extension carriers, app build, simulator/driver startup |
| Android app / installed E2E | 52.5 / 62.5 | 62.5 / 65.1 | Slowest Android extension producer then app build |
| Final qualification | — | 122.0 | All selected branches must succeed |

**The ceiling matters:** even deleting Postmaster's entire chain would leave
the WASIX TS branch finishing at minute 102.4, plus final gates. That is only
about 19 minutes of possible total improvement in this run. Postmaster's
147.2 runner-minutes are not 147.2 minutes of wall-time savings.

| Priority | Structural correction | Measured exposure | Scope of benefit / limitation |
| --- | --- | --- | --- |
| First | Postmaster builder reuse, CI-19 | APT layer 39m52s; normal WASIX cached image setup 24s | Removes a demonstrated long-tail setup risk. Other observed APT layers were only 59–64s; do not promise 40 minutes on every run |
| First | Select work by actual inputs, CI-20 | README edits select full Postmaster or WASIX pipelines | Avoids whole expensive branches on focused PRs; no reduction for a legitimate full-product change |
| First | Effective compiler caches, CI-06/07/08/21 | Warm downstream WASIX outputs still preceded by 12m23s core compilation | Shortens both long branches; validate cache compatibility and cold behavior |
| Next | Host-specific WASIX dependencies, CI-09/23 | 10.6-minute Linux AOT wait, then another 7.2-minute TS wait | Reduces the second-longest chain; waits overlap other work and are not directly additive |
| Next | Android host support reuse/overlap, CI-22 | Linux support rebuilds took 24m49s and 20m06s across the two ABI jobs | Large compute saving; waiting for Linux before cross-compiling would preserve most wall time |
| Next | Remove status-label UI driver, CI-26 | iOS app passed at 23:38:12; Maestro finished at 23:42:50 | Roughly 4m38s avoidable tail in this installed-app sample; not the full-run critical path |
| After those | Transfer adapter scheduling, CI-24 | Windows AOT's serial step took 20m38s | Some independent tasks could overlap; CPU and compiler locks limit gains |
| Focused Android work | Decouple unchanged iOS carrier metadata, CI-25 | Real Android Kotlin edit selects iOS runtime production | Avoids unrelated Apple work; was not Android's limiting input in the full baseline |

The portable producer itself holds core output for roughly another 26 minutes
while extension/tool work finishes. That is a scheduling observation, not a
26-minute savings estimate: full consumers need those extensions, and splitting
the producer carelessly duplicates its Docker/compiler workspace. Fix input
selection, caches and host barriers before adding more portable build jobs.

Postmaster is a published GitHub-assets product:
[v0.1.0](https://github.com/f0rr0/oliphaunt/releases/tag/liboliphaunt-wasix-postmaster-v0.1.0)
contains Linux x64/arm64 and macOS arm64 carriers. It is not an SDK-registry
package, but that does not make it unreleased. Removing its required coverage
would be a separate product-support decision, not a CI optimization assumed by
this audit.

## Workflow and ownership inventory

| Workflow | Trigger / role | Owner and important boundary |
| --- | --- | --- |
| [ci.yml](../../../.github/workflows/ci.yml) — 3,522 lines, 60 job entries | PR, merge group, main push, manual qualification | Moon chooses task scope; Actions provisions hosts and transfers artifacts; `Required` aggregates selected work; `Qualified` records eligible exact-main proof |
| [release.yml](../../../.github/workflows/release.yml) — 1,855 lines, 8 jobs | Manual prepare or publish | Release tools select products, request missing qualification, freeze one candidate, publish it, verify public delivery, refresh docs |
| [extension-artifacts-native.yml](../../../.github/workflows/extension-artifacts-native.yml) | Reusable target producer | `extension-artifacts-native:build-target`; four caller partitions, seven full-matrix targets |
| [liboliphaunt-native-desktop.yml](../../../.github/workflows/liboliphaunt-native-desktop.yml) | Reusable desktop producer | Native runtime/tools/resources tasks; Linux and other-host partitions |
| [broker-runtime.yml](../../../.github/workflows/broker-runtime.yml) | Reusable broker producer | `oliphaunt-broker:build-release-assets`; Linux and other-host partitions |
| [mobile-extension-packages.yml](../../../.github/workflows/mobile-extension-packages.yml) | Reusable packaging | `extension-packages:package-mobile`; separate Android/iOS callers |
| [mobile-e2e.yml](../../../.github/workflows/mobile-e2e.yml) | Manual/reusable diagnostic replay | Resolves existing exact-SHA app artifacts, then installs/tests them; not an automatic second CI run |

The local action layer owns tool installation: Moon, Node, Bun, Deno, Rust and
Rust tools, Swift, Apple, Android, MSVC, Wasmer LLVM, Maestro and npm publishing.
`setup-node-bun` composes existing installers. `collect-ci-summary` has no callers.

### Product/lane inventory

The following accounts for every current CI task-to-job mapping. Stable IDs
are shown because human display names are not consistently descriptive.

| Job ID or related IDs | Product task owners / actual work | Target or consumer boundary |
| --- | --- | --- |
| `liboliphaunt-native-desktop` | `liboliphaunt-native` build/package/artifact tests; `postgres-tools-native` package/tests; native standard/ICU seeds | Linux x64/arm64, macOS arm64, Windows x64 |
| `liboliphaunt-native-android` | Native runtime build/package | Android arm64-v8a and x86_64 |
| `liboliphaunt-native-ios` | Native runtime XCFramework build/package | iOS device/simulator slices |
| `liboliphaunt-native-android-abi`, `liboliphaunt-native-ios-abi` | ABI finalization **and database-resource seed production** | Mobile compatibility domains; iOS seed work can require macOS |
| `liboliphaunt-native-release-assets` | Native asset aggregation | All selected native targets |
| `extension-artifacts-native` | Exact extension compilation/package | Four desktop targets, two Android ABIs, iOS XCFramework |
| `extension-artifacts-wasix` | Exact portable extension archive packaging | Portable WASIX |
| `extension-packages` | Public Cargo/npm/Maven/Apple extension carriers | Selected extensions and target families |
| `mobile-extension-packages` | Mobile extension carriers | Android/iOS partitioned |
| `broker-runtime`, `broker-release-assets` | Broker binaries and aggregate assets | Four desktop targets |
| `node-direct`, `node-direct-release-assets` | Native Node addon, built-artifact qualification, aggregate assets | Four desktop targets |
| `liboliphaunt-wasix-runtime` | Core portable runtime, extension/tool compiler outputs, portable tools, WASIX standard/ICU seeds | Linux-hosted portable production; multiple product owners share the job |
| `liboliphaunt-wasix-aot` | Core/tool/extension AOT; Rust SDK and pgwire host execution | Four native AOT hosts |
| `liboliphaunt-wasix-release-assets` | WASIX asset aggregation | Portable plus selected AOT hosts |
| `wasix-napi`, `wasix-napi-release-assets` | WASIX Node-API addon and aggregation | Four desktop targets |
| `wasix-postmaster` | Portable inputs, host carriers and release finalization | Separate portable job; Linux x64/arm64 and macOS arm64 host jobs; runtime-patch/regression/recovery tasks also explicitly invoked in YAML |
| `rust-sdk-package` | Native SDK, build helper, native bindings, broker crate and query crate; packed consumer compilation | Linux; package closure before execution |
| `wasix-rust-package` | WASIX Rust SDK and pgwire packages/consumer compilation | Linux; runtime tests are elsewhere |
| `js-sdk-package` | Native TS, query TS, WASIX tools TS **and ICU data** packages | Linux; heterogeneous products under a JS SDK label |
| `wasix-ts-sdk-package` | Browser-host build, TS package, browser/native consumers; PostgreSQL tools browser/native consumers | Linux; artifact-dependent tests and independent packaging combined |
| `swift-bindings`, `swift-sdk-package` | XCFramework production on macOS; source/carrier assembly on Linux | Swift SDK |
| `kotlin-sdk-package`, `kotlin-maven-staging` | Maven SDK packaging, staging | Kotlin/JVM/Android SDK |
| `react-native-sdk-package` | npm package and clean package consumer | React Native SDK |
| `native-consumers` | Native TS Node/Bun/Deno, Rust installed SDK, broker consumer; release-only published-dependency TS variant | Canonical Linux x64 artifacts |
| `native-extension-lifecycle` | Native direct/broker/server, restart and backup/restore | Linux x64; three full-catalog shards plus aggregate receipt |
| `mobile-build-android`, `mobile-build-ios` | Expo installed-app production | Android x86_64 emulator app; iOS simulator app |

Additional hosted execution: `wasix-release-regression`, native lifecycle
aggregation and Android/iOS installed-app E2E. WASIX regression is an explicit
workflow call to the evidence collector, not a `ci-`-mapped Moon root.

Product selection is not a second directory-based planner: keep release product
identity in product manifests, execution/data dependencies in Moon, and runner
and transport topology in Actions. `tools/ci` and `.github/scripts` currently
split adapter ownership; neither should acquire independent SDK policy.

### SDK proof comparison

| SDK/surface | Source proof | Packed/installed proof | Missing or misleading hosted ownership |
| --- | --- | --- | --- |
| Native Rust | Rust unit/doc tests, formatting, Clippy | Packed crate compile plus real installed direct/broker consumer | `test-integration` not hosted; environment-dependent tests can return without execution in the ordinary test lane |
| WASIX Rust | Rust unit/doc/public API tests | Packed crate compile; AOT tests on four hosts; Linux exhaustive extension regression | `test-integration` resource tests not hosted; `test-regression` task bypassed by collector |
| Native TS | TypeScript/unit/format/lint | Packed SDK on Node/Bun/Deno, native direct/broker execution | Linux execution is intentional, not proof on every desktop host |
| WASIX TS | TypeScript/unit/format/lint | Packed browser and native consumers, tools consumers | Independent package build delayed behind runtime/addon matrices |
| Swift | Linux portable tests; Apple platform tests; iOS broker compile check | XCFramework/source package; React Native app exercises the native backend | Public Swift `NativeRuntimeTests` suite disabled without env; `test-native` not hosted |
| Kotlin | JVM and Android unit tests, plugin check, lint/format | Maven package; React Native app exercises the native backend | `NativeBindingsTest` assumes prepared PGDATA and skips otherwise; owner task not hosted |
| React Native | TS/unit, C++ tests, codegen | Packed consumer, actual Android/iOS app builds and installed E2E | Retain distinct device/platform checks; these caught actual product failures |
| Shared query / native bindings / mobile bindings | Shared protocol tests and Rust/TS source gates | Included in dependent SDK package closures | Mobile bindings' native broker roundtrip task not hosted |

Five currently unreachable integration tasks are confirmed against the expanded
task graph and the actual check/test matrix writer, including explicit
Postmaster workflow roots:

- `oliphaunt-rust:test-integration`
- `oliphaunt-swift:test-native`
- `oliphaunt-kotlin:test-native-bindings`
- `oliphaunt-mobile-bindings:test-native`
- `oliphaunt-wasix-rust:test-integration`

This does **not** mean the runtimes or mobile broker are untested: installed
consumers, native extension lifecycle, AOT, and mobile app E2E already execute.
It means those particular SDK guarantees are not provided by their existing
dedicated tests. Compare coverage before wiring overlapping suites wholesale.
The broker's separate local `test-integration` is not another such gap: its
`postgres_client` test is exercised by the hosted `test-consumer` wrapper.

Docs generation and public-site checks have a separate delivery path, including
the release docs-refresh job. `docs:test` and `docs:test-package` are not selected
by the quality-tag adapter. Vercel's live deployment configuration was not
audited; do not claim GitHub's `Required` proves that site's build or availability.

## Correction inventory

P1: correctness/reliability or a demonstrated large recurring cost. P2: measured
efficiency/maintenance improvement. P3: small cleanup. Owners below are code
ownership areas, not invented individual assignees.

### CI-01 — P1 — Make runtime test ownership truthful

- [x] Wire the unique guarantees from the five tasks above into their SDK's
  artifact-consuming lane; remove or mark genuinely redundant local aliases.
- [x] Change selection tests to assert final executable roots/dependency closure,
  not merely that a task occurs in the affected-task inventory.

**Evidence:** `write-affected-moon-target-matrices.mts` selects quality/unit,
coverage and quality/static/format/smoke tags. The five tasks have neither
qualifying tags nor hosted `ci-` roots/dependents. The planner test at
`tools/ci/ci-plan-node-products.test.mts:448` asserts native Rust/Swift affected
selection, which passes without proving hosted execution. Swift's native suite
is env-disabled, Kotlin uses `assumeTrue`, and WASIX resource tests are ignored
unless explicitly requested.

**Owner:** SDK Moon tasks and `tools/ci`. **Done when:** full qualification and
relevant SDK-only changes select actual execution; a missing runtime fails the
runtime lane; the selected test count is positive; existing same-run artifacts
are consumed without compiling a second runtime. Preserve cheap unit lanes.

### CI-02 — P1 — Remove the deadline fixture's scheduling race

- [x] Give fixture preparation a separate budget from the deliberate child
  timeout; start/coordinate the timeout test after the child can actually run.
  Keep a separate deterministic assertion for an already-expired deadline.

**Evidence:** `tools/release/public-consumer-smoke.test.mts:103` grants the timeout
scenario 2 seconds including process startup/staging. The shell floors the
deadline to seconds and returns 1 if it expires before starting the child,
whereas the fixture expects 124 and a child PID. The full local release suite
has failed here repeatedly while isolated execution passed. This audit's
unchanged control passed; adding a two-second delay only before reading the
timeout scenario's context reproduced exit 1 and `shared public-consumer
deadline reached`.

**Owner:** release tools. **Done when:** delayed startup cannot turn this into a
false failure, while hanging descendants are still terminated and genuine
consumer failure is never retried. Do not delete the timeout/credential tests or
solve this by retrying the entire release suite.

### CI-03 — P1 — Provision the Android app's actual NDK before its build

- [x] Resolve Expo/React Native's intended Gradle `ndkVersion` and provision
  that exact version through the existing bounded SDK installer before Gradle.
- [x] Use one shared pin if platform compatibility allows it; otherwise make the
  native-runtime and Expo-app versions two explicit, owned requirements.

**Evidence:** [job 109274401218](https://github.com/f0rr0/oliphaunt/actions/runs/36523497369/job/109274401218)
successfully installed setup's `27.0.12077973`, then Gradle independently fetched
`27.1.12297006` and failed with `Archive is not a ZIP archive`. The same app
succeeded on rerun. `ANDROID_NDK_HOME` does not set the generated app's Gradle
version. The existing installer already has bounded retries; this second
download bypasses it.

**Owner:** Android setup and Expo runner. **Done when:** a clean runner has every
declared NDK before compilation and Gradle does no surprise NDK installation.
Do not silently change the released native ABI/toolchain merely to match Expo.
Android documents explicit selection via
[`android.ndkVersion`](https://developer.android.com/studio/projects/install-ndk).

### CI-04 — P1 — Use one WASIX lifecycle mode contract

- [x] Make the evidence table and qualification validator consume the same
  required mode definition, including materialization and physical backup/restore.

**Evidence:** `src/extensions/tools/extension-evidence.mts` declares five modes,
but `evidenceMatrix()` enumerates four and omits materialization. A real report
with materialization removed passes the table's current-evidence check and
fails candidate validation. The collector normally records all five, and the
candidate validator catches the omission: this is validator drift, not proof
that an incomplete release was published.

**Owner:** extension evidence contract, consumed by release qualification.
**Done when:** the same truncated report is rejected by both entry points; normal
reports pass; deliberate compatibility with frozen old report schemas remains
explicit. Reuse the existing contract module rather than add another registry.

### CI-05 — P1 — Put WASIX qualification dependencies in the task graph

- [x] Make the existing `oliphaunt-wasix-rust:test-regression` task the execution
  owner for fresh lifecycle observations and let the workflow collect its receipt.
- [x] Remove the hand-maintained four-producer insertion in
  `requiredTasksForAffected()` after graph-based selection replaces it.

**Evidence:** the collector runs `runtime-smoke.sh regression` directly, bypassing
the existing Moon task. `tools/ci/ci_plan.mts:298` separately inserts runtime AOT,
extension portable/AOT, and tools AOT dependencies. #222 repaired an actual
missed-input/selection failure here. The next new input should not require
another synchronized YAML/planner/script list.

**Owner:** WASIX Rust task + CI adapter. **Done when:** changing a required producer
changes the graph once, planner/transfer tests follow it, and qualification gets
fresh positive observations rather than a cached success without a receipt.

### CI-06 — P1 — Stop discarding Postmaster's compiler cache

- [x] Configure the existing Rust cache action for the actual Postmaster Cargo
  workspaces/target directories; expose its existing mapping input through
  `setup-rust` if needed. Include the browser-host custom Cargo directory in the
  same audit. Keep saved compiler state bounded and keyed to toolchain/source
  inputs; continue verifying produced artifacts.

**Evidence:** setup currently supplies `. -> target`. Postmaster compiles under
`target/oliphaunt-wasix-postmaster/runtime/...`, but that intermediate directory
is not a Cargo target root. The pinned cache action interprets it as a profile,
keeps only `build`, `.fingerprint` and `deps`, and removes its `runtime` child.
A fixture executing the pinned cleanup code confirmed that the nested compiled
artifact is deleted. The portable job restored an approximately 89 MB cache,
then spent **62m49s** in `runtime-build`; the cache saved afterward was still
approximately 89 MB. macOS runtime compilation took **27m42s**.

**Owner:** Rust setup and Postmaster/browser-host producers. **Done when:** a
second clean hosted run restores the intended compiler dependencies and shows
a material reduction in compilation time, with correct rebuilds after pin,
patch, compiler or target changes. Do not claim the whole 62 minutes is saved:
that task also performs other work. The native cache action already supports
[workspace/target mappings](https://github.com/Swatinem/rust-cache);
the inspected cleanup implementation is
[pinned here](https://github.com/Swatinem/rust-cache/blob/e18b497796c12c097a38f9edb9d0641fb99eee32/src/cleanup.ts).

### CI-07 — P1 — Persist compiler state for expensive native extension lanes

- [x] Extend the existing bounded extension ccache restore/save pattern first
  to Android; measure other targets before expanding it.

**Evidence:** the reusable extension workflow persists ccache only for
`ios-xcframework`, despite configuring it for other targets. The successful
Android arm64 extension job took **44.8 minutes**; ccache reported **73 hits /
6,168 cacheable calls (1.18%)**, 6,095 misses, and only about 0.1 GB used of its
2 GB limit. Android x86_64 took 37.7 minutes. This is a stronger optimization
candidate than deleting short regression tests.

**Owner:** native extension producers. **Done when:** unchanged-source warm runs
reuse a bounded cache, publish identical valid outputs and record hit/miss
statistics; compiler/source changes remain safe. Budget storage alongside CI-15.
Do not transfer final product qualification from a previous source commit.

### CI-08 — P2 — Honor manual cache-save policy in reusable workflows

- [x] Pass the parent workflow's resolved cache-save choice to reusable
  producers instead of recomputing it as push-only inside them.

**Evidence:** CI exposes `save_heavy_caches` for manual main qualification and
computes `HEAVY_CACHE_SAVE_IF` accordingly. `extension-artifacts-native.yml`
redefines it as `event == push && ref == main`; the manual opt-in cannot save
its iOS extension cache. The `setup-rust` wrapper likewise does not expose every
lower-level cache option, so each caller's effective policy needs checking.

**Owner:** CI reusable-workflow interfaces. **Done when:** main push, manual
opt-in, manual opt-out and PR cases have tested, consistent save behavior.

### CI-09 — P2 — Start independent WASIX packaging earlier

- [x] Run browser-host compilation and TS package production after source
  checks, then feed the package to artifact-dependent consumers.
- [x] Narrow Linux-only consumers' dependencies to Linux producers where the
  gain justifies the existing reusable-workflow partition pattern.

**Evidence:** the baseline's Linux AOT completed at about minute 67.5, but WASIX
regression waited for Windows AOT until minute 78.1: roughly 10.6 minutes of
unnecessary waiting for that consumer. Linux Node-API finished at minute 84.6;
the TS job waited for Windows until minute 91.8, then spent **6m34s compiling
the browser host** before package/browser tests. The host build has no runtime
artifact dependency. Native Linux consumers also depend on desktop aggregates
despite existing Linux partitions.

**Owner:** WASIX SDK and CI topology. **Done when:** the independent package
producer begins after cheap gates, each consumer waits only for bytes it uses,
and aggregate release gates still require every selected platform. These gains
improve feedback; they do not add directly to total wall-time savings while
Postmaster remains the critical path. Do not create a job per tiny task.

### CI-10 — P2 — Reduce Postmaster compile variants before cutting behavior tests

- [x] Consolidate equivalent Cargo feature/profile invocations in
  `src/wasix/postmaster/wasmer/tests.sh`; keep genuinely different feature tests.
- [ ] Measure remaining distinct feature/profile compilation costs on cold and
  warm hosted runs.
- [ ] After fixing cache layout, evaluate starting independent native host
  compilation before portable guest qualification completes, only if the
  remaining critical-path gain warrants the added artifact transfer.

**Evidence:** portable `runtime-patch-tests` took **23m31s**, alongside
`runtime-build` at 62m49s. The script invokes many filtered Cargo runs with
several repeated feature sets. The critical path was approximately 6.6 minutes
to start Postmaster, 72.1 portable-job minutes, 42.0 macOS-target minutes, then
aggregation. macOS's actual initdb stress and backend-wave stress were only
1m20s and 50s; immediate recovery took 34s. Deleting those tests first targets
the wrong cost and loses reliability coverage.

**Owner:** Postmaster. **Done when:** timings distinguish compilation from test
execution, equivalent invocations are grouped without losing named tests, and
warm/cold measurements justify any topology change. No promised percentage
saving until measured.

Second-pass correction: the 62m49s `runtime-build` duration was **not mostly
Rust compilation**. Its Docker APT layer alone took 39m52s; see CI-19. Fixing
the Rust cache alone would not remove that delay. Portable tasks also overlap,
so their individual durations must not be summed into a job duration.

### CI-11 — P2 — Make release evidence consistent without weakening admission

- [x] Decide and document which product guarantees need a candidate-bound
  receipt, then bind native lifecycle proof through the existing candidate
  record if native extensions require the same release-level guarantee.
- [x] Put WASIX regression under the E2E aggregate, alongside native lifecycle,
  while preserving the independent release-product requirement check.

**Evidence:** native lifecycle already validates exact source/tree, selected
extension/shard coverage, artifact hashes, direct/broker/server and lifecycle
PASS records. The real report had 39 extensions, three shards and 46 consumed
artifact hashes. It is enforced by CI but is not bound/replayed by publication
like WASIX evidence. Native evidence retention is 30 days, versus 90 for WASIX
and the candidate. WASIX is displayed as E2E but actually required by `Builds`.

The generic gate proves the jobs the plan selected; it does not independently
prove that the plan selected every product-required job. A synthetic incomplete
plan passed generic candidate coverage and was rejected by the separate WASIX
release requirement. Preserve that independent check. Runtime-specific receipt
contents can differ; shared source/run/attempt/digest binding should not.

**Owner:** release qualification + extension owners. **Done when:** omission,
wrong source/run, future attempts and missing modes fail consistently, retained
successful jobs from earlier attempts still work, and required evidence lasts
for the supported approval window. JSON revalidation is cheap and is not a
second lifecycle execution.

### CI-12 — P2 — Remove duplicated authoritative toolchain pins

- [x] Read Rust's default from `rust-toolchain.toml` and Android defaults from
  `tools/dev/android-sdk.toml` instead of repeating them in action inputs.
- [x] Review Node/Bun/Deno/npm/LLVM pin consumers for the same pattern; distinguish
  intentional fixture values from authoritative live configuration.

**Evidence:** Rust `1.93.1` appears in both the root toolchain and
`setup-rust-tools` default. Android's NDK/CMake/API defaults repeat the TOML.
`ci.yml` defines `NPM_VERSION` without a consumer in that workflow; release
publishing has its own live definition. Deno's caller and verified installer
also share a version contract. Manual parallel edits are avoidable.

**Owner:** tool installers. **Done when:** bumping the owner pin updates the
effective local and hosted setup; fixture pins remain explicit test inputs;
verification still rejects wrong versions. Do not substitute mutable latest.

### CI-13 — P2 — Install only the capabilities a lane consumes

- [x] Separate Android compilation setup from Java/Gradle checks and emulator
  execution using the existing setup action's narrow inputs/capabilities.
- [x] Disable Apple build-dependency installation in installed-app replay when
  it only needs Xcode/simulator tools.

**Evidence:** `setup-android` always provisions NDK and CMake. It is also used for
Kotlin formatting and installed-APK E2E, which do not compile native code.
Apple replay calls the general Apple action, whose build-dependency setup is
already optional. These are unnecessary download/failure opportunities even
when hosted images make the observed setup fast.

**Owner:** platform setup actions and capability tags. **Done when:** formatting
and APK replay succeed without native compiler installation, compilation still
receives its exact toolchain, and no second general provisioning layer appears.

### CI-14 — P2 — Make display names describe work and keep protocol IDs stable

- [x] Use short capability/owner group labels with full Moon targets in the job
  summary; do not concatenate every expanded project/task title.
- [x] Rename visible heterogeneous jobs and aggregates consistently: runtime
  producers, packages, consumers, lifecycle, qualification. Clarify mobile ABI
  jobs' seed-production responsibility and the mixed JS/ICU package job.
- [x] Use WASIX in human-facing runtime names; retain `.wasm` and upstream
  WebAssembly target terminology where technically correct. Migrate the public
  `wasm_target` dispatch input deliberately if renamed (retained for compatibility).

**Evidence:** a successful check job name was **384 characters**. Names include
`Builds / broker-runtime`, human-readable names, reusable caller prefixes, and
E2E under Builds. `Checks / Policy` combines release metadata, workflow behavior
and broker license auditing. These make failures harder to locate, without
adding useful proof.

**Owner:** CI adapter/display labels. **Done when:** names are short and stable,
the exact selected targets remain visible, and consumers of `Required`,
`Qualified`, `Builds` and other protocol identities continue to work.

### CI-15 — P2 — Budget caches and artifact retention by purpose

- [x] Skip Moon task-output cache transfers for jobs with no reusable local
  tasks; retain verified tool archive caching and validate the task graph.
- [ ] Fix directory effectiveness first, then bound/retire low-value cache
  entries using observed size and warm-run savings.
- [ ] Retain release inputs/proof for the supported window; give disposable
  intermediate/debug artifacts an explicit shorter policy where replay permits.

**Evidence:** the cache snapshot had **258 entries / 10.68 GB**: Rust caches
8.29 GB, Linux Wasmer LLVM 1.07 GB, 207 Moon entries only 0.23 GB. Numerous Moon
entries are nearly empty; the largest storage opportunity is not their count.
The baseline stored **114 artifacts / 2.07 GB**, including repeated envelopes
of native/iOS inputs and packaged outputs, many with default 90-day retention.
Some copies are necessary fan-out/release inputs; don't delete them by name.

**Owner:** CI artifact/cache consumers. **Done when:** each retained artifact has
a consumer and retention reason; warm-run benefits exceed restore/save costs;
expired evidence fails explicitly. Actual eviction/billing limits were not
queried, so 10.68 GB alone does not establish paid usage or thrashing. GitHub
documents [cache limits, immutability and eviction](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).

### CI-16 — P2 — Consolidate mobile execution definitions and drop dead setup

- [x] Share the installed-app execution/setup definition between main CI and
  manual mobile replay while retaining same-run versus explicit-run artifact
  resolution at their respective boundaries.
- [x] Delete the unused `.github/actions/collect-ci-summary/action.yml` unless
  a real caller is introduced as part of CI-14.

**Evidence:** Android/iOS steps, environment values, emulator configuration,
transport handling and report upload are maintained both in `ci.yml` and
`mobile-e2e.yml`. The latter has no workflow caller today but remains a useful
manual diagnostic entry point. It is not currently an automatic duplicate run.
`collect-ci-summary` has no references and merely prints command suggestions.

**Owner:** mobile CI adapter. **Done when:** normal CI and replay run the same
installed-app assertions, replay does not rebuild apps, and platform setup fixes
have one owner. Prefer one existing reusable workflow or a small composite
action; do not add both and a generator.

### CI-17 — P2 — Move fragile source acquisition out of late consumer work

- [x] Reuse the existing exact-pin source acquisition behavior for the WASIX
  browser host's upstream Git/crate downloads, with bounded retries and complete
  validation before package/consumer work.

**Evidence:** `src/wasix/browser-host/build-sdk.sh` owns its own Git fetch and two
one-shot `curl` downloads; they execute after the long runtime/addon dependency
chain. Digests and commits are checked, which is good. This audit did not
observe a browser-host network failure; this is a concrete unprotected path,
not a claimed measured flake rate.

**Owner:** browser-host producer, using `src/third-party` acquisition helpers.
**Done when:** transient download failures recover within a bound, invalid bytes
fail without replacing valid output, and exhausted failures occur in the
producer lane. No blanket test retries or unverifiable fallback source.

### CI-18 — P3 — Right-size source groups and deadlines after the major fixes

- [x] Run independent planner observations concurrently with a bounded native
  worker pool; retain output equivalence and fail the gate on a worker error.
- [ ] Keep capability grouping, but measure setup versus execution before
  changing group size; use bounded category-appropriate job deadlines.
- [ ] Review always-uncached deterministic release checks and duplicate package
  prerequisite invocations only after their complete inputs are declared.

**Evidence:** generic check/test jobs all allow 90 minutes although the baseline's
slowest source groups finished in roughly 6 minutes. Grouping is alphabetical,
up to eight static/four unit targets. `release-tools:test` and `metadata` are
uncached; most product unit checks are cached. Broker crate packaging invokes
Cargo packaging of query/bindings after declaring their package dependencies.
These are real cleanup candidates but much smaller than compiler costs.

**Owner:** source-task owners and CI capability adapter. **Done when:** a stuck
short source check stops promptly, cold setup has enough budget, and cached
checks invalidate on every input they actually consume. Don't add a historical
duration scheduler, force serial formatting before every unit test, or remove
valid cold-package checks to save seconds.

### CI-19 — P1 — Reuse the existing WASIX builder in Postmaster

- [x] Use the existing Buildx/GHA cache setup for both WASIX consumers, preserving
  Postmaster's recipe label and immutable recipe identity.
- [x] Prepare and validate the toolchain before expensive runtime compilation;
  bound the overall acquisition transaction as well as individual retries.
  `tools/dev/acquisition.sh` provides the common pattern and fault checks;
  [acquisition deadlines](../maintainers/testing.md#acquisition-deadlines)
  documents owner budgets and boundaries. A real cold Docker build completed
  the pinned TLS-verified APT transaction in 65.6 seconds and verified all
  compiler assets and their versions.

**Evidence:** `fresh_ensure_docker_image` in
`src/wasix/postmaster/lib/common.sh:1694` invokes a separate raw Docker build of
the same `src/wasix/runtime/assets/build/docker` recipe. Postmaster's workflow
does not restore the `wasix-builder` cache already used by the normal WASIX
producer. The sysroot step invokes this after six serial Cargo binary builds
in `src/wasix/postmaster/wasmer/bin/build-runtime.sh`.

In [the baseline portable job](https://github.com/f0rr0/oliphaunt/actions/runs/36492755110/job/109167195616),
the APT layer took **2,392.3 seconds**, including 133 MB downloaded in 23m16s.
The regular WASIX job's cached builder setup took **24 seconds**. The same
Postmaster APT layer took **64.1 seconds** on the release PR and **59.2 seconds**
on the current-main run. This is a demonstrated bad tail, not a typical
40-minute saving. The old install helper combined outer retries with APT retries
and per-request timeouts without a transaction-wide deadline. It now bounds
update, install and retry waits together to 15 minutes by default.

**Owner:** shared WASIX build-tool setup + Postmaster. **Done when:** both jobs
restore a compatible builder, a recipe change invalidates it, and Postmaster's
recipe-label validation still rejects stale images. Merely retagging the current
normal image is insufficient: it lacks Postmaster's required label. Use the
existing setup/cache policy; no registry, published builder product or new
promotion service. Docker's [GHA cache backend](https://docs.docker.com/build/cache/backends/gha/)
already supports the scoped reuse needed here.

### CI-20 — P1 — Stop turning documentation and unit-test edits into compiler work

- [x] Narrow producer inputs and distinguish source compilation, package content,
  unit fixtures and runtime qualification in the existing Moon task definitions.
- [x] Add small affected-selection regressions for these concrete boundaries.

**Evidence:** the pinned Moon query plus the actual `jobs-for-affected` planner,
run with one changed file at a time, selected:

| Changed existing file | Heavy jobs selected |
| --- | --- |
| `src/wasix/postmaster/README.md` | Full Postmaster portable and host pipeline |
| `src/wasix/postmaster/lib/durable-publication.test.mts` | Full Postmaster pipeline in addition to unit work |
| `src/wasix/sdks/ts/README.md` | WASIX portable, AOT, Node-API, extensions and TS consumers |
| `src/wasix/runtime/assets/build/docker/install-pinned-apt-packages.test.sh` | WASIX and Postmaster, plus native extension producers/packages |

Postmaster's carrier/portable/package inputs include broad project globs; the
runtime Docker input directory includes its tests. The planner then expands
required producer closures. Selecting the Postmaster job starts its explicitly
listed heavy workflow roots regardless of which narrow source edit caused it.

**Owner:** product Moon inputs first, CI planner only where the job envelope
cannot represent the resulting scope. **Done when:** a README still repackages
any package containing it, and a unit-test edit still runs that test, without
invalidating unrelated compilers. Compiler recipes, patches, source pins,
catalogs and real runtime tests must retain their full dependencies. Do not
solve this with repository-wide docs ignores or by skipping package integrity.
Selection alone does not prove all tasks rebuilt; Postmaster's uncached heavy
tasks and CI-21 show why these selections are nevertheless expensive today.

### CI-21 — P1 — Let WASIX reuse compatible compiler state across light commits

- [x] Add a compatible restore fallback to the existing compilation cache,
  scoped to all required compiler/profile inputs and trusted cache provenance.
- [x] Avoid running the uncached compiler prerequisite when a complete,
  validated matching output closure can be restored.

**Evidence:** `ci.yml`'s `Restore WASIX compilation cache` uses the head SHA as
its key and only the PR base / push-before / current SHA as its restore key.
There is no compatible prefix fallback. Manual dispatch searches the current
SHA twice. An intervening cheap workflow-only commit that saved no compilation
cache therefore breaks reuse of the previous heavy build.

The baseline saved a roughly 296 MB compilation cache for `7b192697`; current
main's manual run searched only `32ce7b29`, never that prior compatible key.
This establishes a lookup defect, not proof that the older entry could never
have been evicted. In the current-main WASIX log, `compiler-output` still took
**12m23s**, although downstream portable runtime, seeds, tools and extension
outputs restored in milliseconds. Its task hash matched the baseline.
`src/wasix/runtime/moon.yml:129` deliberately disables compiler-output caching
because generated container Makefiles reference `/work`; dependencies still
execute before cached downstream tasks.

**Owner:** WASIX compilation task/cache contract. **Done when:** an unchanged
compiler input after a docs/workflow commit or manual dispatch gets useful
reuse; changing sources/toolchain/flags cannot reuse incompatible output.
Keep exact-current-source qualification. Do not simply enable Moon caching on
the entire absolute-path compiler tree or accept old release receipts.

### CI-22 — P1 — Remove duplicate Linux builds from Android extension production

- [x] Reuse one matching Linux extension-support output across both Android
  ABIs, preferably from the existing Linux extension producer.
- [x] Let independent Android compilation proceed before the support input is
  needed for packaging; measure bounded overlap against runner CPU/memory.

**Evidence:** `package_android_target` in
`src/extensions/artifacts/native/tools/package-release-assets.sh:712` first calls
`build_mobile_host_extension_runtime`, then `build_mobile_static_artifacts`.
Both Android jobs build a Linux x64 PostgreSQL runtime with selected extensions;
the separate Linux extension job builds the same class of support output too.

| Baseline producer | Linux runtime phase | Android archive phase |
| --- | ---: | ---: |
| Android arm64 | 24m49s | 17m18s |
| Android x86_64 | 20m06s | 14m03s |
| Dedicated Linux x64 | 25m24s | — |

The two Android host phases alone consume **44m55s**. Existing iOS packaging
already overlaps host/device/simulator lanes. Android's host dependency is
real today: the artifact packager copies SQL/control/data **and host dynamic
modules**, alongside the Android static archives. A static-archive-only
replacement would violate the existing package layout; whether every host
module is needed by downstream mobile consumers remains a separate question.

**Owner:** native extension build/package boundary. **Done when:** both ABIs
consume matching catalog/version/feature support files, target archive and
platform checks pass, and measurements show reduced compute without a longer
Android critical path. Waiting for the whole Linux job before starting Android
compilation mostly trades duplicate compute for serial waiting. First use
compatible existing output/cache; do not add a generic build service or assume
the base runtime and extension-enabled runtime are interchangeable.

### CI-23 — P1 — Organize WASIX host production around each consuming host

- [x] Partition Linux consumer dependencies from other AOT/Node-API hosts using
  the pattern already used for native producers.
- [x] Prefer keeping same-host AOT and Node-API production/qualification together
  where that removes transfers and repeated setup without changing ABI needs.
- [x] Keep all-platform aggregation at the final release/qualification boundary.

**Evidence:** every Node-API host starts after the whole AOT matrix. Linux-only
regression also waits for Windows. The TS consumer then waits for every Node-API
host. Baseline Linux AOT was ready at minute **67.5**, but the matrix finished
at **78.1**; Linux Node-API finished at **84.6**, but TS started at **91.8**.
These are workflow barriers, not requirements to test Linux bytes.

**Owner:** WASIX Actions topology + existing task ownership. **Done when:**
Linux proof can finish while Windows/macOS builds continue, all selected hosts
remain mandatory at the final gate, and independent browser-host packaging
starts early (CI-09). Do not claim Rust build reuse across incompatible target
or glibc environments: Linux Node-API uses a compatibility-container boundary.
Avoid creating a separate job for every small task. This finding expands CI-09;
its savings must not be counted twice.

### CI-24 — P2 — Preserve safe local parallelism after artifact transfer

- [x] First reduce unnecessary transfer boundaries by colocating dependent
  same-host work. Then measure remaining serial local tasks before changing the
  existing execution adapter.
- [x] If material, execute only dependency-ready batches in the existing
  resolver, keeping transferred producers skipped and their consumers uncached.

**Evidence:** `.github/scripts/run-planned-moon-job.sh:55` loops through planned
targets with one `MOON_CACHE=off moon run --upstream none` invocation per target
when dependencies were transferred. This preserves ordering but serializes
independent local tasks. The Windows AOT step took **20m38s**, including
extension AOT 7m46s, core AOT 2m25s, pgwire AOT test 3m50s, integration 1m49s,
tools AOT 26s and Rust SDK AOT test 4m11s.

**Validation rejects a tempting shortcut:** in an isolated pinned-Moon fixture,
`moon run --upstream none a b c` started `c` before its declared `a`/`b`
prerequisites finished. Simply batching every root is incorrect. Moon's
[execution plan](https://moonrepo.dev/docs/guides/exec-plan) also does not provide
an already-completed-producer import primitive; target exclusion is documented
as forthcoming. Do not base this fix on an assumed scheduler feature.

**Owner:** existing artifact-transfer adapter. **Done when:** the small ordering
fixture passes, transferred producers never rerun, invalid transferred bytes
still fail, and measured wall time improves under actual CPU/Cargo-lock limits.
No new scheduler framework. The total serial duration is not the possible
saving; core saturation can make extra concurrency slower.

### CI-25 — P2 — Avoid rebuilding iOS to package an unchanged carrier for Android

- [x] Reuse verified frozen iOS carrier metadata when native iOS inputs and
  version have not changed; keep its ownership with the native carrier output.

**Evidence:** changing the real file
`src/native/sdks/kotlin/oliphaunt/src/androidMain/kotlin/dev/oliphaunt/OliphauntBrokerService.kt`
selects both Android and iOS runtime/ABI jobs. The dependency path is Android
app → React Native npm package → `finalize-runtime-ios-abi`.
`src/native/sdks/react-native/moon.yml:114` and
`tools/stage-release-artifacts.mts` in that project require iOS archive bytes to
generate the package's carrier manifest. This is a genuine integrity dependency,
not merely a redundant `needs` entry. The shared
`src/native/sdks/swift/tools/ios-carrier-manifest.mts:1120` already supports a
`baseCarrierManifest` input for a frozen base carrier.

**Owner:** native carrier metadata + React Native packaging. **Done when:** an
Android-only change uses the same complete canonical npm package contract
without recompiling unchanged Apple code, while a changed native carrier
regenerates and validates its manifest. Do not omit iOS files from a special
CI-only npm package or weaken archive hashes. No whole-baseline saving claimed:
Android extensions, not iOS runtime metadata, were that run's limiting input.

### CI-26 — P2 — Remove UI-driver overhead from self-running SDK smoke

- [x] Make the installed app's exact-launch structured result authoritative on
  both platforms, without requiring Maestro to read example status labels.
- [x] Reuse the existing continuous log capture and report validation, with
  failure precedence, process/capture failure detection and an overall deadline.

**Evidence:** `src/examples/native/react-native-expo/maestro/installed-smoke.yaml`
only waits for the passed label and asserts result labels. It performs no SDK
interaction or lifecycle transition; the app runs those tests itself. In
[baseline iOS E2E](https://github.com/f0rr0/oliphaunt/actions/runs/36492755110/job/109183796475),
the app reported all **39 extensions passing at 23:38:12.942**, about eight
seconds after launch. Maestro finished at **23:42:50.918**, another **4m38s**
later. Simulator preparation and uninstall/install accounted for additional
minutes; they are not all removable test execution.

The `run_maestro_installed_smoke` loop in
`src/native/sdks/react-native/tools/expo-runner-ios-installed-app.sh:51` has no
overall deadline while waiting for the driver; the flow timeout does not bound
driver startup. The existing non-Maestro branch is **not a safe drop-in**: it
polls the previous 30 seconds of logs, hardcodes the process name and checks
PASS before failure. Exact-launch continuous capture currently lives inside
the Maestro branch and should become the shared SDK-smoke mechanism.

**Owner:** installed-app runner, shared with manual replay (CI-16).
**Done when:** real app install/launch, SQL/extensions, ICU/resource and receipt
validation remain; stale PASS, explicit FAIL, crash, dead capture and missing
receipt all fail within a bound. Keep separate lifecycle tests. Retain Maestro
only for a real UI interaction guarantee if one is required. A bare switch to
the old log mode or accepting UI success alone would weaken correctness.

## Failure history: what to keep and what is already corrected

| Evidence | Interpretation | Current disposition |
| --- | --- | --- |
| [36523497369 Android](https://github.com/f0rr0/oliphaunt/actions/runs/36523497369/job/109274401218): corrupt NDK archive; same-source rerun succeeded | Confirmed infrastructure/acquisition flake | CI-03 exact-package repair and shared acquisition deadlines implemented; hosted verification pending |
| Public-consumer full local suite failed; unchanged isolated control passed; delayed-start probe failed | Confirmed timing-sensitive test harness | CI-02 corrected; delayed-start and expired-deadline fixtures pass |
| [36523497369 Qualified](https://github.com/f0rr0/oliphaunt/actions/runs/36523497369/job/109397213590): attempt-1 producer receipt rejected on attempt 3 | Qualification bookkeeping defect, not failed SDK behavior | Fixed in #225; preserve same-run/source and reject future attempts |
| [36518236951](https://github.com/f0rr0/oliphaunt/actions/runs/36518236951/job/109245492836): Apple carrier selection lost `PRODUCTS_JSON` and query failure was hidden | Release assembly defect | Fixed in #224 with workflow-step behavioral regression and real artifact replay |
| [36451399513](https://github.com/f0rr0/oliphaunt/actions/runs/36451399513) and [36451108400](https://github.com/f0rr0/oliphaunt/actions/runs/36451108400): missing Moon projects / skipped required WASIX regression | Planner/ownership drift | Immediate defects fixed in #222; structural correction remains CI-05 |
| [36449348921](https://github.com/f0rr0/oliphaunt/actions/runs/36449348921): declared npm carrier version rewrite rejected in `bun.lock` | Release normalization contract omitted valid derived data | Fixed in #220; keep semantic non-version-change rejection |
| [36240045462](https://github.com/f0rr0/oliphaunt/actions/runs/36240045462/job/108405753480): browser `instant` panic during WASIX initdb | Useful real browser execution failure | Later complete candidate passed; do not remove browser execution as flaky |
| [36348549841](https://github.com/f0rr0/oliphaunt/actions/runs/36348549841): Windows `fsync` unresolved symbol; iOS missing `backupDataForJsi:completion:` selector | Real platform compilation defects | Later complete candidate passed; retain platform link/app builds |
| [36345320273](https://github.com/f0rr0/oliphaunt/actions/runs/36345320273): Windows import-library contract unit failures | Useful cheap contract gate | Caught before expensive producers; not evidence of a flaky test |
| [36310991740](https://github.com/f0rr0/oliphaunt/actions/runs/36310991740): WASIX `clang --version` SIGPIPE/source-fingerprint rejection; Android backend exited before ReadyForQuery | Build/runtime failures; log is not enough to classify these as harmless infrastructure | Preserve regression coverage; investigate the exact signature if it recurs; do not add automatic success retries |
| [36227119157](https://github.com/f0rr0/oliphaunt/actions/runs/36227119157/job/108374367397): iOS app preparation/build failed | Earlier app packaging failure | Later candidate passed; the terminal job summary alone does not prove a remaining defect |

The retry semantics now used by #225 fit GitHub's model: a rerun retains the
original source SHA/ref and can rerun just failed jobs. See
[GitHub's rerun documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).
Earlier successful job evidence must remain usable without accepting another
run, source commit, or future attempt.

## Verification ROI and ordering decisions

| Verification | Decision | Reason |
| --- | --- | --- |
| Workflow syntax/security and real planner behavior | Keep early | Cheap; actual planning failures justify it. Test final execution, not only intermediate lists |
| Source-only formatting/unit/lint before expensive producers | Keep | Already mostly correct; don't replace with speculative all-platform setup |
| Packed package reopening / clean consumer | Keep | Source tests cannot detect omitted files, bad exports or installed resource discovery |
| Native extension lifecycle plus WASIX lifecycle | Keep | Different runtimes and loading/materialization behavior; not interchangeable |
| Representative AOT execution on all supported hosts | Keep | Portable/Linux success does not prove host machine-code deserialization/execution |
| Exhaustive extension catalog on every AOT host | Do not add | Current Linux exhaustive + per-host representative split is right-sized |
| iOS and Android app builds/E2E | Keep | Platform constraints differ; real app builds caught defects that portable tests did not |
| Maestro reading self-running example status labels | Remove from SDK qualification after CI-26 | No unique SDK interaction; exact-launch app receipts already carry the result. Preserve authoritative failure handling |
| Rust consumer built with stubs, then real embedded carriers | Keep distinct guarantees | Compile/package closure versus resource-free installed execution; the second build was about 24 seconds in the baseline |
| Source tests replayed at publication | Do not reintroduce | Current frozen-candidate publication avoids the old blanket replay |
| Digest/identity/registry checks after artifact transfer or approval | Keep | Validate new bytes or mutable external state; not repeated source qualification |
| PR release qualification + exact merge qualification | Retain current guarantee | Combined sample cost was 1,565.5 runner-minutes, but different source identities are intentional. Reusing compiler outputs is the first optimization, not accepting a PR receipt as main |
| Main push plus manual full dispatch for the same SHA | Avoid operationally when an adequate run already exists | Concurrency serializes non-PR same-SHA runs; it does not deduplicate them. Release already has a missing-qualification resolver |
| Source spelling/prose assertions | No blanket deletion proposed | Reviewed matches were mostly parsed contracts, generated outputs, logs or behavioral results, not proof that arbitrary source strings should stay unchanged |
| Unused summary action | Delete | No caller or unique proof |

The earlier September audit's blanket problems should not be carried forward
as if still present: main pushes now use affected scope, the focused workflow
PR above ran in about four minutes, release metadata and mutation tests have
separate owners, frozen publication avoids rebuilding the candidate, and the
manual mobile replay is not automatically fired after normal CI.

## Recommended execution order

1. **Remove long setup/recompilation tails:** CI-19, CI-06, CI-21 and CI-08.
   These use existing builder/cache facilities and attack both long branches.
2. **Stop selecting work that did not change:** CI-20. Prove documentation,
   unit-test, SDK-only and compiler-input boundaries with the actual planner.
3. **Shorten the second critical path:** CI-09/23 together. Measure again before
   adding Postmaster overlap (CI-10) or changing the transfer adapter (CI-24).
4. **Shorten mobile feedback:** CI-07/22, then CI-26 and CI-25. Distinguish saved
   runner time from end-to-end Android/iOS completion time.
5. **In parallel with those priorities, fix correctness:** CI-01 through CI-05
   and CI-11. Coverage and admission defects do not become optional because
   they are not timing improvements.
6. **Then routine maintenance:** CI-12 through CI-18. Naming, small validators
   and unused setup are worthwhile, but do not lead a wall-time initiative.

Measure each structural change on a complete full run and a focused PR, with
cold versus compatible-warm caches identified. Reuse the existing job and phase
timestamps; no benchmark service is needed. Compare the final `Required`/
`Qualified` finish, the new longest chain, setup/compiler/test time and total
runner-minutes. A successful isolated job speedup is insufficient if a newly
introduced prerequisite delays the consumer. The present sample cannot support
a defensible whole-pipeline percentage or p95 promise.

Defer catalog-test sharding until it becomes a limiting stage. WASIX regression
spent 8m53s in the library's full extension tests and 2m17s in server extension
tests; useful behavior dominates those sections. The existing native shard
pattern is available if required later, but additional WASIX jobs would repeat
Rust setup/compilation and need complete aggregate evidence. Do not remove
extension materialization/restart/restore coverage or shard every small suite.

Complexity cuts, ranked by recurring maintenance value: **shrink** the manual
WASIX dependency insertion into its existing Moon owner; **shrink** duplicate
evidence mode rules into the existing contract; **shrink** duplicated mobile
execution definitions; **native** use the existing Rust-cache directory mapping;
**delete** the unused summary action. No credible net line/dependency saving is
claimed before implementation; several valuable fixes are configuration or
coverage corrections rather than deletions.

## Audit validation and limits

Executed during this audit:

- Real pinned Moon `query projects`, `query tasks` and `task-graph --json`, the
  current CI config mapper, and the actual check/test matrix writer.
- Dependency reachability probe confirming the five SDK tasks are absent from
  hosted roots, with explicit workflow-owned Postmaster tasks accounted for.
- Unchanged public-consumer fixture: pass; same fixture with delayed timeout
  setup: expected reproduction of the current false failure.
- Pinned Rust-cache cleanup fixture: confirmed deletion of the custom nested
  compiler artifact under the current root-workspace mapping.
- Read-only GitHub run/job/step/artifact/cache inspection; selected causal logs
  and complete successful baseline timings.
- Second-pass phase attribution across Postmaster portable/host, normal WASIX,
  Windows AOT/Node-API, both Android extension ABIs, Linux extension production
  and iOS installed-app execution. Compared the slow Postmaster APT layer with
  two faster runs instead of treating the slow sample as a fixed saving.
- One-file affected queries for both READMEs, the Postmaster unit test, the APT
  installer test and an existing Android Kotlin implementation file; passed
  directly affected tasks to the real planner with the expanded project/task
  graph. No tracked files were modified to simulate these changes.
- Isolated pinned-Moon artifact-transfer fixture: a/b depend on an imported
  producer; c depends on a/b. Confirmed `--upstream none a b c` skips dependency
  ordering and fails c, ruling out the naive batch-all replacement.
- Prior same-tree evidence probes: native receipt verified; missing native PASS
  markers rejected; incomplete WASIX materialization accepted by table but
  rejected by candidate; incomplete product-required plan rejected at release.

The temporary audit inputs and probes are under
`/tmp/oliphaunt-ci-audit-2026-09-29`; prior receipt probes are under
`/tmp/oliphaunt-evidence-audit`. They are local scratch evidence, not release
artifacts or a new maintained testing framework. GitHub links and exact source
locations above provide the durable provenance.

The audit itself changed no product code, CI workflow, repository setting, cache
entry or release, and launched no expensive build matrix. The subsequent local
CI/setup correction batch is recorded at the top of this document.
Whole-system inventory does not imply exhaustive line-by-line review of every
test body. No statistical flake rate, runner cost in currency, live registry
publication success, or Vercel configuration correctness is inferred from this
sample.
