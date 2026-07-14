---
name: release-oliphaunt
description: Prepare, audit, bootstrap, publish, verify, or recover Oliphaunt releases across GitHub, crates.io, npm, JSR, Maven Central, and SwiftPM. Use for release PRs, version bumps, changelogs, registry setup, publication failures, missing tags/packages, or first-release/history-repair work.
---

# Release Oliphaunt

Treat a release as a frozen, exact-SHA promotion of already-qualified artifacts. Never reconstruct or substitute artifacts during publishing.

## Start

1. Read `docs/maintainers/release.md` and `references/invariants.md`.
2. For a failed or partially public release, also read `references/recovery.md` before changing state.
3. Record the candidate commit with `git rev-parse HEAD`; keep that SHA unchanged through qualification, lock creation, and publish.
4. Inspect `git status`, product versions, existing product tags/releases, registry identities, and the latest exact-SHA CI run. Report any public collision before attempting a mutation.
5. Before an external mutation, run `tools/dev/bun.sh tools/release/audit-github-release-controls.mjs --governance solo --bootstrap-state ready`. Select `team` only with an independent maintainer, and select `retired` after revoking the one-time bootstrap tokens. Treat `FAIL` as a blocker; report but do not promote `WARN` to a solo-release blocker.
6. Generate trusted-publisher work from the approved publication lock with `tools/dev/bun.sh tools/release/trusted-publisher-config.mjs`. Its default mode is offline/read-only. Use authenticated `--audit` before considering `--apply`; mutation additionally requires the exact printed lock digest. Configure the top-level caller `release.yml` and `release-publish` environment, never the reusable implementation filename.

## Choose the operation

- Prepare: synchronize release-owned files, run release checks, create the generated release PR, and stop for review.
- Bootstrap: use the dedicated bootstrap environment only for identities that cannot use trusted publishing until their first package exists. Inventory the exact lock first. Up to the documented default new-name burst needs no invented override; a larger run requires the protected, support-confirmed `CRATES_IO_NEW_CRATE_RUN_CAPACITY`. Publish each missing identity's exact first-version bytes, then use that exact lock with `tools/release/trusted-publisher-config.mjs`: its default plan has no network access, `--audit` is read-only, and mutation requires both `--apply` and the exact `--confirm-lock-digest`. Require caller `release.yml`, environment `release-publish`, and npm publish-only permission; reject extra or mismatched configurations. Revoke long-lived credentials, then resume normal publish.
- Publish: require a successful exact-SHA `Qualified` gate, complete artifact set, current full-lifecycle WASIX evidence when selected, frozen publication lock, and registry preflight. The documented default crates.io version burst covers up to 30 pending versions; a larger exact count requires protected `CRATES_IO_VERSION_RUN_CAPACITY`. Publish the single lock-derived dependency topology and promote GitHub release drafts last. npm's trusted credential cannot move dist-tags, so each exact npm version receives its normal tag during publication.
- Recover: inventory external state first. Resume idempotently from the publication ledger; never delete or overwrite immutable public versions.
- History repair: use only before any affected product tag/package is public. Follow `references/recovery.md` and require explicit maintainer authorization for protection changes or force-push.

## Local gates

Run these from the repository root:

```sh
tools/dev/bun.sh tools/release/release-check.mjs
cargo run -p xtask -- assets verify-committed
tools/dev/bun.sh src/extensions/tools/check-extension-model.mjs --check
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
