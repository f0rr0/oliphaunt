---
name: release-oliphaunt
description: Prepare, audit, bootstrap, publish, verify, or recover Oliphaunt releases across GitHub, crates.io, npm, JSR, Maven Central, and SwiftPM. Use for release PRs, version bumps, changelogs, registry setup, publication failures, missing tags/packages, or first-release/history-repair work.
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
4. Record the candidate commit with `git rev-parse HEAD`; keep that SHA unchanged through qualification, lock creation, and publish.
5. Inspect `git status`, product versions, existing product tags/releases, registry identities, and the latest exact-SHA CI run. Report any public collision before attempting a mutation.
6. Run `tools/dev/bun.sh tools/release/audit-github-release-controls.mjs` with the truthful credential lifecycle before any external mutation. Use `--governance solo --bootstrap-state idle` for history repair, qualification, release-PR preparation, and dry-run while bootstrap tokens are absent. Rerun with `--bootstrap-state ready` only for an imminent first-identity bootstrap after every reviewed short-lived token required by the approved lock is installed (one registry or both; the current first release needs both); use `retired` after trusted publishers are configured and every provisioned token is revoked. Select `team` only with an independent maintainer. Treat `FAIL` as a blocker; report but do not promote `WARN` to a solo-release blocker.
7. Generate trusted-publisher work from the approved publication lock with `tools/dev/bun.sh tools/release/trusted-publisher-config.mjs`. Its default mode is offline/read-only. Use authenticated `--audit` before considering `--apply`; mutation additionally requires the exact printed lock digest. Configure the top-level caller `release.yml` and `release-publish` environment, never the reusable implementation filename.
8. On a generated release PR, treat Release Please as the direct-candidate
   authority and `sync-release-pr.mjs` as the deterministic dependent-candidate
   closer. Inspect its dependency-only changelog reasons; do not manually copy
   candidates, broaden build-only Moon scopes, or guess a first version for a
   dependent still at `0.0.0`.

## Choose the operation

Do not stack mutating release dispatches. GitHub concurrency protects the
active mutation but retains only one pending run, so a newer dispatch can
replace an older pending dispatch. Wait for the active bootstrap, publish, or
release-PR mutation to finish before starting another.

- Prepare: synchronize release-owned files, run release checks, create the generated release PR, and stop for review.
- Bootstrap: use the dedicated bootstrap environment only for identities that cannot use trusted publishing until their first package exists, including generated part identities introduced by a future lock. For npm, require a short-lived granular token with explicit `@oliphaunt` scope selection, Packages and scopes `Read and write`, and 2FA bypass, owned by a 2FA-enabled actor with scope write access; an ordinary token can authenticate yet fail the noninteractive publish with `EOTP`. Require one successful exact-SHA dry-run containing both `oliphaunt-publication-lock` and `oliphaunt-bootstrap-capsule`; select one run ID, verify the capsule's embedded lock against the separately downloaded lock, and publish only those frozen Cargo/npm bytes without rebuilding. Inventory the exact lock first. Model crates.io's documented token bucket; never accept an unverifiable numeric capacity assertion. Execute one sequential Cargo lane and one sequential npm lane, overlap only independent carriers, and preserve every lock dependency as a barrier. If one hosted job cannot finish, flush and upload the canonical hash-chained checkpoint before a separate credential-free job dispatches a bounded exact-parent continuation. Bind it to release/lock/package identity and exact artifact ID/digest/size, and permit zero-progress recursion only for explicitly typed, finite-budget rate-limit/deadline continuations. A valid `429 Retry-After` may defer; ambiguous uploads, timeouts, integrity mismatches, malformed responses, and checkpoint failures remain hard failures. After every identity has a receipt, use that exact lock with `tools/release/trusted-publisher-config.mjs`: its default plan has no network access, `--audit` is read-only, and mutation requires both `--apply` and the exact `--confirm-lock-digest`. Require caller `release.yml`, environment `release-publish`, and npm publish-only permission; reject extra or mismatched configurations. Revoke long-lived credentials, then resume normal publish.
- Publish: require a successful exact-SHA `Qualified` gate, complete artifact set with binary compatibility-floor evidence, current full-lifecycle WASIX evidence when selected, frozen publication lock, and the all-registry rate-aware admission preflight. Before the first mutation, build and validate the complete signed Maven Central bundle locally (including sources/javadocs and the strict size ceiling), and prove the lock-derived Swift semantic tag is absent or already resolves to the exact deterministic manifest commit. Normal publish remains logically ordered as stage GitHub drafts/assets/attestations, publish the exact registry topology, then verify public consumers and promote. A registry continuation may span hosted jobs but must reuse the original exact stage handoff and immutable checkpoint; finalization is disabled until receipts are exhaustive. Every normal continuation must also carry the latest root-lineage-bound GitHub content-write pacer and core-request journal, merge the child's pre-install reads monotonically, and reject reset, replay, or substitution. Transfer state only through manifest-exact artifacts downloaded by immutable ID: reuse the approved Cargo/npm capsule rather than retransferring its carriers, send only required non-capsule registry inputs in the stage handoff, and send receipts only to finalization. Reuse a complete verified bootstrap ledger rather than serially reproving its Cargo/npm identities. Execute one bounded sequential lane per registry, overlap independent lanes, honor cross-registry DAG barriers, and assemble callback-returned receipts into an exhaustive exact-lock receipt set (an empty topology is valid for source-only products). Model crates.io's version token bucket with upload work overlapping refill and treat only valid server `Retry-After` state as authoritative; never require an unverifiable capacity secret. After receipt verification, run the lock-derived anonymous public Cargo/npm/Maven/JSR and Git/Swift consumer lanes concurrently from fresh caches under one shared deadline; resolve each entry root independently, require its platform-independent resolver lock to cover the complete frozen dependency closure, retry only transient visibility/network failures in a new cache, preserve deterministic receipt-bound evidence, and then promote GitHub drafts as the literal final step. Distinguish resolver coverage from host-installed/fetched payloads; never relabel a missing lock dependency as receipt-only. Treat Swift as a public source-tag/manifest proof before promotion, never as a claim that draft binary-target assets are anonymously downloadable. npm's trusted credential cannot move dist-tags, so each exact npm version receives its normal tag during publication.
- Recover: inventory external state first. Resume idempotently from the publication ledger; never delete or overwrite immutable public versions.
- History repair: use only before any affected product tag/package is public. Follow `references/recovery.md` and require explicit maintainer authorization for protection changes or force-push.

## Local gates

If the candidate intentionally changes WASIX binary-semantic inputs, refresh
`asset-inputs.sha256` first with
`cargo run -p xtask -- assets input-fingerprint --write`; a pure release
version/changelog/envelope change must leave that fingerprint unchanged. See
`docs/maintainers/assets.md` for the exact boundary.

Run these from the repository root:

```sh
tools/dev/bun.sh tools/release/sync-release-semantic-inputs.mjs --check
tools/dev/bun.sh tools/release/release-check.mjs
cargo run -p xtask -- assets verify-committed
tools/dev/bun.sh src/extensions/tools/check-extension-model.mjs --check
```

When a shared packager, archive encoder, carrier generator, or public target
contract changes, update its exact product ownership in
`tools/release/release-semantic-inputs.toml`, run the synchronizer with
`--write`, and inspect the product-local fingerprint diff before `--check`.
Workflow, validation, registry-transport, test, and documentation-only files
must remain outside that ownership map.

For a normalized generated release PR, also run the synchronizer in write mode
and immediately in check mode. It follows only Moon production/peer edges,
directed compatibility source-to-owner edges, and the runtime linked group. A
direct external-extension candidate therefore stays minimal, while a runtime
candidate may require separately versioned external compatibility dependents.
An incomplete linked group or unversioned first-release dependent is a Release
Please/configuration blocker, not permission to weaken the graph.

```sh
tools/dev/bun.sh tools/release/sync-release-pr.mjs
tools/dev/bun.sh tools/release/sync-release-pr.mjs --check
```

Use `tools/release/release-product-dry-run.mjs --product <product>` only after downloading the exact-SHA artifact inputs required by that product. Use the publication-lock command shown by `--help` to create, freeze, and verify the lock from those staged artifacts.

The committed extension evidence table may say `requires-exact-candidate-ci`; that is an honest pre-qualification state, not permission to skip the lane. The selected CI run must provide the current evidence artifact. Do not use `--allow-dirty` for release evidence. Do not publish from a local rebuild, a different workflow run, a branch name, or a moving ref.

After a first-identity bootstrap seals, run the trusted-publisher helper without
flags first and record its exact `lockDigest` and npm batch count. Audit Cargo
and every npm batch before explicit apply, rerun the same batch after an
interruption, and retain final reports showing no missing or conflicting
configuration. Never enter `release-execute.yml` as a registry publisher; it is
the reusable implementation, while GitHub's registry-facing caller claim is
`release.yml`.

## Handoff

State the candidate SHA, selected products and versions, exact CI run, lock digest, registry/bootstrap state, completed publication phases, and any remaining irreversible action. Distinguish product releases from target/ecosystem carrier packages.
