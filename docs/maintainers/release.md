# Release process

Status: normative operation guide. Last verified: 2026-07-14. Owner: repository maintainers.

Oliphaunt releases independent products from one monorepo. There is no repository-wide product version.

## Model

A product owns its SemVer, changelog, source identity, Release Please component,
product tag, and GitHub release. A carrier is one published representation of
that product for an ecosystem, OS/ABI, or payload limit. All carriers for a
release use their product's version.

The canonical model is composed from:

- Moon project/release metadata for ownership and dependency impact;
- `release-please-config.json` and `.release-please-manifest.json` for product
  versions, changelogs, components, and tag naming;
- the protected release workflow for exact-SHA tag and draft-release creation;
- product `release.toml` and explicit target manifests for publish surfaces;
- `tools/release/publication-catalog.mjs` for the normalized Product → Carrier inventory;
- the frozen publication lock for the actual files produced by one candidate.

Do not maintain a second hand-written package matrix. Query the catalog and inspect the lock. Dynamic package identities are forbidden except crates.io payload `part-N` carriers whose parent is declared and whose size requires splitting.

## Version rules

- New products remain `0.0.0` in source until their first generated release PR. The global first version is `0.1.0`.
- Swift also remains `0.0.0`, but its per-product initial version is `0.6.0` because legacy unscoped SwiftPM tags occupy `0.1.0` through `0.5.1`.
- Release Please creates changelog headings. A brand-new tracked `CHANGELOG.md` is empty; pre-seeding `# Changelog` creates a duplicate heading.
- contrib extensions are `runtime-bound` and share the runtime linked-version group.
- external extensions are `upstream-bound` and own independent packaging SemVer. Their upstream version/commit and compatible runtime versions are separate metadata.
- `feat`, `fix`, `perf`, `refactor`, and `revert` are release-impacting types because the Release Please `changelog-sections` catalog says so. A Conventional Commit `!` is breaking. Release-intent checks derive this set from config.
- Product source PRs never edit versions. The generated release PR owns all version, compatibility, lockfile, and changelog changes.
- While every product is still `0.0.0`, top-level `bootstrap-sha` is the full
  legacy-history boundary `07a9054faa03d5737dc0193f7a77ed4a71920c05`.
  Release Please considers only commits after that exclusive boundary. Derived
  release-PR sync removes the key in the first generated release-bump change;
  do not remove it before Release Please has consumed it or retain it after the
  first bump.

`tools/dev/bun.sh tools/release/sync-release-pr.mjs --check` verifies derived release files. Pure version/changelog changes alter package envelopes but do not alter the committed WASIX binary-semantic fingerprint.

PR CI recognizes generated `chore(release):` changes only on the generated
Release Please branch. Before merge it requires the release commit's parent to
equal the exact base SHA, derives the product set from the manifest diff, and
runs the same structured release-commit verifier used by publish. A multi-commit
or source-bearing release PR therefore fails before it can reach `main`.

## Qualification contract

Publication accepts only a current-main candidate with one non-cancelled CI run whose `head_sha` is exact and whose `Qualified` gate succeeded. That record covers required checks, tests, builds, policy, selected E2E, and named build artifacts. A successful `Builds` job alone is insufficient.

The publish workflow downloads artifacts by that run id and SHA, verifies their attestations/qualification record, assembles the selected product carriers, then freezes a publication lock containing:

- source commit/tree and catalog digest;
- product/version and every actual registry identity;
- ecosystem, target, role, dependency/order, file hash, and size;
- corresponding GitHub release assets and bootstrap/trust state.

Missing and extra identities both fail. Publish commands reverify the lock immediately before writes.

## Operations

Run local metadata gates before dispatching:

```sh
tools/dev/bun.sh tools/release/release-check.mjs
cargo run -p xtask -- assets verify-committed
tools/dev/bun.sh src/extensions/tools/check-extension-model.mjs --check
```

The `Release` workflow has four operations:

1. `prepare-release-pr` — run from current `main`; creates/updates the single generated release PR and syncs derived files.
2. `publish-dry-run` — downloads exact-SHA CI artifacts, performs package/registry preflight and clean-consumer checks, and freezes/verifies the lock without write credentials.
3. `publish-bootstrap` — one-time creation of missing npm/crates identities only. Configure trusted publishers and revoke tokens immediately afterward.
4. `publish` — normal trusted release. It uses short-lived Cargo/npm/JSR credentials, Maven protected secrets, the frozen lock, and idempotent publication checks.

Only a successful `publish-dry-run` uploads the canonical
`oliphaunt-publication-lock` approval artifact. Bootstrap and publish preserve
their rebuilt locks under operation-specific audit names, so a prior mutating
run cannot approve itself or a later run. Both mutating operations download the
canonical artifact from a successful same-SHA `Release` run and byte-compare it
with their rebuilt lock before publication.

The manual workflow is a small dispatcher. Each operation calls one shared
execution workflow, but the caller fixes its token ceiling: dry-run and
bootstrap are repository-read-only; bootstrap additionally receives OIDC only
for npm provenance, while normal publish receives OIDC, attestation, and
release-content write scopes. Secrets come only from the operation's protected
environment; callers do not inherit repository or organization secrets.
Trusted publishers match the top-level caller filename `release.yml` because
GitHub exposes that file through `workflow_ref`; the shared
`release-execute.yml` implementation appears separately through
`job_workflow_ref` and must not be entered as the npm or crates.io publisher.
After bootstrap, derive the complete configuration inventory from the exact
publication lock with `tools/release/trusted-publisher-config.mjs`. Its default
plan is offline/read-only; authenticated inspection requires `--audit`, and
creation requires both `--apply` and confirmation of the exact lock digest.
Wrong or extra configurations are blockers and are never automatically
replaced.

`release_commit`, when supplied, is an assertion that must equal the workflow commit. It cannot select historical code. A tooling fix is a new candidate and must pass new qualification.

## Publish order

Cross-registry publication cannot be atomic, so the workflow is resumable and state-driven:

1. validate names, ownership, versions, auth mode, exact SHA, and registry collisions;
2. create exact product tags and draft GitHub releases;
3. upload and attest selected GitHub assets and create the frozen Swift source tag outside the registry executor;
4. execute the publication lock's dependency topology: payload parts/leaves before aggregators/façades and runtime carriers before dependent SDK carriers;
5. prove public registry bytes, then run the clean-consumer gate exactly once;
6. promote verified GitHub release drafts last.

The workflow does not encode a second product/ecosystem publish order. Before
the first mutation it writes `normal-publication-plan.json` directly from the
approved lock. The normal registry executor consumes that same plan and rejects
an omitted selected dependency, unknown carrier, cycle, or non-contiguous
operation order. Cargo (including dynamic payload parts), npm, and JSR consume
their exact frozen carrier bytes. All selected Maven coordinates form one
signed, atomic Central deployment because Maven Central validates and publishes
that bundle as a unit. A rerun skips an immutable carrier only after proving its
public bytes match the lock; a partially published Maven product fails closed.

The dry-run assembles the exact candidate Cargo registry before any public
write. It copies each registry-neutral Cargo example into scratch space, adds
exact `[patch.crates-io]` entries only for candidate packages, and generates a
fresh lock there. The validator compares every candidate lock checksum with the
registry index and actual `.crate` SHA-256, enforces dependency policy, and
performs a full `cargo fetch --locked`. Source examples never commit candidate
patches or nested locks, so exact-SHA qualification does not create a
build-commit-build cycle. In later partial releases, unchanged packages resolve
normally from crates.io.

npm is the deliberate exception to a separate moving-tag promotion phase.
Trusted-publishing OIDC authenticates `npm publish`, but npm does not authorize
`npm dist-tag` with that credential. Each frozen npm version is therefore
published with its normal tag only after every non-mutating preflight has
passed; target leaves precede the user-facing façade. The workflow does not
reintroduce a long-lived token merely to move `latest`. This registry constraint
is documented by npm's [trusted-publishing limitations](https://docs.npmjs.com/trusted-publishers/).

An existing immutable identity is skipped only when its version/integrity matches the lock. A conflict stops publication. Never replace a public artifact or reuse a version.

Identity bootstrap is checkpointed before and during publication. The genesis
checkpoint freezes the source SHA/tree, publication-lock and catalog digests,
selected products, and complete expected registry envelope before the first
write. Each completed dependency-ordered carrier batch appends a content-addressed,
hash-chained checkpoint containing normalized registry byte receipts. The
workflow uploads the chain even when a later phase fails and restores the newest
chain for the same workflow and exact SHA on retry. Sealing succeeds only after
every expected Cargo and npm identity exists with lock-matching bytes; an
altered, missing, reordered, or conflicting checkpoint fails closed.

Before that genesis checkpoint, bootstrap performs a read-only crates.io name
inventory from the exact frozen lock. Crates.io's default per-user new-name
bucket (5 immediately, then one every 10 minutes) cannot accommodate the full
first-release catalog in one job. A numeric
`CRATES_IO_NEW_CRATE_RUN_CAPACITY` value from the protected
`release-bootstrap` environment must assert the currently available capacity
that crates.io support granted; the gate rejects a malformed or smaller value
before either registry is mutated. Its report records the exact missing-name
count, the official-default duration floor, and the remaining bounded workflow
window. See `release-setup.md` for the external prerequisite.

Normal publication applies the same immutable-version rule to every supported
registry: crates.io checks the published checksum, npm checks `dist.integrity`,
Maven Central streams and hashes each frozen payload at its exact coordinate,
and JSR compares the complete published file manifest with the frozen explicit
`publish.include` set. The workflow preserves normalized receipts and reruns
this proof for every selected carrier immediately before GitHub draft promotion.

The normal Cargo lane has its own pre-mutation capacity contract. It inventories
every selected frozen `name@version`, routes absent crate names back to identity
bootstrap, and counts only versions that remain unpublished. With no override,
the gate uses crates.io's documented default burst of 30; releases at or below
that count need no capacity secret. Above 30, the protected optional
`CRATES_IO_VERSION_RUN_CAPACITY` assertion must cover the exact pending count
and must reflect capacity confirmed by crates.io. This prevents a 417-version
release from entering the one-per-minute refill path and overrunning the job.
Temporary trusted-publishing tokens expire after 30 minutes, so the executor
refreshes them in bounded batches and revokes each token; one early job token is
never treated as a release-long credential.

## Artifact and OS policy

Target packages are required where package managers select by OS/CPU/libc/ABI or where a registry has a real file-size limit. They are not separate products.

- Desktop native: Linux x64/arm64 GNU, macOS arm64, Windows x64 MSVC carriers.
- Android: arm64-v8a and x86_64 AAR/native extension carriers.
- Apple: release XCFramework/resources consumed through SwiftPM; extension products are represented in the generated Swift release package.
- WASIX: portable runtime/extension carriers and native AOT carriers for supported hosts.
- SDK façades: Rust/Cargo, npm, Maven/Gradle, and SwiftPM entry points select
  only the needed target carriers. JSR is deliberately protocol/query-only and
  does not claim native runtime carriers.

The first release is fail-closed: it does not publish macOS x64, Windows ARM64,
Linux musl, Android 32-bit, or additional Apple architectures. A target becomes
supported only when the product's explicit target manifest declares it, the
publication catalog selects a corresponding carrier, and the frozen lock contains
that carrier with required evidence. A broader runtime matrix or package-manager
fallback must never imply that an undeclared target exists.

Every exact extension has its own product and stable ecosystem façades. Each product's `targets/artifacts.toml` explicitly declares supported/unpublished targets and evidence. The runtime target matrix bounds possible values but never creates extension support by default.

## Recovery and history repair

On a failed publish, preserve the candidate SHA, run id, lock, complete checkpoint chain, draft releases, and registry responses. Inventory every selected identity as absent, matching, or conflicting; restore and validate the exact-SHA chain, then resume only missing phases. Repository changes require a new version and candidate.

History repair is allowed only before any affected product tag/package is public. Freeze main, archive the old tip, qualify the replacement tree, use an exact `--force-with-lease` only with explicit maintainer authorization, and immediately restore force-push protection. The desired bootstrap history is one tree-identical introduction commit followed by one generated release-bump commit. See `.codex/skills/release-oliphaunt/references/recovery.md`.

## Handoff evidence

Record the candidate SHA/tree, exact CI run, selected product versions, catalog/lock digests, artifact attestations, registry bootstrap/trust status, publication ledger, promoted release URLs, and clean-install results. “The workflow passed” is not sufficient release evidence without those identities.
