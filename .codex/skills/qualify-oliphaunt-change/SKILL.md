---
name: qualify-oliphaunt-change
description: Select, run, and diagnose Oliphaunt local and GitHub CI qualification for code, package, extension, SDK, policy, workflow, or release changes. Use before merge/release, when checks are slow or duplicated, or when an exact commit must be proven publishable.
---

# Qualify Oliphaunt Change

Use the repository graph to select work, but require the full exact-SHA gate for releases.

## Local feedback

1. Inspect the diff and ask Moon for affected projects/tasks. Do not infer affected products from directory names alone.
2. Run formatting/static checks and focused unit/package tests first. Run expensive producer/E2E lanes only when their inputs or release contract changed.
3. If the diff intentionally changes WASIX binary-semantic inputs (source pins,
   patches, build recipes, the WASIX toolchain, or producer code), refresh the
   committed fingerprint before qualification with
   `cargo run -p xtask -- assets input-fingerprint --write`. Do not refresh it
   for version, changelog, package-description, smoke-expectation, or
   target-envelope-only changes. See `docs/maintainers/assets.md`.
4. For any release, package identity, workflow, version, or extension change, run:

```sh
tools/dev/bun.sh tools/release/release-check.mjs
cargo run -p xtask -- assets verify-committed
tools/dev/bun.sh src/extensions/tools/check-extension-model.mjs --check
```

The canonical `release-check` runs the live repository-structure and uncached
repository-graph policies before release metadata and mutation tests. Its
uncached `release-tools:check` Moon task is the single hosted graph-validation
owner; `graph-tools:check` remains a focused local target and
`graph-tools:generate` is the sole writer of `target/graph`. Do not substitute
the policy unit tests: they prove the classifiers but do not scan the candidate
tree.

For source-acquisition policy or a source `mirror_url`, run
`tools/dev/bun.sh test tools/policy/source-fetch-core.test.mjs` and
`tools/dev/bun.sh tools/policy/fetch-sources.mjs all --validate-only`. Prove a
new endpoint with a live exact-commit fetch, but keep reachability out of the
deterministic unit gate. Qualification must show bounded canonical-to-mirror
failover, exact-pin rejection, canonical durable origin, and transactional
preservation of an existing checkout when every endpoint fails.

5. For any workflow or local-action change, run
   `bash tools/policy/check-workflows.sh` before waiting for CI. This is the
   repository's exact pinned `actionlint` plus `zizmor` gate and its workflow
   behavior tests; running `actionlint` alone is not sufficient. If the direct
   release job graph, job permissions, protected environment, dispatch input,
   or continuation dependency changed, also push the exact candidate to a
   disposable branch and dispatch one supported `publish-dry-run` compiler
   probe. Require GitHub to materialize the direct job graph, then cancel it
   before expensive qualification and delete the probe branch. The local gate
   cannot prove hosted environment-secret resolution or dispatch-time graph
   compilation.
   When a release workflow shell block or a shell script transitively reached by
   `release-check` changes, run the complete gate with GNU Bash 3.2, matching
   `/bin/bash` on the `macos-26` release runner. On macOS, omit the override;
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
   `ci-rust` for Cargo, rustc, rustfmt, or another Rust-toolchain command;
   `ci-maintainer-tools` for the pinned tools installed by
   `tools/dev/bootstrap-tools.sh`; and `ci-android-sdk` for Android SDK work.
   Capabilities propagate through task dependencies. The planner keeps
   capability-bearing checks dedicated and combines only compatible static
   checks into bounded shards.
7. Treat a hosted runner-image pin as a toolchain dependency. Never introduce a mutable `*-latest` alias; after changing an explicit runner pin, inspect the image delta and run the platform binary contract for every affected release target.

For a WASIX Docker, APT snapshot, or bootstrap trust change, also run the
product-owned fault test and source verifier before the expensive build:

```sh
bash src/runtimes/liboliphaunt/wasix/assets/build/docker/install-pinned-apt-packages.test.sh
tools/dev/bun.sh tools/policy/fetch-sources.mjs wasix-runtime --verify-only
cargo run -p xtask -- assets source-spine --strict-local
```

Then build the pinned Dockerfile from a clean builder context. Require a
successful TLS-verified snapshot transaction and the exact declared wasixcc,
Clang, and Binaryen versions; a source-spine/static check alone does not prove
that the pinned trust chain still reaches the snapshot service.

For an SDK change, run `moon run sdk-contracts:check`, then run every affected
SDK's `package` target in one Moon invocation. SDK package targets own their
same-project `check` and `test` dependencies, so this is the compact product
gate without the platform artifact or E2E matrix. Set `MOON_BASE` and
`MOON_HEAD`, then select SDK project IDs with
`moon query projects --affected --downstream deep --tags sdk --tasks package`.
Pass the exact `<project>:package` targets to `moon run`; a workspace-wide
`:package` selector also selects non-SDK products and is not this lane. Confirm
ownership with
`moon query tasks --project <sdk-project> --id package` when changing task
topology. Never replace the product task with a narrower native command: for
example, `cargo test -p oliphaunt --lib` excludes Rust executable tests under
`src/bin/**`, while `moon run oliphaunt-rust:test` includes the library,
executable, integration, build-crate, and documentation tests. Add
`release-check` when package or registry behavior changes, and run
`moon run extension-model:check` when an extension catalog or generated SDK
extension surface changes. Put new guarantees in a parsed schema/generated
contract, clean-consumer package check, or product-owned behavioral test. Do
not qualify SDK behavior by grepping prose, test names, or
implementation-source spellings.

Advisory cleanup is not qualification. Use
`moon run dev-tools:helper-reference-audit` or
`moon run dev-tools:source-reference-audit` when intentionally looking for
possibly unreferenced helpers or modules, then inspect each result before
removing it. Do not turn reference counts into a required CI gate.

## GitHub qualification

- Identify runs by workflow plus exact `headSha`; never accept “latest successful on branch.”
- The release prerequisite is the non-cancelled `Qualified` gate for that SHA, including required checks, builds, policy, tests, and selected E2E.
- When WASIX or an extension is selected, require the same-run full lifecycle evidence artifact. It must cover every promoted extension in direct, server, restart, materialization, and dump/restore modes and satisfy `--require-current-evidence` for the candidate source digest.
- Ensure artifact attestations and the publication lock reference the same SHA/tree.
- Require artifact evidence for the compatibility floors in
  `docs/maintainers/release.md`: inspect Mach-O load commands, Android API/ELF
  metadata, and Linux ELF symbol versions rather than inferring support from a
  runner or package label.
- Do not rerun duplicate downstream E2E workflows when the same evidence is already part of the required gate.
- On failure, inspect the failing job log and earliest causal error. Fix the cause, push a new SHA, and restart qualification; do not reuse artifacts from the failed SHA.

## Report

List commands and outcomes, skipped lanes with reasons, exact GitHub run/SHA, required gate state, produced artifact/lock evidence, WASIX lifecycle evidence when selected, and residual platform gaps. “Green CI” without exact-SHA and gate names is not release evidence.
