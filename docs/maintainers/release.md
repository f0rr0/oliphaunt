# Release process

Windows publishers must also follow the [Visual C++ runtime release
contract](./windows-vc-runtime.md); it defines redistributable provenance,
extension-provider ownership, app-local placement, and receipt evidence.

Status: normative operation guide. Last verified: 2026-07-30. Owner: repository maintainers.

Oliphaunt releases independent products from one monorepo. There is no repository-wide product version.

CI can qualify selected products using the `release_products_json` dispatch
input, for example `["oliphaunt-js"]`. Leave all platform selectors at `all`.
Moon selects those owners' tasks, downstream compatibility checks and required
producer dependencies. An empty product array retains the exhaustive audit.
Publication accepts this record only for covered products at the exact candidate
SHA; it still verifies the immutable artifacts and any required WASIX evidence.
Generated release PRs and their main merge automatically select the products
whose Release Please manifest versions advance. Exact main pushes and eligible
main dispatches can produce publishable qualification; PR checks use the same
scope but cannot authorize publication. Publication reuses covering successful
CI, waits for active matching CI, or requests one missing run while main still
equals the candidate SHA. Failed causal runs require recovery; ambiguous
dispatches are not automatically repeated. Cross-commit producer reuse remains
an explicit acceptance item rather than permission to substitute arbitrary
older artifacts.

## Model

A product owns its SemVer, changelog, source identity, Release Please component,
product tag, and GitHub release. A carrier is one published representation of
that product for an ecosystem, OS/ABI, or payload limit. All carriers for a
release use their product's version.

The canonical model is composed from:

- Moon project/release metadata for source ownership and qualification impact;
- `release-please-config.json` and `.release-please-manifest.json` for product
  versions, changelogs, components, and tag naming;
- the protected release workflow for exact-SHA tag and draft-release creation;
- product `release.toml` and explicit target manifests for publish surfaces;
- `tools/release/publication-catalog.mts` for the normalized Product → Carrier inventory;
- the frozen publication lock for the actual files produced by one candidate.

Do not maintain a second hand-written package matrix. Query the catalog and inspect the lock. Dynamic package identities are forbidden except crates.io payload `part-N` carriers whose parent is declared and whose size requires splitting.

A product-local `release.toml` activates an external extension as a public
release product. Incomplete extension work stays on a branch; main contains no
deferred, promoted, planned, blocker, or qualification-only extension state.

## Carrier license and notice checks

Legal material follows the bytes in each physical carrier, not merely the
product name or source repository. Code-only and source-only facades carry the
Oliphaunt MIT profile. A payload carrier carries its exact role profile plus
the legal files for every component whose bytes it contains. The executable
authorities are the publication catalog, `release-notices.mts`,
`extension-upstream-licenses.mts`, and the broker dependency-license contract;
do not maintain a separate handwritten carrier matrix.

Every direct carrier, payload part, aggregate, and final registry archive must
have the exact legal namespace, bytes, file types, and modes derived by those
contracts. Missing files fail, but uncontracted files, directories, symlinks,
and special entries fail as well. For Maven Central, this invariant applies to
the primary artifact and its `sources` and `javadoc` companions; valid POM
metadata is not a substitute for legal files inside each archive.

Native runtime payloads carry Oliphaunt, PostgreSQL, and ICU; native tools carry
Oliphaunt and PostgreSQL. Contrib carriers add the PostgreSQL profile, and add
OpenSSL only on a target that actually embeds `pgcrypto` crypto bytes. External
extensions derive their package expression and exact upstream file set from
the pinned source contract. A broker source facade remains MIT-only, while
each compiled broker target derives its dependency notices from the exact
`Cargo.lock` and target dependency graph used to build that binary.

Passing these checks proves only the repository-declared license and notice
contents for the inspected carrier. It is not legal advice or certification of
comprehensive legal compliance. PostGIS is an active public external product
and participates in the same carrier checks as other public products.

## Version rules

- New products remain `0.0.0` in source until their first generated release PR. The global first version is `0.1.0`.
- Swift also remains `0.0.0`, but its per-product initial version is `0.6.0` because legacy unscoped SwiftPM tags occupy `0.1.0` through `0.5.1`.
- Release Please creates changelog headings. A brand-new tracked `CHANGELOG.md` is empty; pre-seeding `# Changelog` creates a duplicate heading.
- PostgreSQL 18 contrib members have no independent release version. Native
  carriers use the `liboliphaunt-native` version and WASIX carriers use the
  `liboliphaunt-wasix` version; the 32 SQL members remain exact selectors, not
  separately versioned release products.
- active external extension products are `upstream-bound` and own independent
  packaging SemVer. Their upstream version/commit and compatible runtime
  versions are separate metadata.
- Native/default extension npm identities stay unsuffixed. A portable WASIX npm
  carrier adds only the `-wasix` suffix and uses the same exact packaging
  SemVer, release tag, and changelog as every other carrier owned by that
  extension product; it never creates a second release version line.
- `@oliphaunt/liboliphaunt-wasix` is the host-neutral npm carrier of the
  existing `liboliphaunt-wasix` product. It shares that product's SemVer, tag,
  and changelog; it is not a browser SDK or another runtime product. The
  carrier preserves the qualified portable runtime, PGDATA, and core-only
  manifest bytes, while independently versioned extension products retain
  their own WASIX install metadata and payloads.
- `feat`, `fix`, `perf`, `refactor`, and `revert` are release-impacting types because the Release Please `changelog-sections` catalog says so. A Conventional Commit `!` is breaking. Release-intent checks derive this set from config.
- Product source PRs never edit versions. The generated release PR owns all version, compatibility, lockfile, and changelog changes.
- While every product is still `0.0.0`, top-level `bootstrap-sha` is the full
  legacy-history boundary `07a9054faa03d5737dc0193f7a77ed4a71920c05`.
  Release Please considers only commits after that exclusive boundary. Derived
  release-PR sync removes the key in the first generated release-bump change;
  do not remove it before Release Please has consumed it or retain it after the
  first bump.

`bash tools/release/sync-release-pr.sh` closes the generated
candidate metadata: compatibility values for selected
consumers, package pins, locks, and deterministic evidence. It never creates a
consumer release merely because one of its dependencies changed. Its `--check`
mode proves that the same state is already closed. Pure version/changelog
changes alter package envelopes but do not alter committed runtime binaries.

PR CI runs `sync-release-pr.sh --check-generated-release` only for the
same-repository `release-please--branches--main` head, before artifact planning.
That cheap barrier checks the dependency/compatibility/lock fixed point and the
exact structured release commit without compiling the asset
verifier. The prepare workflow generates and validates the candidate locally
before its first push. This admission check verifies the already-closed pushed
head before expensive matrices begin.

Release Please selects changes under each configured product path. Shared code
that changes published bytes must therefore live in, or be represented by, the
product that owns those bytes. Pure workflow, validation, registry transport,
test, and documentation changes do not bump products. If another unreleased
product change is already present, Release Please may still prepare that
product's release. A manually constructed `chore(release):` commit without an
actual manifest/version/changelog transition is rejected by the structured
release-commit verifier.

### Independent candidates and pinned dependencies

Release Please remains the sole authority for product candidates and version
policy: it selects product paths changed since their last releases. Shared
contrib inputs may select both runtime owners because those source files are
physically bundled into both products. No Moon dependency edge creates another
release candidate.

Moon `production` and `peer` edges describe source and qualification impact.
Product-local `compatibility_versions` describe the exact published product
versions a carrier consumes. A native runtime can therefore be published
without bumping an SDK, and the unchanged SDK continues to pin the older native
version. When a consumer is selected for release, sync updates its compatibility
fields to the current dependency versions so the package describes the source
and artifacts qualified at that commit. If a dependency is also selected,
publication orders it first.

Before publishing a selected consumer, version checks require each pinned
dependency to be either selected at that exact version or already available at
its exact product tag and registry/GitHub carriers. Selecting a newer dependency
does not satisfy an older consumer pin. Structured release-commit verification
also rejects source changes hidden inside compatibility-only edits.

PR CI recognizes generated `chore(release):` changes only on the generated
Release Please branch. Before merge it requires the release commit's parent to
equal the exact base SHA, derives the product set from the manifest diff, and
runs the same structured release-commit verifier used by publish. A multi-commit
or source-bearing release PR therefore fails before it can reach `main`.
Release Please may transport a large generated change as multiple file-chunk
commits. The protected prepare job accepts those chunks only from the exact
open canonical Release Please PR, requires a linear exact-main descendant with
the configured release title on every chunk, collapses their tree to one commit,
reapplies derived release synchronization, runs the structured verifier, and
pushes with a lease against the inspected PR head. The normalized tree must be
byte-identical before derived synchronization; a moved PR head is never replaced.
Before the prepare job spends time on toolchains or release metadata, the
read-only validation job directly inventories the exact
`release-please--branches--main` head against `main` through the Pulls REST API
and rejects any merged result that still carries `autorelease: pending`. It
does not use GitHub Search or the Issues API's eventually consistent label
  index. A pending merged PR means publication is unfinished; it is never
  reported as “no releasable changes.”

## Qualification contract

Root publication admission accepts only a current-main candidate with one non-cancelled CI run whose `head_sha` is exact and whose `Qualified` gate succeeded. That record covers required checks, tests, builds, policy, selected E2E, and named build artifacts. A successful `Builds` job alone is insufficient. After the root job pins the immutable release transport tag, the rest of that run remains bound to the exact transaction without re-evaluating the moving main branch.

The qualified source commit owns the artifacts, lock, product tags, and
registry bytes. Ordinarily it also owns the publishing workflow. A narrowly
permitted publication-only controller fix may publish those same frozen bytes;
its workflow SHA is recorded separately and requires successful CI Required.

The `macos-26` publication runner is ARM64, but its current runner-image
contract exposes the installed Java 17 path as `JAVA_HOME_17_arm64` (including
that lowercase suffix). Release setup uses that exact variable first, permits
`JAVA_HOME_17_X64` only as an Intel-image fallback, and fails before release
work unless the selected path contains an executable `bin/java`. Do not invent
the variable name from the architecture or rely on the image's moving default
Java version for Maven or Gradle publication.

For a normal publication, the publish workflow downloads artifacts by that run
id and SHA, verifies their attestations/qualification record, assembles the
selected product carriers, then freezes a publication lock containing:

- source commit/tree and catalog digest;
- product/version and every actual registry identity;
- ecosystem, target, role, dependency/order, file hash, and size;
- corresponding GitHub release assets and bootstrap/trust state.

Missing and extra identities both fail. Publish commands reverify the lock
immediately before writes.

## Operations

Run local metadata gates before dispatching:

```sh
bash tools/release/release-check.sh
tools/dev/bun.sh extensions/tools/check-extension-model.mts --check
```

If the candidate changes a GitHub workflow or local action, also run
`bash tools/ci/check-workflows.sh`. That conditional gate runs the pinned
`actionlint` and `zizmor` configuration, focused workflow security checks, and
helper behavior tests;
`actionlint` by itself is not equivalent.

The default `release-check.sh` invocation includes publication metadata plus
the release-owned and policy-owned mutation unit suites. `check-release-metadata.mts`
is the canonical product, version, registry ownership, and dependency graph
validator. The release-PR job runs `release-metadata-check.sh` once after the
generated commit is synchronized, while hosted qualification owns candidate
source-metadata evidence. Publishers verify the frozen candidate identity and
live external state instead of replaying source-only metadata checks.

The `Release` workflow has two operations:

1. `prepare-release-pr` — run from current `main`; creates or updates the generated release PR and synchronizes derived files.
2. `publish` — waits for exact-SHA qualification, prepares and freezes the candidate, bootstraps missing Cargo/npm names when necessary, publishes verified bytes, checks public consumers, and promotes GitHub drafts last.

Ordinary publication needs no approval run ID or separate dry-run/bootstrap
dispatch. Preparation uploads `oliphaunt-publication-lock` and
`oliphaunt-publication-candidate`; dependent jobs download their immutable
artifact IDs. They verify the source SHA/tree, qualification run, approval run,
products, lock, hashes, sizes, dependencies, and complete file set before use.
Missing, expired, extra, unsafe, or changed contents stop publication. Binary
producer outputs are reused from qualification, not rebuilt by publishers.

An optional `approval_run_id` reuses a previous candidate during recovery.
The selected Release run must be completed and either successful (including a
legacy dry-run) or failed with a successful `Prepare frozen publication
candidate` job. Active and cancelled runs cannot authorize recovery. The
normal CI qualification gate still requires a successful complete workflow.

Preparation is read-only and uses the existing `release-dry-run` environment.
It checks visible public releases; the publishing job repeats that preflight
with its content-write token so hidden drafts are checked before mutation.
The conditional bootstrap job uses `release-bootstrap` credentials only for
wholly absent names, preserves its resumable ledger, and hands its immutable
ledger artifact ID to publication. Provision only the registry tokens required
by missing names. After the initial release, configure trusted publishers for
those names and revoke bootstrap tokens before the next release.

Credential-bearing jobs directly select `release-pr`, `release-bootstrap`,
or `release-publish`. Keep secrets in those protected environments. The
bootstrap job's content-write permission creates the immutable transport tag;
normal publication owns GitHub staging, attestations, and promotion. GitHub
provides each job's scoped `GITHUB_TOKEN`.

Trusted publishers match `release.yml`: direct publication exposes that file
through `workflow_ref`, together with the exact `workflow_sha` and the
`release-publish` environment claim. Normal publish has the `main` branch ref.
GitHub
may also emit `job_workflow_ref` as an optional current-job alias for a
directly defined job, with or without `job_workflow_sha`. The ref must exactly
equal the already-required canonical `workflow_ref`. A present SHA alias is
accepted only alongside that exact ref and must equal the canonical
`workflow_sha`; a SHA alone cannot identify a workflow file. This rejects a
distinct called-workflow identity without assuming that GitHub always emits
the SHA alias. Repository policy separately forbids delegated operation jobs
and `workflow_call`. An unconditional, bounded,
repository-read-only validation job checks the canonical repository, exact
workflow commit, operation, optional exact commit, and the corresponding
root-main ref and pinned approval run before any operation job.
Malformed or contradictory manual inputs therefore fail before release work
begins.
After bootstrap, derive the complete configuration inventory from the exact
publication lock with `tools/release/trusted-publisher-config.sh`. Its default
plan is offline/read-only; authenticated inspection requires `--audit`, and
creation requires both `--apply` and confirmation of the exact lock digest.
Wrong or extra configurations are blockers and are never automatically
replaced.

Candidate assembly installs the full workspace; normal publish and bootstrap
install only the verified command-line tools required for signing, uploading,
and public verification. Neither path relies on Corepack. When the selected
carrier set includes npm, both normal and bootstrap jobs use
`setup-npm-publisher` to install the workflow-pinned npm archive. That action
verifies the canonical URL, compressed digests and byte count, safe archive
shape, executable modes, and complete extracted-tree digest before exporting
the CLI. It then compares the observed npm version exactly and validates the
observed Node/npm trusted-publishing runtime plus the command-specific
`npm trust list` and `npm trust github` help contract used by maintainer
configuration. This local tool setup neither requests an OIDC token nor changes
the frozen registry mutation logic.

Installer fault-injection suites are owned by the exact-SHA
`ci-workflows:check` gate. Publication does not execute those download, cache,
and rollback suites again. Release-PR preparation runs the live metadata checker
once after structured commit verification. The candidate preparation job verifies the
same-SHA `Qualified` record before freezing the candidate; slim publishers do
not replay that source-only validation.
For local read-only validation, run `bash tools/release/release-check.sh` for
source metadata and release-tool tests. Check selected public version state with
`bash tools/release/release-check-registries.sh --products-json '["oliphaunt-js"]' --head-ref HEAD`
(replace the example selection with the actual products). Neither command
assembles release packages; the retired dry-run wrapper did not assemble them
either. Use the selected products' package and artifact/consumer test tasks for
local package rehearsal.

Candidate preparation verifies its exact-SHA qualification record once and
performs registry preflight once. Immediately before assembly,
`qualified-release-replay.sh` still rejects source modifications, suppressed
index entries and a mismatched checkout SHA. This source check runs locally as
well as in GitHub Actions. Publication rechecks live registry state at its
mutation boundary, where a race can still change the result.

Preparation binds `release_commit` to the workflow commit. For
`publish` with `approval_run_id`, it may instead identify an approved ancestor
candidate after narrowly permitted publication-only fixes. The controller
check requires a clean checkout and rejects changes to product source,
packagers, build definitions, CI, and lockfiles. The publishing commit requires
successful CI `Required`; the frozen candidate retains its original full
qualification, approval run, source SHA/tree, and package hashes. GitHub
attestations verify the actual publishing workflow SHA and record it separately
from the candidate source. No build or packaging command is replayed.

Normal publish discovers completed bootstrap evidence by the approved lock,
independently of the publishing-code commit. Only successful `Release` runs
from canonical `main`, with a successful bootstrap job and an immutable ledger
artifact, qualify. The downloader checks the earlier publisher's permitted
source changes, the complete checkpoint chain, source/tree, package envelope,
and receipts; the following gate checks the public registry bytes. A newer
publication-only fix therefore reuses the completed bootstrap without a rebuild,
new dry-run, or bootstrap rerun. Incomplete bootstrap still resumes only through
its original run; this does not add cross-run checkpoint migration.
If a publication-only code fix makes that run unusable, retain its ledger and
first verify every recorded public package against the approved lock. Then a
fresh `publish` dispatch at the corrected current `main`, with the same source
SHA and candidate run, inventories registry state and starts a new scope for
only the still-absent names. Already-public versions are excluded from that new
scope and remain subject to normal publication integrity verification. Use the
new run for subsequent checkpoint retries. Normal publish discovers its completed
ledger by the approved lock. Never edit or transplant the old checkpoint chain.
At the mutation boundary, a root
`publish` run first reads the lightweight
`oliphaunt-release-transport/<full-sha>` tag and accepts only a direct commit
ref at its exact release SHA. If the tag is absent, or this is the first run
attempt, the helper proves that the publishing workflow is current `main` before creating or accepting it;
creating an absent append-only tag is the root generation's first mutation.
Only a genuine rerun (`GITHUB_RUN_ATTEMPT > 1`) of the exact root operation,
original `refs/heads/main` workflow SHA may reuse an
already exact tag after `main` advances. A missing tag still requires the proof
on every attempt, while a wrong or annotated tag fails closed. The helper never
updates or deletes the tag and never replays an ambiguous create. A manual
rerun retains the original workflow SHA and approved candidate even after `main`
advances. Normal publication remains exact-SHA and lock-bound after the first
mutation.

## Publish order

Cross-registry publication cannot be atomic. Normal `publish` is one
idempotent protected job:

1. validate names, ownership, versions, auth mode, exact SHA, and registry collisions;
2. pin the immutable release transport, then create exact product tags and draft GitHub releases;
3. upload and attest selected GitHub assets and create the frozen Swift source tag outside the registry executor;
4. execute the publication lock's dependency topology: payload parts/leaves before aggregators/façades and runtime carriers before dependent SDK carriers;
5. prove public registry bytes, then run the exact public-consumer gate once and preserve its lock-bound evidence;
6. promote verified GitHub release drafts last.

The job stages GitHub state, publishes the complete exact registry topology,
verifies public consumers, and promotes drafts without a normal-publication
checkpoint, continuation, or phase handoff. It attempts the complete plan once
inside its bounded window. If it cannot finish, a maintainer uses GitHub's
rerun on the original Release run; the rerun reinstalls and verifies the same
approved candidate, accepts only byte-matching immutable state, and publishes only what
remains absent.

First-identity bootstrap is manually resumable. An incomplete run uploads its
lock-bound checkpoint, fails with an exact rerun command, and resumes only when
the maintainer reruns the failed job of that same Release workflow run.

The workflow does not encode a second product/ecosystem publish order. The
Shell registry executor derives its plan directly from the approved
lock and rejects an omitted selected dependency, unknown carrier, cycle, or
non-contiguous operation order. `bash tools/release/publish-registries.sh --products-json "$PRODUCTS_JSON" --head-ref "$RELEASE_HEAD_SHA" --publication-lock "$PUBLICATION_LOCK_PATH"` runs one sequential Cargo, npm, and Maven lane,
overlaps independent lanes, and awaits every explicit cross-registry dependency
barrier. Cargo (including dynamic payload parts) and npm consume their
exact frozen carrier bytes. All selected Maven coordinates form one
signed, atomic Central deployment because Maven Central validates and publishes
that bundle as a unit. Before the first GitHub write, the workflow constructs
the complete selected bundle without upload and verifies every coordinate,
POM, primary artifact, sources JAR, javadoc JAR, signature, checksum, nonempty
file, and the strict sub-1-GB archive ceiling. The Shell command
`bash tools/release/preflight-maven-central-bundle.sh --publication-lock "$PUBLICATION_LOCK_PATH" --products-json "$PRODUCTS_JSON" --release-commit "$RELEASE_HEAD_SHA"`
preserves the signed bundle in `target/release/maven-central/normal-registry-plan`.
Publication verifies its lock digest, exact carrier selection, size, and SHA-256
and uploads those same bytes; it does not repeat signing or packaging.
A rerun skips an immutable carrier only after proving its
public bytes match the lock; a partially published Maven product fails closed.

npm is the deliberate exception to a separate moving-tag promotion phase.
Trusted-publishing OIDC authenticates `npm publish`, but npm does not authorize
`npm dist-tag` with that credential. Each frozen npm version is therefore
published with its normal tag only after every non-mutating preflight has
passed; target leaves precede the user-facing façade. The workflow does not
reintroduce a long-lived token merely to move `latest`. This registry constraint
is documented by npm's [trusted-publishing limitations](https://docs.npmjs.com/trusted-publishers/).

An existing immutable identity is skipped only when its version/integrity matches the lock. A conflict stops publication. Never replace a public artifact or reuse a version.

Identity bootstrap runs through `bash .github/scripts/bootstrap-registry-identities.sh`
and is checkpointed before and during publication. Shell owns both registry
lanes and passes each publisher only its own registry credentials. The genesis
checkpoint freezes the source SHA/tree, publication-lock and catalog digests,
selected products, and complete expected registry envelope before the first
write. The slim bootstrap job consumes the preparation job's complete
manifest-bound publication candidate; it neither reconstructs packages nor repeats
the macOS build ceremony. Bootstrap preserves the lock's Cargo/npm dependency
edges and executes one sequential lane per registry, overlapping only
independent operations. Its one serialized checkpoint writer receives newly
completed carrier IDs in canonical lock order and appends content-addressed,
hash-chained checkpoints containing normalized registry byte receipts. A lane
failure stops new starts, lets the peer's one in-flight immutable mutation
drain, and triggers a final reconciliation/checkpoint attempt; publication and
checkpoint failures are reported together rather than masking either. The
workflow uploads the chain even when a later phase fails and restores the newest
compatible chain for the same workflow and exact SHA on a rerun attempt.
Sealing succeeds only after
every expected Cargo and npm identity exists with lock-matching bytes; an
altered, missing, reordered, or conflicting checkpoint fails closed.

Before that genesis checkpoint, bootstrap performs a read-only crates.io name
inventory from the exact frozen lock. Crates.io's default per-user new-name
bucket (5 immediately, then one every 10 minutes) cannot accommodate the full
first-release catalog in one hosted job. No API exposes support-granted account
capacity, so an operator-entered number is not accepted as a correctness gate.
The planner uses the documented bucket, treats a valid `429 Retry-After` as
authoritative, and admits only a dependency-closed batch that fits the current
window. After progress or a safe deadline/rate-limit stop, it uploads the
immutable checkpoint and marks the job incomplete. The summary gives the exact
`gh run rerun <run-id> --failed` command and not-before time. Ambiguous uploads
and integrity or checkpoint failures remain hard failures.
Bootstrap retains its bounded job window and restores only a validated
checkpoint for the same source, lock, products, and package envelope. Normal
publish has one hosted-job deadline. It reserves enough time for public
verification and draft promotion, then runs the complete registry plan without
estimating a partial batch. If the mutation window is already exhausted, it
fails before starting another registry write and the maintainer uses GitHub's
rerun on the original Release run.

Normal publication applies the same immutable-version rule to every supported
registry: crates.io checks the published checksum, npm checks `dist.integrity`,
and Maven Central streams and hashes each frozen payload at its exact coordinate.
A complete, same-lock bootstrap ledger is verified in
bounded parallel before mutation and its Cargo/npm receipts are reused by the
normal executor; already-proven public identities are not queried serially
again. Each registry publisher returns the exact receipt it proves; the
executor assembles those results in canonical operation order, rejects missing,
extra, duplicate, or replaced receipts, and writes one exhaustive lock-bound
receipt file (including a valid empty receipt set for a source-only release).
If the job stops after a public write, GitHub's rerun of the original Release
run inventories the complete lock and proves registry bytes before deciding
whether an operation remains.

The post-publication consumer gate is an anonymous public-endpoint probe.
It derives its products, ecosystem lanes, dependency roots, full carrier
closure, versions, Maven coordinates, and Git tags from the same frozen lock.
In parallel clean temporary homes/caches it resolves each Cargo consumer root
in an independent scratch manifest without compiling payloads, installs each
npm dependency root in an independent project, resolves each Maven entry in an
isolated Gradle configuration without an Android build, and anonymously fetches
every product tag. Each lane requires
the resolver's platform-independent lock graphs to cover every carrier in the
corresponding frozen dependency closure; a missing carrier cannot be silently
relabelled as receipt-only. It never invents one all-platform consumer graph.
Evidence separately identifies npm carriers not installed on the macOS host
and Cargo payloads intentionally not fetched/compiled; immutable receipts
prove those bytes. When Swift is
selected it also fetches the unscoped source tag,
requires its synthetic commit to have the release SHA as its only parent, and
evaluates that tagged `Package.swift` with `swift package dump-package`.

Run this gate locally with `bash tools/release/public-consumer-smoke.sh` and
the same lock and receipt arguments used by the workflow. It requires jq and
GNU timeout (`coreutils` on macOS). Shell owns the parallel command lanes,
private homes, deadlines, and descendant cleanup; TypeScript stages manifests
and validates the resulting resolution. Package managers retain their normal
network retries, and crates.io metadata reads have bounded retries. A failed
command or exact-version, source, closure, tag, or receipt mismatch stops the
gate; there is no second retry loop that discards and repeats entire installs. The gate emits one deterministic immutable evidence file bound to
the registry receipt hash, GitHub receipt digest, lock digest, source SHA/tree,
and selected products; that file is uploaded before draft promotion. The
publish job runs on macOS, so npm's `installedCarrierIds` proves only the host
subset actually installed there. The exact lock/receipt set and same-SHA CI,
not this host probe, prove the complete supported OS/ABI matrix.

Draft release assets are intentionally not claimed to be anonymously public.
In particular SwiftPM binary-target downloads cannot be a genuine public
pre-promotion test; the gate proves the public source tag and manifest while
the already-validated GitHub receipt proves every frozen binary-target asset.
Drafts remain unpromoted if either half fails.

GitHub release assets are verified in the same job. Each pinned provenance
action emits one signed bundle covering its complete subject set. Before the
registry clock starts, the workflow verifies each nonempty bundle once against
the frozen local lock bytes, checks the exact remote release asset set for
every selected product (including an explicit empty set for source-only
products), and freezes a lock/source/release-ID/digest receipt. Before promotion
the workflow rechecks immutable GitHub release IDs plus asset names, sizes, and SHA-256
metadata against that receipt. It never serially downloads and re-attests the
hundreds of extension assets after registry publication.
The CI extension artifact is intentionally broad, but an extension attestation
is not: its subjects are re-hashed paths derived from only the selected
exact-extension products' frozen GitHub asset and metadata rows. A subset
release therefore cannot attest an unselected exact-extension product merely
because both products were present in the downloaded CI artifact.

GitHub's primary `GITHUB_TOKEN` allowance and secondary content-creation
allowance are separate release constraints. Every product uses the dedicated
paginated asset endpoint; embedded release asset arrays never authorize
publication.
Every REST collection follows validated `Link` relations one page at a time;
opaque `gh api --paginate`/`--slurp` reads are forbidden so each physical page
attempt, including a retry of the same page, receives its own durable core-request
reservation before transport. Exact 100- and 200-row boundaries stop from the
response metadata without issuing an empty trailing request.
Snapshot reads distinguish ordinary authorization failures from GitHub primary
and secondary limits, honor bounded `Retry-After` or `X-RateLimit-Reset` waits,
and otherwise use GitHub's one-minute exponential backoff guidance inside a
five-minute read deadline.
Completed workflow metadata and artifact
identities are captured once per immutable run and reused; artifact ZIPs are
downloaded only by exact ID and verified against GitHub's size and SHA-256.

Every product tag, draft, asset upload, SwiftPM source-tag push, attestation
bundle, and promotion reserves the same 10-second content-write pacer before
transport, allowing at most 361 writes in any rolling hour and seven in any
rolling minute. Asset-backed products execute in bounded waves of at most five
uploader processes; products with an exact empty asset set are proven by the
pre-mutation and final receipts without consuming an uploader lane. A new
runner starts a conservative
rolling-hour cooldown at the beginning of the normal publish job; read-only
qualification and artifact preparation overlap that window. The first actual
write still waits for the window to mature, and every reservation is persisted
before its request. Every core REST attempt, including retries and the API call
inside each attestation action, is also reserved in a durable run-identity-bound
journal before transport; attempt 901 inside one rolling hour is refused.
Both journals remain bound to the repository, root run, source, and manifest
for the duration of the job. Exact remote-state reconciliation prevents
immutable mutation replay. Each actual request reserves its pacer/journal slot
before transport. A paced mutation receives its complete configured transport
timeout only when that timeout still fits the job deadline. Read transports
recompute and clamp their attempt timeout after journal reservation, and never
start if the read deadline was exhausted while acquiring the journal lock. The
SwiftPM source-tag push is likewise
noninteractive and bounded; success, rejection, disconnect, and timeout are all
resolved by an exact remote tag/SHA read before the result is accepted. Before
any release mutation, a lock-derived SwiftPM preflight constructs the exact
manifest commit without creating a local tag and accepts only an absent remote
semantic tag or one already pointing at that exact commit; a conflicting or
ambiguous tag blocks the release before GitHub drafts are staged. Before
bootstrap or normal publish can
cross its first irreversible boundary, a read-only exact-SHA assertion resolves
the unique merged Release Please PR, verifies its current lifecycle state, and
proves the repository still defines `autorelease: tagged`. The same assertion
runs again immediately before promotion. Promotion remains the literal final
step of `publish`: it asserts markability, promotes every exact draft,
then adds `autorelease: tagged` and removes `autorelease: pending` through two
separately paced, journaled, reconciled mutations. Add/remove
operations do not replace the PR's label set, so unrelated labels—including
ones added concurrently—are preserved. After an interrupted partial promotion
or lifecycle close, GitHub's rerun of the original Release run accepts only
exact already-public releases, promotes the remaining exact draft IDs, and
idempotently converges both-label or pending-only state to
tagged-without-pending.

Normal publication inventories every selected frozen Cargo and npm
`name@version` and rejects missing names that require first-identity bootstrap.
It then attempts the complete dependency-ordered Cargo, npm, and Maven
plan once. Publishers honor an authoritative `Retry-After` while the job
deadline permits; they do not predict registry capacity or deliberately split
the plan. Temporary trusted-publishing tokens are refreshed and revoked in
bounded batches. GitHub's rerun of the original Release run reclassifies
matching public mutations against the same frozen lock, proves their
checksum/SRI or payload manifest, and never blindly replays an ambiguous
immutable upload.

## Artifact and OS policy

Target packages are required where package managers select by OS/CPU/libc/ABI or where a registry has a real file-size limit. They are not separate products.

- Desktop native: the complete Linux x64/arm64 GNU carrier floor is glibc
  2.38 and `GLIBCXX_3.4.30`. Every ELF file in the native runtime, client
  tools, broker, Node addon, and exact-extension payload must stay at or below
  those symbol-version ceilings; an individual file may require an older
  version. The direct macOS arm64 binaries declare macOS 11.0 in Mach-O load
  commands; Windows publishes x64 MSVC carriers.
- Android: arm64-v8a and x86_64 AAR/native extension carriers with API 24 as
  the minimum Android level.
- Apple: the release XCFramework contains macOS arm64, iOS device arm64, and
  iOS simulator arm64 slices. iOS binaries target iOS 17; the Swift SDK
  declares macOS 14 and iOS 17 even though the direct macOS binary carrier has
  the lower macOS 11.0 floor. SwiftPM consumes the XCFramework with runtime
  resources. Every native exact-extension and native-dependency XCFramework
  carries the same three Apple platform slices and is rejected before packaging
  if any slice is missing. The base Swift package remains extension-free;
  exact-extension products are generated from their separately released,
  checksum-covered carrier assets. Every extension release publishes one
  immutable `*-swift-extension-carrier.json`: the contrib bundle carrier owns
  exactly 32 SQL-member rows, while each independently versioned external
  extension carrier owns one. The carrier pins its compatible native base,
  direct extension dependency release identities, and member asset digests,
  and is covered by the product's canonical release checksum manifest. Swift's
  repeatable `--extension-carrier` composition lets an external-only release be
  consumed without a Swift version bump; base mismatch, dependency skew,
  duplicate SQL ownership, or native-dependency byte conflicts fail closed.
  Hosted macOS qualification final-links and
  runs a generated native-extension Swift executable against the produced assets.
- WASIX: portable runtime/extension carriers plus native AOT carriers for Linux
  x64/arm64 GNU, macOS arm64, and Windows x64 MSVC.
- SDK façades: Rust/Cargo, npm, Maven/Gradle, and SwiftPM entry points select
  only the needed target carriers. Deno consumes the native and WASIX
  TypeScript façades through npm, with the same product boundaries as Node and
  Bun.

The first release is fail-closed: it does not publish macOS x64, Windows ARM64,
Linux musl, Android 32-bit, or additional Apple architectures. A target becomes
supported only when the product's explicit target manifest declares it, the
publication catalog selects a corresponding carrier, and the frozen lock contains
that carrier with required evidence. A broader runtime matrix or package-manager
fallback must never imply that an undeclared target exists.

Release qualification must inspect the binaries themselves: Mach-O
`LC_BUILD_VERSION`, Android API/ELF metadata, and Linux ELF symbol-version
requirements must satisfy these floors. Package labels, runner versions, and
successful builds are not compatibility evidence by themselves.

Rust 1.93.1's Linux `std::process` implementation contains weak
`pidfd_getpid`/`pidfd_spawnp` references. Linking the broker directly on an
Ubuntu 24.04 runner binds those otherwise optional references to
`GLIBC_2.39`, which raises the load-time floor even when the fast path is never
used. Linux broker release assets are therefore linked from a clean target
directory in the exact, digest-pinned `rust:1.93.1-slim-bookworm` container.
After any bounded digest-pinned image acquisition, only Cargo's locked
dependency-fetch phase may use the network inside the container; package code
and build scripts run in a read-only, networkless, capability-free container.
The resulting broker is then executed in that baseline before staging.

Linux release stages also run in the exact digest-pinned Fedora 39 fixture
after verifying that `getconf GNU_LIBC_VERSION` is exactly `glibc 2.38`.
The rehearsal resolves every staged dynamic ELF dependency and executes the
safe version/argument probes available in the carrier. Fedora 39 is retained
solely as a reproducible ABI fixture: it is end-of-life and this check is not a
claim that Fedora 39 is a security-supported production OS. Oliphaunt's public
contract is the GNU architecture and symbol-version floor, not a distro name.

Every release-ready exact extension has stable ecosystem façades. PostgreSQL
contrib carriers belong to the matching native or WASIX runtime product; each
active external extension owns its independent product. The global extension
target-profile contract applies to every public SQL member and is checked
against the runtime target matrix.

## Recovery

On a failed normal publish, preserve the candidate SHA, run id, lock, draft
releases, receipts, and registry responses. Inventory every selected identity
as absent, matching, or conflicting, then use GitHub's rerun for the original
Release run at the exact same commit; it reconciles matching immutable state
and writes only what remains. Preserve the checkpoint chain only for
first-identity bootstrap. Product changes require a new version and candidate.

For ordinary recovery, rerun failed jobs in the original `publish` run at the release
commit with the same qualified artifacts and approved lock. Use GitHub's rerun
for the original failed Release run; do not create a fresh dispatch after
`main` moves. The original run and every referenced CI/candidate artifact must
still be available. The rerun inventories every selected identity, proves
existing registry bytes and GitHub state, skips exact matches, and writes only
missing state. A conflict stops the release.

If completion requires a publication-only fix allowed by the controller,
dispatch `publish` on current main with the original `release_commit` and
`approval_run_id`. The previous run must have completed with a successful
candidate preparation job, or be a successful legacy dry-run. Changes to
product source, packaging, builds, CI, or lockfiles require fresh qualification.
Bootstrap retains its lock-bound checkpointed recovery path.

Ordinary clean-state control-plane workflow, policy, validator,
registry-transport, test, or documentation changes do not use recovery and do
not create a release. With no other unreleased product change,
`prepare-release-pr` reports no releasable products and creates no PR; a direct
publish selects no release changes and performs no registry work. A change to a
compiler, SDK, linker, build command, source selection, target, or packaging
output requires the affected versions to advance even when the change lives in
CI.

## Handoff evidence

Record the candidate SHA/tree, exact CI run, selected product versions,
catalog/lock digests, artifact attestations, registry bootstrap/trust status,
publication receipts, promoted release URLs, and clean-install results. “The
workflow passed” is not sufficient release evidence without those identities.
