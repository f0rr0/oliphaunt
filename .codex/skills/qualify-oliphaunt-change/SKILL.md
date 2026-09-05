---
name: qualify-oliphaunt-change
description: Select, run, and diagnose Oliphaunt local and GitHub CI qualification for code, package, extension, SDK, policy, workflow, or release changes. Use before merge/release, when checks are slow or duplicated, or when an exact commit must be proven publishable.
---

# Qualify Oliphaunt Change

Use the repository graph to select work, but require the full exact-SHA gate for releases.

## Local feedback

1. Inspect the diff and ask Moon for affected projects/tasks. Do not infer affected products from directory names alone.
2. Run affected formatting (`format-check`, `js-format-check`, or
   `rust-format-check`), `lint`, `compile`, `unit`, and `package` tasks
   independently. Run producer, smoke, regression, and E2E lanes only when
   their inputs or public behavior changed.
3. If the diff changes WASIX source pins, patches, build recipes, the toolchain,
   or producer code, run the product-owned source checks and portable/AOT build.
   Version, changelog, package-description, smoke-expectation, and
   target-envelope-only changes do not require that expensive build.
4. Select release-policy checks by the contract that changed:

```sh
# Product/release metadata only:
moon run release-tools:metadata

# Release implementation changes:
moon run release-tools:unit

# Moon/release graph topology changes:
moon run release-tools:graph-unit

# Repository policy implementation changes:
moon run policy-tools:unit

# Exact release candidate (metadata plus both unit suites):
tools/dev/bun.sh tools/release/release-check.mjs

# Committed generated runtime assets only:
cargo run -p xtask -- assets verify-committed

# Extension catalog, recipe, carrier, or generated extension metadata only:
moon run extensions:lint extensions:unit
```

Do not run all three for an unrelated package or version edit. The repository
release-policy gate runs structure, graph, metadata, and mutation checks; it is
not product build/test/package qualification. `release-tools:check` is the local
aggregate of metadata plus the release and policy unit suites. Hosted CI runs
metadata on the publication host, gives workflow/planner tests to
`ci-workflows:check`, and selects release or policy units only when their actual
implementation inputs change. Release workflows invoke the combined runner
directly for an exact candidate. Do not schedule both forms in one lane.
The macOS publication-host metadata job is affected-only on pull requests and
mandatory on exhaustive push/manual runs; product source alone does not justify
that toolchain setup unless it changes release metadata or graph inputs.
`tools/graph/ci_plan.mjs` writes `target/graph/ci-plan.json`; there is no
`graph-tools` Moon project. Do not substitute policy unit tests: they prove the
classifiers but do not scan the candidate tree.

For source-acquisition policy or a source `mirror_url`, run
`tools/dev/bun.sh test src/sources/tools/source-fetch-core.test.mjs` and
`tools/dev/bun.sh src/sources/tools/fetch-sources.mjs all --validate-only`. Prove a
new endpoint with a live exact-commit fetch, but keep reachability out of the
deterministic unit gate. Qualification must show bounded canonical-to-mirror
failover, exact-pin rejection, canonical durable origin, and transactional
preservation of an existing checkout when every endpoint fails.

5. For any workflow or local-action change, run
   `bash tools/policy/check-workflows.sh` before waiting for CI. This is the
   repository's exact pinned `actionlint` plus `zizmor` gate and its workflow
   behavior tests; running `actionlint` alone is not sufficient. A disposable
   `publish-dry-run` compiler probe is needed only when a release candidate
   changes hosted-only job topology, permissions, protected environments, or
   dispatch inputs. The local gate cannot prove hosted environment-secret
   resolution or dispatch-time graph compilation.
   When a changed release shell block is expected to run on macOS, run its
   focused behavioral test with GNU Bash 3.2. Run the complete release-policy
   gate under Bash 3.2 only for a release candidate. On macOS, omit the override;
   elsewhere, point `OLIPHAUNT_BASH3` at a maintained local Bash 3.2 build:

   ```sh
   bash3="${OLIPHAUNT_BASH3:-/bin/bash}"
   case "$bash3" in
     /*) ;;
     */*) bash3="$(cd "$(dirname "$bash3")" && pwd -P)/$(basename "$bash3")" ;;
     *) bash3="$(command -v "$bash3")" ;;
   esac
   "$bash3" -c '((BASH_VERSINFO[0] == 3 && BASH_VERSINFO[1] == 2))'
   PATH="$(dirname "$bash3"):$PATH" \
     OLIPHAUNT_TEST_BASH="$bash3" \
     "$bash3" tools/dev/bun.sh tools/release/release-check.mjs
   ```

   This behavioral gate is authoritative for Bash 3.2 `set -u` empty-array
   semantics; a syntax check or a source-pattern check is not a substitute.
6. Declare runner capabilities on the narrowest Moon task that needs them. Use
   `requires-rust` for Cargo, rustc, rustfmt, or another Rust-toolchain command;
   `requires-maintainer-tools` for the pinned tools installed by
   `tools/dev/bootstrap-tools.sh`; and `requires-android-sdk` for Android SDK work.
   Use `requires-apple` for Swift, Xcode, or Apple-platform work.
   Capabilities propagate through task dependencies. The planner keeps
   capability-bearing checks grouped only with tasks requiring the same setup.
7. Treat a hosted runner-image pin as a toolchain dependency. Never introduce a mutable `*-latest` alias; after changing an explicit runner pin, inspect the image delta and run the platform binary contract for every affected release target.

For a WASIX Docker, APT snapshot, or bootstrap trust change, also run the
product-owned fault test and source verifier before the expensive build:

```sh
bash src/runtimes/liboliphaunt/wasix/assets/build/docker/install-pinned-apt-packages.test.sh
tools/dev/bun.sh src/sources/tools/fetch-sources.mjs wasix-runtime --verify-only
cargo run -p xtask -- assets source-spine --strict-local
```

Then build the pinned Dockerfile from a clean builder context. Require a
successful TLS-verified snapshot transaction and the exact declared wasixcc,
Clang, and Binaryen versions; a source-spine/static check alone does not prove
that the pinned trust chain still reaches the snapshot service.

For an SDK change, run `moon run sdk-contracts:check`, then run each affected
SDK's `compile`, `unit`, and `package` tasks in one Moon invocation. These tasks
are independent; `package` does not silently rerun source qualification. Set
`MOON_BASE` and `MOON_HEAD`, inspect affected SDK projects, and pass the exact
targets to `moon run`; a workspace-wide selector also selects non-SDK products.
Confirm ownership with `moon query tasks --project <sdk-project>` when changing
task topology. Never replace the product task with a narrower native command:
for example, `cargo test -p oliphaunt --lib` excludes Rust executable tests under
`src/bin/**`, while `moon run oliphaunt-rust:unit` includes the library,
executable, integration, build-crate, and documentation tests. Add
the product's `qualify` task when the complete product replay is needed, and run
`moon run extensions:lint extensions:unit` when an extension catalog or generated SDK
extension surface changes. Put new guarantees in a parsed schema/generated
contract, clean-consumer package check, or product-owned behavioral test. Do
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
- When WASIX or an extension is selected, require the same-run full lifecycle evidence artifact. It must cover every catalogued extension in direct, server, restart, materialization, and dump/restore modes and satisfy `--require-current-evidence` for the candidate source digest.
- Ensure artifact attestations and the publication lock reference the same SHA/tree.
- Require artifact evidence for the compatibility floors in
  `docs/maintainers/release.md`: inspect Mach-O load commands, Android API/ELF
  metadata, and Linux ELF symbol versions rather than inferring support from a
  runner or package label.
- Do not rerun duplicate downstream E2E workflows when the same evidence is already part of the required gate.
- On failure, inspect the failing job log and earliest causal error. Fix the cause, push a new SHA, and restart qualification; do not reuse artifacts from the failed SHA.

## Report

List commands and outcomes, skipped lanes with reasons, exact GitHub run/SHA, required gate state, produced artifact/lock evidence, WASIX lifecycle evidence when selected, and residual platform gaps. “Green CI” without exact-SHA and gate names is not release evidence.
