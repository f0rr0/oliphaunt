---
name: qualify-oliphaunt-change
description: Select, run, and diagnose Oliphaunt local and GitHub CI qualification for code, package, extension, SDK, policy, workflow, or release changes. Use before merge/release, when checks are slow or duplicated, or when an exact commit must be proven publishable.
---

# Qualify Oliphaunt Change

Use stock Bazel targets and the owner's configured shipping export. Bazel's
actual action graph and cache determine what executes; directory ownership,
conventional dependency declarations and test dependencies do not select product
releases. Native preparation compares qualified deliveries with each product's
authenticated completed publication, then supplies necessary owners to Release
Please for version and changelog calculation. Missing history stays unknown.

`Native Bazel qualification / Required` is the release entrypoint's source gate.
The migration still needs complete hosted platform/device qualification, the
27-product construction audit, the genuine seed adoption anchor and legacy CI
retirement. A local test, individual job or construction audit does not admit a
publication. PR and merge-queue evidence cannot assert reviewed-main assurance.

## Local feedback

1. Read the changed owner's `BUILD.bazel`, actual configured dependencies and
   shipping export policy. Use the target and host profiles from
   `.github/workflows/bazel.yml`; do not invent a path-based affectedness map.
   Run only relevant targets and let Bazel reuse unchanged actions.
2. Start with source checks before expensive construction. On Linux x64 the
   declared profile is `//build_defs/native:linux_x86_64_glibc_2_28`:

   ```sh
   profile=//build_defs/native:linux_x86_64_glibc_2_28
   bash tools/dev/bazel.sh test \
     //:biome_format_test //:biome_lint_test //:rustfmt_test \
     //tools/ci:source_checks //tools/dev:source_checks \
     --platforms="$profile" --host_platform="$profile" --jobs=2
   ```

   Select the relevant checks from this list. Rust owners also expose Clippy,
   unit, integration and consumer targets; Clippy does not replace execution.
   Shipping qualification must name actual test rules, including manual tests,
   rather than relying on a `test_suite` to establish owner policy.
3. Select release-tool checks by the contract that changed:

   ```sh
   # Product/version and artifact declarations:
   bash tools/dev/bun.sh tools/release/check_release_please_config.mts
   bash tools/dev/bun.sh tools/release/check_artifact_targets.mts

   # Release controller and pinned Release Please behavior:
   bash tools/release/release-check.sh --mutation-tests-only

   # Metadata plus the release-owned controller suites:
   bash tools/release/release-check.sh

   # Extension catalog and derived metadata:
   bash tools/dev/bun.sh src/extensions/tools/check-extension-model.mts --check
   ```

   Run either the aggregate or its relevant constituents once. These checks do
   not compile products or qualify installed consumers. Workflow and local-action
   changes use `//tools/ci:source_checks`, whose pinned actionlint, zizmor and
   ShellCheck checks include behavioral regressions; actionlint alone is
   insufficient. Hosted permissions, environments and artifact handoffs still
   need actual exact-source CI proof.
4. For a producer source, patch, recipe or toolchain change, construct and test
   that owner's affected output. Package-only and test-only edits should reuse
   unchanged compiler outputs. Use `tools/bazel/README.md` for Linux native,
   WASIX AOT, browser and captured cross-host consumer commands. Keep module
   acquisition strict; ordinary commands verify `MODULE.bazel.lock`. Intentional
   repins update it with `bazel.sh mod deps --lockfile_mode=update` and review the
   resulting pins, rather than ignoring lock failures.
5. Run SDK tests against the actual constructed packages and their declared
   dependencies. Public carriers preserve held pins, even when a current
   workspace producer has the same version. Imported completed bytes need their
   genuine completion and physical identity. Current source compilation is
   separate from final installed admission: Swift preparation proves workspace
   source checks, while selected final Swift shipping also requires its exact
   installed consumer. Never relabel preparation proof as final proof.
6. Source acquisition changes require the paired Git/archive behavior test and
   deterministic policy check:

   ```sh
   bash src/third-party/tools/source-fetch-core.test.sh
   bash src/third-party/tools/fetch-sources.sh production-all --validate-only
   ```

   Prove a changed endpoint with one live exact-pin fetch. Require bounded
   canonical-to-mirror failover, exact-pin rejection and preservation of an
   existing checkout when all endpoints fail. Reachability does not belong in
   the deterministic unit gate. Declare required tools and SDKs through the
   owner's Bazel rule/toolchain, including execution-platform constraints.
7. Treat runner-image pins as toolchain inputs. Avoid mutable `*-latest` aliases.
   Check the actual ELF, Mach-O or Android API contract after a relevant change.
   Cross-compilation proves construction; native host/device execution remains
   separate. Record the Bash actually used by macOS Shell paths. Keep focused
   Bash 3.2 behavior checks where scripts claim that compatibility; do not impose
   the entire Linux controller suite on macOS `/bin/bash`.

Shared construction stays on Linux where reproducible. macOS and Windows own
licensed SDK work and native execution; Android/iOS behavior needs the actual
supported device or simulator. Use existing source-bound archive transports,
not another resolver, remote executor or hand-maintained product matrix.

## GitHub qualification

- Resolve the exact workflow, source SHA/tree, run, attempt and producing job;
  never accept “latest successful on branch.” Closed PR events cancel stale PR
  work and allocate no qualification runners.
- `bazel.yml` runs the source-owned configured exports. The release-inputs job
  acquires one immutable public-input pool for ordinary source or the canonical
  authenticated Prepare snapshot for a generated release tree. Each consumer
  validates and imports those same physical inputs.
- Required first checks all predecessor jobs, then audits retained construction
  across all 27 products. It does not require itself as a producer or grant
  publication authority. Missing producer, source, carrier, supplier or owner
  qualification coverage fails closed.
- A generated release PR or queued release tree must resolve the canonical
  Prepare producer and exact version-only source bridge. A mixed queue tree
  cannot substitute its branch name or synthetic title for that proof.
- Main preparation uses an exact successful Native run and Required gate.
  Publication additionally authenticates final selected outputs, complete
  supplier coverage and the prepared-source bridge. Selected Swift final
  admission requires the source-owned final export and installed consumer.
- Require the actual extension SQL/lifecycle, browser, host and device results
  declared by each owner. A passing build or ABI comparison alone does not
  replace those tests. Preserve final archives and seed receipt/frozen pairs;
  the full action DAG remains evidence even when cached intermediate objects
  are not materialized.
- Fix the earliest causal failure and qualify a new source SHA. Do not reuse a
  failed or wrong-source packet, widen scope from unknown facts, fabricate old
  constructor history or create another download path to bypass authentication.
- Pre-publication recovery may use an explicit exact-source qualification after
  allowlisted control fixes. Preserve original source/run/file identity and
  require the current controller's Native Required gate; never rebuild producers.

Ordinary branch work, source qualification and release-PR preparation do not use
`release-bootstrap` credentials. Setup findings do not justify provisioning or
relabeling credentials for an unrelated source run. Keep actual permission,
source and artifact checks intact.

## Declared requirements and frozen consumers

Conventional manifests own consumer requirements. Only observed compiled
incorporation, Release Please ecosystem updates and necessary explicit/default
install adoption justify generated retargets. ABI compatibility or co-selection
alone does not retarget a held consumer. Native, WASIX, resources, tools, SDKs,
bindings and external extensions retain independent versions.

External host references declare `public_support`. Removing a public host needs
breaking intent before version calculation and verification against its previous
immutable product tag. Private dependency changes do not automatically imply a
public breaking change.

Source qualification and candidate freezing precede `Frozen consumers` and
`Publication ready`; both gates are required before protected mutation. The
consumer proof binds the lock, expected cases, configuration and producing
run/attempt. Recovery imports the same bytes and reruns required consumers.
npm staging keeps complete manifests and historical pins; Cargo source patches
are staging evidence, not registry provenance. Retain public postpublication
checks and immutable-state reconciliation.

## Report

Report commands and outcomes, exact source/run identities, Required and consumer
gate states, original artifact/lock evidence and remaining platform gaps.
Distinguish construction, install, compile/link and execution proof. “Green CI”
without exact identity and gate names is not release evidence.
