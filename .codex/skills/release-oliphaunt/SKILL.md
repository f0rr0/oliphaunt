---
name: release-oliphaunt
description: Prepare, audit, bootstrap, publish, verify, or recover Oliphaunt releases across GitHub, crates.io, npm, Maven Central, and SwiftPM. Use for release PRs, version bumps, changelogs, registry setup, publication failures, missing tags/packages, or first-release work.
---

# Release Oliphaunt

Treat a release as a frozen, exact-SHA promotion of already-qualified
artifacts. Never rebuild binary producer outputs or substitute artifacts.
The `publish` operation prepares the complete candidate once, conditionally
bootstraps missing names, and publishes it. Dependent jobs install the same
immutable candidate and verify its complete contents against the lock.

Qualification may be exhaustive or selected through CI's
`release_products_json` input with every platform selector at `all`. The
existing candidate record binds product scope, required tasks and exact SHA;
publication rejects a product outside that scope. Generated release PRs and
their main merge derive scope automatically from the actual manifest transition;
only main push or eligible main dispatch can produce publishable evidence.
Publication first reuses covering completed CI or awaits an active main/requested
run. If none exists, a separate dispatch-only job requests CI for the selected
products, provided main still equals the exact candidate SHA. Failed causal
runs stop with their URL; resume by rerunning that run. An ambiguous dispatch
is never retried automatically. Cross-commit binary reuse remains pending.

Local checks use `bash tools/release/release-check.sh` for source
metadata/release-tool tests and `bash tools/release/release-check-registries.sh
--products-json JSON --head-ref REF` for selected registry state. These commands
do not publish or assemble a release candidate; test fixtures may create local
packages. Product rehearsal uses the selected owners' package and artifact/consumer
tasks. Candidate preparation runs on Ubuntu, consuming qualified outputs without
product compilers. Publication uses macOS for its actual public Swift consumer,
not for portable release metadata. Candidate preparation verifies qualification once,
checks registry state once, and checks that the source is still clean at its
exact SHA immediately before assembly. Publication retains its live registry
recheck at the mutation boundary.

Select release products and versions from the publication catalog and
product-local metadata. PostgreSQL 18 contrib SQL members belong to the logical
`oliphaunt-extension-contrib-pg18` distribution, not an independently versioned
release product. Its native and WASIX carriers inherit the corresponding
runtime product version; members remain exact nested artifacts.
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
   product change requires fresh qualification. A narrowly permitted
   publication-only controller fix may reuse the unchanged approved candidate.
5. Inspect `git status`, product versions, existing product tags/releases, registry identities, and the latest exact-SHA CI run. Report any public collision before attempting a mutation.
6. Use `bash tools/dev/bun.sh tools/release/audit-github-release-controls.mts`
   for release setup and before public registry/tag/asset mutation, with the
   truthful credential lifecycle. It is not a gate for ordinary branch pushes,
   release-PR preparation or CI qualification: those jobs do not receive the
   protected `release-bootstrap` secrets. Record unrelated setup findings
   without stopping source work or changing credentials. For publication, use
   `--governance solo --bootstrap-state idle` only when bootstrap tokens are
   absent. Use `ready` only for imminent first-identity bootstrap after every
   reviewed short-lived token required by the approved lock is installed.
   Provision neither token when the exact scope needs neither registry; use
   `retired` after trusted publishers are configured and provisioned tokens
   revoked. Select `team` only with an independent maintainer. Release-safety
   `FAIL` findings block the affected public mutation; `WARN` does not become a
   solo-release blocker. The bootstrap job still checks required credentials
   against the approved lock immediately before it publishes.
7. Generate trusted-publisher work from the approved publication lock with `bash tools/release/trusted-publisher-config.sh`. Its default mode is offline/read-only. Use authenticated `--audit` before considering `--apply`; mutation additionally requires the exact printed lock digest. Run npm audit and apply directly in a terminal because each classification pass starts with a discarded read-only TTY authentication warm-up before the bounded captured reads, and supply a fresh `--output` path for the atomically created mode-`0600` JSON evidence. Configure the direct workflow `release.yml` and `release-publish` environment. Keep release credentials only in their protected environments; do not add repository-level copies or a reusable-workflow secret bridge.
8. On a generated release PR, treat Release Please as the candidate authority
   and `sync-release-pr.mts` as the deterministic selected-candidate metadata
   closer. The pinned Release Please library selects shared-contrib candidates
   through the declared release-ownership graph; sync chooses no new versions
   or changelogs. Ordinary task dependencies are not automatic release bumps.
   In an isolated clean checkout, `bash tools/release/prepare-release-pr.sh OUTPUT_DIR`
   generates locally. If `OUTPUT_DIR/required` is `true`,
   `bash tools/release/close-release-candidate.sh OUTPUT_DIR` commits locally,
   closes manifests and locks, and verifies the candidate. These commands read
   GitHub metadata but do not push. Only the workflow
   `.github/scripts/publish-release-pr.sh OUTPUT_DIR` mutates the remote PR,
   after local validation succeeds. The preparation entrypoint already checks
   that no merged `main` release PR is still pending; do not repeat that check
   as a separate preparation phase. Before bootstrap or normal publication mutates public state,
   require `assert-markable` for the exact release SHA. Reassert it immediately
   before promotion; after promotion, require the exact release PR to be
   `autorelease: tagged` with `autorelease: pending` absent.

## Choose the operation

Do not stack mutating release dispatches. GitHub concurrency protects the
active mutation but retains only one pending run, so a newer dispatch can
replace an older pending dispatch. Wait for the active bootstrap, publish, or
release-PR mutation to finish before starting another.

Treat `.github/workflows/release.yml` as the sole release workflow. Its
credential-bearing jobs directly select their protected environments.
Bootstrap and normal recovery rerun the original failed workflow run at the
same release commit and frozen candidate.

A root `publish` dispatch must run from the qualified
current `main` commit. At the mutation boundary the transport helper first
reads `oliphaunt-release-transport/<full-sha>` and accepts only a lightweight
direct-commit tag at that exact SHA. When the tag is absent, or the root is on
its first run attempt, the helper must reverify current `main` before it may
create or accept the tag; creating an absent tag is the root generation's first
mutation. Only a genuine GitHub rerun (`GITHUB_RUN_ATTEMPT > 1`) of the exact
root operation and original `refs/heads/main` workflow SHA
may reuse an already exact tag after `main` advances. Wrong, annotated, or
missing tags fail closed, and a missing tag always requires the current-main
proof even on a rerun.
The tag is the immutable transaction ref: never update or delete it. A rerun
validates that exact tag, SHA, tree, approved candidate, and ledger instead of
reconsulting moving `main`. A later ordinary merge does not invalidate an
already pinned release transaction. Bootstrap's
`contents: write` permission exists solely so
the root bootstrap job can create this transport tag and must not be used for
another repository mutation.

- Prepare: synchronize release-owned files, run release checks, create the generated release PR, and stop for review.
- Bootstrap: use the dedicated bootstrap environment only for identities that cannot use trusted publishing until their first package exists, including generated part identities introduced by a future lock. For npm, require a short-lived granular token with explicit `@oliphaunt` scope selection, Packages and scopes `Read and write`, and 2FA bypass, owned by a 2FA-enabled actor with scope write access; an ordinary token can authenticate yet fail the noninteractive publish with `EOTP`. The `publish` operation prepares `oliphaunt-publication-lock` and `oliphaunt-publication-candidate` first, then passes immutable artifact IDs to this conditional job. Publish only those frozen Cargo/npm bytes without rebuilding. Inventory the exact lock first and freeze only wholly absent names into the carrier-level bootstrap ledger; leave existing names awaiting the locked version for normal trusted publication. Provision only the registry token required by that scope. On rerun, a scoped name that exists without the exact version is a conflict. Model crates.io's documented token bucket; never accept an unverifiable numeric capacity assertion. Execute one sequential Cargo lane and one sequential npm lane, overlap only independent carriers, and preserve dependencies within the absent-name scope. A scoped npm package may leave an optional dependency on an existing name to the normal trusted-publication graph; other unavailable locked dependencies fail closed. If one hosted job cannot finish, drain in-flight uploads, reconcile receipts, upload the canonical hash-chained checkpoint, and fail as incomplete with the exact manual rerun command and not-before time. The maintainer reruns the failed job of that original workflow run; the rerun restores only the same release/lock/candidate identity and skips byte-matching public versions. A valid `429 Retry-After` may defer; ambiguous uploads, timeouts, integrity mismatches, malformed responses, and checkpoint failures remain hard failures. After every scoped identity has a receipt, use that exact lock with `tools/release/trusted-publisher-config.sh`: its default plan has no network access, `--audit` is read-only, and mutation requires both `--apply` and the exact `--confirm-lock-digest`. Run npm audit/apply in a real TTY and retain each fresh `--output` JSON report, never the discarded authentication warm-up display. Require workflow `release.yml`, environment `release-publish`, and npm publish-only permission; reject extra or mismatched configurations. Publication continues automatically. Configure trusted publishers and revoke bootstrap credentials before the next release.
- Publish: prepare the frozen candidate, bootstrap absent Cargo/npm names if
  needed, then publish in the same run. Require a successful exact-SHA `Qualified` gate, complete artifact
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
  exact same release commit with the same approved publication candidate. Use
  GitHub's rerun for the original failed Release run, not a fresh
  dispatch after `main` moves; the original run and referenced artifacts must
  still be available. Prove and skip matching immutable state; publish only
  what remains absent. Product fixes require a new candidate and normal
  versioning. A publication-only fix may dispatch `publish` with the original
  `release_commit` and `approval_run_id`; the previous run must have completed
  with a successful candidate preparation job (or a successful legacy dry-run). Bootstrap uses the same manual rerun rule and its
  lock-bound checkpoint chain.

## Local gates

If the candidate changes WASIX source pins, build recipes, toolchain inputs, or
producer code, require the product-owned portable/AOT build and runtime checks.

Run these from the repository root:

```sh
bash tools/release/release-check.sh
bash extensions/tools/check-extension-model.sh --check
```

Release Please selects direct candidates from configured product paths. The
ownership plugin also supplies commits affecting declared shared shipped sources,
bounded by each product's published history. Review that selection against the
actual changed behavior; correct missing ownership in the graph rather than
copying source or adding repository-meta fingerprints to force a candidate.

For a normalized generated release PR, ordinary Moon task dependencies affect
qualification; declared release ownership controls shared-source candidate
selection. Native, WASIX, SDKs, bindings, resources, tools and external extensions are
independently versioned. Sync updates compatibility pins only for consumers
already selected by Release Please, using the dependency versions qualified at
that commit; unselected consumers retain their older published pins. A selected
consumer's dependency must be selected at the exact pinned version or already
published with matching tag and carrier bytes.

```sh
bash tools/release/sync-release-pr.sh
bash tools/release/sync-release-pr.sh --check
```

Use `publish` to prepare and freeze the complete candidate from exact-SHA
artifacts, bootstrap absent names if needed, and publish in the same run. The
operator supplies a prior candidate run ID only for recovery.

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
