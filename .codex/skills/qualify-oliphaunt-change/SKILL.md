---
name: qualify-oliphaunt-change
description: Select, run, and diagnose Oliphaunt local and GitHub CI qualification for code, package, extension, SDK, policy, workflow, or release changes. Use before merge/release, when checks are slow or duplicated, or when an exact commit must be proven publishable.
---

# Qualify Oliphaunt Change

Use the repository graph to select work and require exact-SHA qualification for releases.
CI's `release_products_json` input selects stable product IDs and their Moon
task/dependency closure. Keep platform selectors at `all`; a focused platform
debug run cannot qualify publication. Empty product selection remains the
exhaustive audit. Selected-product records must cover every published product;
producer evidence still comes from the same candidate run.
Generated same-repository Release PRs and their merged main release commits
derive scope automatically from Release Please manifest changes. Main push
qualifies only after Plan and Required succeed; PR results cannot be published.

## Local feedback

1. Inspect the diff and ask Moon for affected projects/tasks. Do not infer affected products from directory names alone.
2. Run affected formatting (`format-check`, `js-format-check`, or
   `rust-format-check`), `lint`, `typecheck`, and `test` tasks as applicable.
   Inspect the owner's actual task definitions before selecting `build`,
   `package`, `test-consumer`, `test-integration`, `test-browser`, or installed
   device tests. Let Moon build declared prerequisites; task names alone do
   not justify running every available lane.
3. If the diff changes a WASIX producer's source pins, patches, recipes,
   toolchain or code, qualify that owner's affected portable/AOT output. Reuse
   compiler outputs only when their declared source, dependency and toolchain
   identities still match. A package envelope or test-only edit alone does not
   justify rebuilding unrelated core, tools or extension producers.
4. Select release-policy checks by the contract that changed:

```sh
# Product/release metadata only:
moon run release-tools:metadata

# Release implementation changes:
moon run release-tools:test

# Release Please candidate ownership/version selection changes:
moon run release-tools:graph-unit

# Workflow and CI planning changes:
moon run ci-workflows:check

# Release metadata and release implementation tests:
bash tools/release/release-check.sh

# Extension catalog, recipe, carrier, or generated extension metadata only:
moon run extensions:lint extensions:test
```

Select only the checks whose inputs changed. `release-tools:metadata` validates
product versions, compatibility, carrier declarations and derived files;
`release-tools:test` exercises release behavior; `graph-unit` exercises the
pinned Release Please candidate integration. `release-tools:check` is their
local Moon aggregate. There is no separate policy test project. The Shell
aggregate runs metadata and release tests, not product compilation or installed
consumer qualification. CI's `Checks / Policy` job runs on Ubuntu and sets up
only capabilities needed by its selected tasks. Workflow planning, affectedness,
artifact-transfer and security checks belong to `ci-workflows:check`.
Publishers consume source qualification and frozen artifacts instead of
replaying source-only suites. Do not schedule both aggregates and their
constituent checks in the same lane.
`tools/ci/ci_plan.mts` writes `target/graph/ci-plan.json`; there is no
`graph-tools` Moon project. The adapter consumes Moon's selected tasks; its
behavioral tests do not replace planning against the actual candidate tree.

Ordinary source pushes, PR preparation and CI qualification do not select the
protected `release-bootstrap` environment. Bootstrap-token lifecycle findings
from the optional release-controls audit are setup/publication findings, not
source-qualification blockers. Preserve the actual CI ref, permission and
artifact checks; do not provision, remove or relabel registry credentials to
make an unrelated source run pass.

For source-acquisition policy or a source `mirror_url`, run
`bash third-party/tools/source-fetch-core.test.sh` and
`bash third-party/tools/fetch-sources.sh production-all --validate-only`, or the
complete owner task `moon run source-inputs:test`. The paired Shell test owns
actual Git/archive operations and invokes its TypeScript assertions once. Prove a
new endpoint with a live exact-commit fetch, but keep reachability out of the
deterministic unit gate. Qualification must show bounded canonical-to-mirror
failover, exact-pin rejection, canonical durable origin, and transactional
preservation of an existing checkout when every endpoint fails.

5. For any workflow or local-action change, run
   `bash tools/ci/check-workflows.sh` before waiting for CI. This is the
   repository's exact pinned `actionlint` plus `zizmor` gate and its workflow
   behavior tests; running `actionlint` alone is not sufficient. A disposable
   credential-free workflow compiler probe is needed only when a release candidate
   changes hosted-only job topology, permissions, protected environments, or
   dispatch inputs. The local gate cannot prove hosted environment-secret
   resolution or dispatch-time graph compilation.
   Exercise macOS-executed Shell paths with the Bash actually selected by that
   job, recording `command -v bash` and `bash --version`. `shell: bash` alone
   does not establish a version. Normal release/Apple setup does not install
   another Bash; the WASIX postmaster target job explicitly installs Homebrew
   Bash. Keep focused Bash 3.2 behavioral checks for scripts claiming macOS
   `/bin/bash` compatibility, including `set -u` empty-array behavior. Do not
   impose the entire Linux release-tool suite on Bash 3.2. Syntax checks do not
   replace actual Apple transport or publication-path behavior.
6. Declare runner capabilities on the narrowest Moon task that needs them. Use
   `requires-rust` for Cargo, rustc, rustfmt, or another Rust-toolchain command;
   `requires-maintainer-tools` for the pinned tools installed by
   `tools/dev/bootstrap-tools.sh`; and `requires-android-sdk` for Android SDK work.
   Use `requires-swift` for the portable Swift compiler; add `requires-apple`
   only for Xcode, Apple frameworks, simulators or other Apple-only work.
   Portable Swift source checks use the pinned Linux Swift setup.
   Capabilities propagate through task dependencies. The planner keeps
   capability-bearing checks grouped only with tasks requiring the same setup.
7. Treat a hosted runner-image pin as a toolchain dependency. Never introduce a mutable `*-latest` alias; after changing an explicit runner pin, inspect the image delta and run the platform binary contract for every affected release target.

For a WASIX Docker, APT snapshot, or bootstrap trust change, also run the
product-owned fault test and source verifier before the expensive build:

```sh
bash third-party/tools/fetch-sources.sh wasix-runtime --verify-only
moon run liboliphaunt-wasix:build-orchestration-test liboliphaunt-wasix:test
```

Then use `liboliphaunt-wasix:compiler-output`, `runtime-portable` and
`runtime-aot` for the actual selected producer proof. Optional PostgreSQL tools
and extensions have separate owner producers; do not restore those as core
runtime build prerequisites. For a Docker trust change, build the pinned
Dockerfile from a clean builder context. Require a
successful TLS-verified snapshot transaction and the exact declared wasixcc,
Clang, and Binaryen versions; a source/static check alone does not prove
that the pinned trust chain still reaches the snapshot service.

For an SDK change, run each affected
SDK's relevant source checks, `test`, and `package` tasks in one Moon invocation.
Their declared dependencies remain necessary; `package` does not silently rerun
unrelated source qualification. Set
`MOON_BASE` and `MOON_HEAD`, inspect affected SDK projects, and pass the exact
targets to `moon run`; a workspace-wide selector also selects non-SDK products.
Confirm ownership with `moon query tasks --project <sdk-project>` when changing
task topology. Never replace the product task with a narrower native command:
for example, `cargo test -p oliphaunt --lib` omits other Cargo targets selected
by the owner task. Carrier producers copy the canonical C header; real consumers
compile against it instead of running a separate layout gate. Add
the product's explicit runtime or installed-host tests when that proof is needed, and run
`moon run extensions:lint extensions:test` when an extension catalog or generated SDK
extension surface changes. Put new guarantees in a parsed schema/generated
contract where consumers require one, a clean-consumer package check, or a
product-owned behavioral test. Do
not qualify SDK behavior by grepping prose, test names, or
implementation-source spellings.

## GitHub qualification

- Identify runs by workflow plus exact `headSha`; never accept “latest successful on branch.”
- A manual exact-main dispatch compares against `format('{0}^', github.sha)`,
  the dispatched commit's immutable sole parent. Never fall back to
  `origin/main` for a main dispatch: after a merge that moving ref is the
  dispatched head itself and turns release-intent validation into an invalid
  self-comparison. Non-main diagnostic dispatches retain their explicit
  comparison to current `origin/main`.
- The `pull_request.closed` event is a runnerless cancellation tombstone. It
  shares the PR concurrency group so merging cancels obsolete PR work, while
  every root and `always()` aggregate job skips before runner allocation. It
  cannot refund PR work that already completed. For an explicitly authorized
  one-hosted-run recovery, keep CI disabled through every intermediate update
  and the final merge, then enable it and manually dispatch exactly once from
  the final `main` SHA. Do not also create a push run: non-PR runs for the same
  SHA serialize rather than cancel one another.
- The release prerequisite is the non-cancelled `Qualified` gate for that SHA, including required checks, builds, policy, tests, and selected E2E.
- When WASIX or an extension is selected, require the same-run full lifecycle evidence artifact. It must cover every catalogued extension in direct, server, restart, materialization, and physical backup/restore modes and satisfy `--require-current-evidence` for the candidate source digest.
- Ensure artifact attestations and the publication lock reference the same SHA/tree.
- Require artifact evidence for the compatibility floors in
  `docs/maintainers/release.md`: inspect Mach-O load commands, Android API/ELF
  metadata, and Linux ELF symbol versions rather than inferring support from a
  runner or package label.
- Do not rerun duplicate downstream E2E workflows when the same evidence is already part of the required gate.
- On failure, inspect the failing job log and earliest causal error. Fix the cause, push a new SHA, and restart qualification; do not reuse artifacts from the failed SHA.

## Report

List commands and outcomes, skipped lanes with reasons, exact GitHub run/SHA, required gate state, produced artifact/lock evidence, WASIX lifecycle evidence when selected, and residual platform gaps. “Green CI” without exact-SHA and gate names is not release evidence.
