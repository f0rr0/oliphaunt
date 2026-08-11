---
name: release-oliphaunt
description: Prepare, audit, bootstrap, publish, verify, or recover Oliphaunt releases across GitHub, crates.io, npm, JSR, Maven Central, and SwiftPM. Use for release PRs, version bumps, changelogs, registry setup, publication failures, missing tags/packages, or first-release work.
---

# Release Oliphaunt

Treat a release as a frozen, exact-SHA promotion of already-qualified
artifacts. Never rebuild binary producer outputs or substitute artifacts.
Normal publish may deterministically reassemble carrier packages only from the
same qualified inputs, and the resulting publication lock must byte-match the
approved dry-run lock; bootstrap publishes the approved capsule bytes directly.

Select release products and versions from the publication catalog and
product-local metadata. PostgreSQL 18 contrib SQL members belong to the single
runtime-bound `oliphaunt-extension-contrib-pg18` product; they remain exact
member artifacts inside its target carriers rather than leaf release products.
External extensions own independent packaging SemVer and record their upstream
source identity separately. Never infer one repository-wide extension version,
and do not treat target/ecosystem carriers as additional products.

## Start

1. Read `docs/maintainers/release.md` and `references/invariants.md`.
2. For registry/GitHub setup, identity bootstrap, or trusted-publisher work,
   also read `docs/maintainers/release-setup.md`.
3. For a failed or partially public release, also read `references/recovery.md` before changing state.
4. Record the candidate commit with `git rev-parse HEAD`; keep that SHA
   unchanged through qualification, lock creation, publish, and any retry. A
   later commit cannot control or finish this release.
5. Inspect `git status`, product versions, existing product tags/releases, registry identities, and the latest exact-SHA CI run. Report any public collision before attempting a mutation.
6. Run `tools/dev/bun.sh tools/release/audit-github-release-controls.mjs` with the truthful credential lifecycle before any external mutation. Use `--governance solo --bootstrap-state idle` for qualification, release-PR preparation, and dry-run while bootstrap tokens are absent. Rerun with `--bootstrap-state ready` only for an imminent first-identity bootstrap after every reviewed short-lived token required by the approved lock is installed (one registry or both). If exact inventory proves that all selected Cargo/npm identities already match, keep the credential lifecycle `idle` and provision neither token. Use `retired` after trusted publishers are configured and every provisioned token is revoked. Select `team` only with an independent maintainer. Treat `FAIL` as a blocker; report but do not promote `WARN` to a solo-release blocker.
7. Generate trusted-publisher work from the approved publication lock with `tools/dev/bun.sh tools/release/trusted-publisher-config.mjs`. Its default mode is offline/read-only. Use authenticated `--audit` before considering `--apply`; mutation additionally requires the exact printed lock digest. Run npm audit and apply directly in a terminal because each classification pass starts with a discarded read-only TTY authentication warm-up before the bounded captured reads, and supply a fresh `--output` path for the atomically created mode-`0600` JSON evidence. Configure the direct workflow `release.yml` and `release-publish` environment. Keep release credentials only in their protected environments; do not add repository-level copies or a reusable-workflow secret bridge.
8. On a generated release PR, treat Release Please as the direct-candidate
   authority and `sync-release-pr.mjs` as the deterministic dependent-candidate
   closer. Inspect its dependency-only changelog reasons; do not manually copy
   candidates, broaden build-only Moon scopes, or guess a first version for a
   dependent still at `0.0.0`. Before preparation, require
   `release-please-pr-lifecycle.mjs assert-clean` to report no merged `main` PR
   still pending. Before bootstrap or normal publication mutates public state,
   require `assert-markable` for the exact release SHA. Reassert it immediately
   before promotion; after promotion, require the exact release PR to be
   `autorelease: tagged` with `autorelease: pending` absent.

## Choose the operation

Do not stack mutating release dispatches. GitHub concurrency protects the
active mutation but retains only one pending run, so a newer dispatch can
replace an older pending dispatch. Wait for the active bootstrap, publish, or
release-PR mutation to finish before starting another.

Treat `.github/workflows/release.yml` as the sole release workflow. Its
credential-bearing jobs directly select their protected environments. Its
environment-free, secret-free bootstrap-continuation dispatcher consumes only
the typed output of `publish-bootstrap` and dispatches the sealed exact-parent
pointer. Normal publish has no continuation dispatcher and recovery reruns the
exact same release commit.

A root `publish-bootstrap` or `publish` dispatch must run from the qualified
current `main` commit. At the mutation boundary the transport helper first
reads `oliphaunt-release-transport/<full-sha>` and accepts only a lightweight
direct-commit tag at that exact SHA. When the tag is absent, or the root is on
its first run attempt, the helper must reverify current `main` before it may
create or accept the tag; creating an absent tag is the root generation's first
mutation. Only a genuine GitHub rerun (`GITHUB_RUN_ATTEMPT > 1`) of the exact
root operation, original `refs/heads/main` workflow SHA, and empty continuation
may reuse an already exact tag after `main` advances. Wrong, annotated, or
missing tags fail closed, and a missing tag always requires the current-main
proof even on a rerun.
The tag is the immutable transaction ref: never update or delete it. Every
bootstrap continuation targets and validates that exact tag, SHA, tree, and
sealed parent state instead of reconsulting moving `main`. A later ordinary
merge does not invalidate an already pinned release transaction. Bootstrap's
`contents: write` permission exists solely so
the root bootstrap job can create this transport tag and must not be used for
another repository mutation.

- Prepare: synchronize release-owned files, run release checks, create the generated release PR, and stop for review.
- Bootstrap: use the dedicated bootstrap environment only for identities that cannot use trusted publishing until their first package exists, including generated part identities introduced by a future lock. For npm, require a short-lived granular token with explicit `@oliphaunt` scope selection, Packages and scopes `Read and write`, and 2FA bypass, owned by a 2FA-enabled actor with scope write access; an ordinary token can authenticate yet fail the noninteractive publish with `EOTP`. Require one successful exact-SHA dry-run containing both `oliphaunt-publication-lock` and `oliphaunt-bootstrap-capsule`; select one run ID, verify the capsule's embedded lock against the separately downloaded lock, and publish only those frozen Cargo/npm bytes without rebuilding. Inventory the exact lock first. Model crates.io's documented token bucket; never accept an unverifiable numeric capacity assertion. Execute one sequential Cargo lane and one sequential npm lane, overlap only independent carriers, and preserve every lock dependency as a barrier. If one hosted job cannot finish, flush and upload the canonical hash-chained checkpoint before a separate credential-free job dispatches a bounded exact-parent continuation. Bind it to release/lock/package identity and exact artifact ID/digest/size, and permit zero-progress recursion only for explicitly typed, finite-budget rate-limit/deadline continuations. A valid `429 Retry-After` may defer; ambiguous uploads, timeouts, integrity mismatches, malformed responses, and checkpoint failures remain hard failures. After every identity has a receipt, use that exact lock with `tools/release/trusted-publisher-config.mjs`: its default plan has no network access, `--audit` is read-only, and mutation requires both `--apply` and the exact `--confirm-lock-digest`. Run npm audit/apply in a real TTY and retain each fresh `--output` JSON report, never the discarded authentication warm-up display. Require workflow `release.yml`, environment `release-publish`, and npm publish-only permission; reject extra or mismatched configurations. Revoke long-lived credentials, then resume normal publish.
- Publish: require a successful exact-SHA `Qualified` gate, complete artifact
  set, frozen publication lock, and exact Release Please PR markability proof.
  Pin the immutable transport, stage GitHub drafts/assets/attestations, attempt
  the complete dependency-ordered registry plan once, verify public consumers,
  and promote last in one protected job. Do not predict registry capacity or
  create a normal checkpoint, continuation, or phase handoff. Honor a valid
  `Retry-After` while the deadline permits. If the run stops, the maintainer
  uses GitHub's rerun on the original Release run at the exact same commit;
  byte-prove matching immutable state and publish only what remains absent.
  Reuse a complete verified bootstrap ledger, assemble an exhaustive exact-lock
  receipt set, and preserve receipt-bound public-consumer evidence. npm's
  trusted credential cannot move dist-tags, so publish each exact npm version
  with its normal tag.
- Recover: inventory external state first, then rerun root `publish` at the
  exact same release commit with the same qualified artifacts and approved
  lock. Use GitHub's rerun for the original failed Release run, not a fresh
  dispatch after `main` moves; the original run and referenced artifacts must
  still be available. Prove and skip matching immutable state; publish only
  what remains absent. A required code fix creates a new candidate and follows
  normal versioning. Bootstrap retains its separate checkpoint recovery.

## Local gates

If the candidate changes WASIX source pins, build recipes, toolchain inputs, or
producer code, require the product-owned portable/AOT build and runtime checks.

Run these from the repository root:

```sh
tools/dev/bun.sh tools/release/release-check.mjs
cargo run -p xtask -- assets verify-committed
tools/dev/bun.sh src/extensions/tools/check-extension-model.mjs --check
```

Release Please selects direct candidates from configured product paths. Review
that selection against the shipped behavior; if shared code changes bytes for a
product outside the selected paths, move or represent the change under the
owner before releasing. Do not add repository-meta fingerprints to force a
candidate.

For a normalized generated release PR, sync follows only Moon production/peer
edges and directed compatibility source-to-owner edges. Native and WASIX are
independent. A direct external-extension candidate therefore stays minimal,
while a runtime candidate may require separately versioned consumers with
exact compatibility fields. An unversioned first-release dependent is a
Release Please/configuration blocker, not permission to weaken the graph.

```sh
tools/dev/bun.sh tools/release/sync-release-pr.mjs
tools/dev/bun.sh tools/release/sync-release-pr.mjs --check
```

Use the protected `publish-dry-run` operation to assemble carriers and create,
freeze, and verify the publication lock from exact-SHA artifacts.

The committed extension evidence table may say `requires-exact-candidate-ci`; that is an honest pre-qualification state, not permission to skip the lane. The selected CI run must provide the current evidence artifact. Do not use `--allow-dirty` for release evidence. Do not publish from a local rebuild, a different workflow run, a branch name, or a moving ref.

After a first-identity bootstrap seals, run the trusted-publisher helper without
flags first and record its exact `lockDigest` and npm batch count. Audit Cargo
and every npm batch before explicit apply, rerun the same batch after an
interruption, and retain final reports showing no missing or conflicting
configuration. Require registry publisher workflow `release.yml`, environment
`release-publish`, and the exact npm publish-only permission.

## Handoff

State the candidate SHA, immutable release transport tag, selected products and
versions, exact CI run, lock digest, registry/bootstrap state, completed
publication phases, and any remaining irreversible action. Distinguish product
releases from target/ecosystem carrier packages.
