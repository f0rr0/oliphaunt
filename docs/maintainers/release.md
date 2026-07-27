# Release process

Windows publishers must also follow the [Visual C++ runtime release
contract](./windows-vc-runtime.md); it defines redistributable provenance,
extension-provider ownership, app-local placement, and receipt evidence.

Status: normative operation guide. Last verified: 2026-07-23. Owner: repository maintainers.

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
- `tools/release/release-semantic-inputs.toml` for shared byte producers and
  public target contracts that do not live under one product root;
- `tools/release/publication-catalog.mjs` for the normalized Product → Carrier inventory;
- the frozen publication lock for the actual files produced by one candidate.

Do not maintain a second hand-written package matrix. Query the catalog and inspect the lock. Dynamic package identities are forbidden except crates.io payload `part-N` carriers whose parent is declared and whose size requires splitting.

A product-local `release.toml` activates an external extension as a public
release product. It is not a harmless description of a build candidate. An
extension deferred by `publication-blocker.toml` must remain absent from
`release.toml`, Release Please, Moon release ownership, generated public SDK
catalogs, the publication catalog, and every lock. Build recipes and target
profiles may remain active solely for job-local qualification.

## Carrier license and notice checks

Legal material follows the bytes in each physical carrier, not merely the
product name or source repository. Code-only and source-only facades carry the
Oliphaunt MIT profile. A payload carrier carries its exact role profile plus
the legal files for every component whose bytes it contains. The executable
authorities are the publication catalog, `release-notices.mjs`,
`extension-upstream-licenses.mjs`, and the broker dependency-license contract;
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
- PostgreSQL 18 contrib members are owned by the single
  `oliphaunt-extension-contrib-pg18` product. That product is `runtime-bound`
  and shares the runtime linked-version group; its 32 SQL members are not 32
  separately versioned release products.
- active external extension products are `upstream-bound` and own independent
  packaging SemVer. Their upstream version/commit and compatible runtime
  versions are separate metadata. A publication-deferred external extension
  has no packaging version until it is promoted into the active product graph.
- `feat`, `fix`, `perf`, `refactor`, and `revert` are release-impacting types because the Release Please `changelog-sections` catalog says so. A Conventional Commit `!` is breaking. Release-intent checks derive this set from config.
- Product source PRs never edit versions. The generated release PR owns all version, compatibility, lockfile, and changelog changes.
- While every product is still `0.0.0`, top-level `bootstrap-sha` is the full
  legacy-history boundary `07a9054faa03d5737dc0193f7a77ed4a71920c05`.
  Release Please considers only commits after that exclusive boundary. Derived
  release-PR sync removes the key in the first generated release-bump change;
  do not remove it before Release Please has consumed it or retain it after the
  first bump. The sole exception is the exact, still-unpublished first-release
  rollback transport described under **Recovery and history repair**: that
  direct child temporarily restores the boundary only to qualify the corrected
  unreleased introduction tree, and no publishable release-bump tree retains it.

`tools/dev/bun.sh tools/release/sync-release-pr.mjs` closes the complete generated
release fixed point: dependent candidates, compatibility values, package pins,
locks, deterministic evidence, and finally every product-local release-semantic
fingerprint affected by those derived inputs. Its `--check` mode proves that the
same fixed point is already closed. Structured release-commit verification
accepts fingerprint changes only when their ownership topology is unchanged,
every recorded input digest matches the exact parent/head Git blob, the
top-level digest and JSON bytes are canonical, and each changed input is itself
an authorized release-derived path. Pure version/changelog changes alter
package envelopes but do not alter the separate committed WASIX binary-semantic
fingerprint.

PR CI runs `sync-release-pr.mjs --check-generated-release` only for the
same-repository `release-please--branches--main` head, before artifact planning.
That cheap barrier checks the dependency/compatibility/lock/fingerprint fixed
point and the exact structured release commit without compiling the asset
verifier. It prevents Release Please's transient raw PR commit from launching
the native and mobile matrices while the prepare job is still normalizing it.
It is an admission optimization, not a substitute for the full write/check,
metadata, asset, extension, and package gates on the normalized head.

Shared code that can change published bytes or a declared public target must
have one exact ownership rule in `release-semantic-inputs.toml`. The generated
`.release-semantic-inputs.json` file under each affected product root gives
Release Please a content-addressed trigger without treating workflow,
validator, registry-transport, test, or documentation edits as product
releases. After changing an owned shared input or its ownership, run
`tools/dev/bun.sh tools/release/sync-release-semantic-inputs.mjs --write` and
then `--check`; do not hand-edit the fingerprints. On a generated release PR,
use `sync-release-pr.mjs` instead: it refreshes these files only after its final
derived semantic input has converged, so interruption recovery and a second
write/check pass are idempotent.

### Generated dependent candidates

Release Please remains the sole authority for direct candidates and their
version policy. After the canonical generated PR is normalized, derived sync
computes the deterministic downstream fixed point from three graph-owned
relationships:

- Moon `production` and `peer` edges, traversed from dependency to consumer;
- compatibility metadata, traversed only from `source_product` to the product
  that owns the compatibility field; and
- the runtime/contrib-bundle linked-version group.

Moon `build`, development, and test edges never expand a release. Dependency
edges are never traversed backwards. Consequently a directly changed external
extension remains an independent one-product release unless another real
consumer depends on it; a runtime change selects external extension products
whose own compatibility fields must advance.

The Release Please linked-versions plugin must create a complete, same-version
runtime group. Sync rejects incomplete output rather than reproducing that
plugin. For another missing dependent that has already shipped, sync creates a
patch candidate, updates only the canonical and extra version files already
declared in `release-please-config.json`, and inserts a deterministic
`Dependencies` changelog entry naming the exact graph reason. A missing
dependent still at `0.0.0` is a hard failure: Release Please must choose its
first version. The sync command reloads the expanded manifest before updating
compatibility fields and package/lock dependencies, then `--check`, structured
release-commit verification, and release-PR coverage independently require the
fixed point to be closed. Do not hand-edit a missing candidate into a source PR
or weaken dependency scopes to make this gate pass.

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

## Qualification contract

Root publication admission accepts only a current-main candidate with one non-cancelled CI run whose `head_sha` is exact and whose `Qualified` gate succeeded. That record covers required checks, tests, builds, policy, selected E2E, and named build artifacts. A successful `Builds` job alone is insufficient. After the root job pins the immutable release transport tag, downstream phases continue that exact transaction without re-evaluating the moving main branch.

The `macos-26` publication runner is ARM64, but its current runner-image
contract exposes the installed Java 17 path as `JAVA_HOME_17_arm64` (including
that lowercase suffix). Release setup uses that exact variable first, permits
`JAVA_HOME_17_X64` only as an Intel-image fallback, and fails before release
work unless the selected path contains an executable `bin/java`. Do not invent
the variable name from the architecture or rely on the image's moving default
Java version for Maven or Gradle publication.

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

If the candidate changes a GitHub workflow or local action, also run
`bash tools/policy/check-workflows.sh`. That conditional gate runs the pinned
`actionlint` and `zizmor` configuration plus workflow behavior tests;
`actionlint` by itself is not equivalent.

The default `release-check.mjs` invocation includes the live repository graph
check and the release mutation unit suite. In Moon, the uncached
`release-tools:check` task is the single hosted owner of that graph validation;
the read-only `graph-tools:check` target is available for focused local use but
is excluded from hosted selection, and only `graph-tools:generate` writes
`target/graph`. `release-metadata-check.mjs` is a distinct internal replay
surface that still executes every live release-policy, Release Please, target,
version, changelog, synchronization, and consumer-shape check. The workflow may
call it only after the structured generated-release commit verifier succeeds,
or after the exact hosted qualification record is reverified against a clean
checkout at `RELEASE_HEAD_SHA`. Do not substitute it for the full local
pre-dispatch gate.

The `Release` workflow has four operations:

1. `prepare-release-pr` — run from current `main`; creates/updates the single generated release PR and syncs derived files.
2. `publish-dry-run` — downloads exact-SHA CI artifacts, performs package/registry preflight and clean-consumer checks, freezes/verifies the lock, and emits the lock-bound Cargo/npm bootstrap capsule without write credentials.
3. `publish-bootstrap` — creation of missing npm/crates identities only, from the already-approved capsule in bounded resumable Linux jobs. npm requires a short-lived granular `@oliphaunt` read/write token with 2FA bypass for this noninteractive first publication; the exact operator checklist is in `release-setup.md`. Configure trusted publishers and revoke every provisioned bootstrap token immediately after the chain seals. The current first release needs both Cargo and npm credentials, while a future single-registry identity addition must provision only that registry's token.
4. `publish` — normal trusted release. It uses short-lived Cargo/npm/JSR credentials, Maven protected secrets, the frozen lock, and idempotent publication checks.

Only a successful `publish-dry-run` uploads the canonical
`oliphaunt-publication-lock` and `oliphaunt-bootstrap-capsule` approval
artifacts. Bootstrap selects one successful same-SHA dry-run that contains both
artifacts, downloads both by that one run ID, verifies the embedded lock is
byte-identical to the separately downloaded lock, and atomically installs only
the exact locked Cargo/npm bytes. It does not rebuild packages. Normal publish
independently reassembles the complete candidate from the same exact-SHA CI
artifacts, downloads the approved lock, and byte-compares the two locks before
publication. A mutating run therefore cannot
approve itself or silently combine artifacts from different dry-runs.

`.github/workflows/release.yml` is the one directly dispatched release
workflow. Its operation jobs declare their own least-privilege permissions and
protected environments: dry-run is repository-read-only, bootstrap adds OIDC
and `contents: write`, preparation receives only release-PR writes, and normal
publication separates staging, registry, and finalization grants. Bootstrap's
content write exists solely for the root generation to create the immutable
release transport tag immediately before its first registry mutation;
continuation generations never create, update, or delete that tag. Dry-run and
normal staging are separate jobs over one YAML-anchored step list, so this
separation does not create two release implementations that can drift.

Credential-bearing steps execute only in direct jobs that select the
corresponding protected environment. The YAML anchor shared by dry-run and
staging contains Maven secret expressions, but every such step also requires
the literal `publish` operation and therefore cannot execute in dry-run.
`release-pr`, `release-bootstrap`, and `release-publish` remain the credential
boundaries; do not duplicate their secrets at repository level or route those
jobs through a reusable workflow that changes the environment-secret boundary.
GitHub automatically provides each job's scoped `GITHUB_TOKEN`.

Trusted publishers match `release.yml`: direct publication exposes that file
through `workflow_ref`, together with the exact `workflow_sha` and the
`release-publish` environment claim. A root run has the `main` branch ref; an
automatic continuation has only the deterministic
`oliphaunt-release-transport/<full-sha>` tag ref and a `tag` ref type.
There is no called-workflow
`job_workflow_ref` in this topology. An unconditional, bounded,
repository-read-only validation job checks the canonical repository, exact
workflow commit, operation, optional exact commit, continuation pointer, and
the corresponding root-main or exact-transport ref
before any operation job. Malformed or contradictory manual inputs therefore
fail before release work begins.
After bootstrap, derive the complete configuration inventory from the exact
publication lock with `tools/release/trusted-publisher-config.mjs`. Its default
plan is offline/read-only; authenticated inspection requires `--audit`, and
creation requires both `--apply` and confirmation of the exact lock digest.
Wrong or extra configurations are blockers and are never automatically
replaced.

Normal release execution reuses the verified Node and pnpm payloads installed
by `setup-moon`; the slim bootstrap job uses the same digest-pinned Node runtime
through `setup-node-runtime`. Neither path relies on Corepack. When the selected
carrier set includes npm, both normal and bootstrap jobs use
`setup-npm-publisher` to install the workflow-pinned npm archive. That action
verifies the canonical URL, compressed digests and byte count, safe archive
shape, executable modes, and complete extracted-tree digest before exporting
the CLI. It then compares the observed npm version exactly and validates the
observed Node/npm trusted-publishing runtime. This local tool setup neither
requests an OIDC token nor changes the frozen registry mutation logic.

Installer fault-injection suites are owned by the exact-SHA
`ci-workflows:check` gate. Publication does not execute those download, cache,
and rollback suites again. Release-PR preparation runs one full release check
before generation and the live metadata checker only after structured commit
verification. The protected GitHub-staging job runs one full release check before
qualification, then uses the live metadata checker only after the same-SHA
`Qualified` record is verified.
`--qualified-ci` is not a trusted Boolean bypass: the publisher rejects dirty
or non-hosted use, binds HEAD to `RELEASE_HEAD_SHA`, and reruns the fixed
candidate/plan/WASIX-evidence verifier before omitting mutation tests. Workflow
policy rejects extra full invocations or replay before candidate verification.

`release_commit`, when supplied, is an assertion that must equal the workflow
commit. It cannot select historical code. A tooling fix is a new candidate and
must pass new qualification. At the mutation boundary, a root
`publish-bootstrap` or `publish` run first reads the lightweight
`oliphaunt-release-transport/<full-sha>` tag and accepts only a direct commit
ref at its exact release SHA. If the tag is absent, or this is the first run
attempt, the helper proves current `main` before creating or accepting it;
creating an absent append-only tag is the root generation's first mutation.
Only a genuine rerun (`GITHUB_RUN_ATTEMPT > 1`) of the exact root operation,
original `refs/heads/main` workflow SHA, and empty continuation may reuse an
already exact tag after `main` advances. A missing tag still requires the proof
on every attempt, while a wrong or annotated tag fails closed. The helper never
updates or deletes the tag and never replays an ambiguous create. Continuation dispatch verifies the ref both
before and after any bounded delay and dispatches the child from the tag rather
than from moving `main`. Registry and finalization jobs remain exact-SHA and
lock/handoff bound; they deliberately do not require `main` to remain frozen
after the first mutation.

## Publish order

Cross-registry publication cannot be atomic, so the workflow is resumable and state-driven:

1. validate names, ownership, versions, auth mode, exact SHA, and registry collisions;
2. create the exact immutable continuation transport, then exact product tags and draft GitHub releases;
3. upload and attest selected GitHub assets and create the frozen Swift source tag outside the registry executor;
4. execute the publication lock's dependency topology: payload parts/leaves before aggregators/façades and runtime carriers before dependent SDK carriers;
5. prove public registry bytes, then run the exact public-consumer gate once and preserve its lock-bound evidence;
6. promote verified GitHub release drafts last.

Normal publish realizes that order as three successful jobs, never as one
runner carrying mutable filesystem state: `publish` leaves only tags, drafts,
assets, and attestations staged; `publish-registry` installs an immutable
handoff and publishes the exact registry topology; `publish-finalize` installs
the receipt-only handoff, probes public consumers, and promotes drafts. Each
handoff binds the source commit/tree, selected products,
lock/catalog/package-envelope digests, approved dry-run artifact
IDs/digests/sizes, and every transported file digest/size. The downstream job
downloads a current-run handoff by immutable artifact ID and rejects missing,
extra, changed, executable, or path-unsafe payloads.

Continuation dispatch is part of the same direct workflow but remains outside
the protected credential jobs. A deferred bootstrap result flows from
`publish-bootstrap` to `dispatch-bootstrap-continuation`; a deferred normal
registry result flows from `publish-registry` to
`dispatch-publish-continuation`. Each dispatcher has only Actions write and
repository read, receives no release environment or registry secret, and may
dispatch only the immutable exact-parent pointer emitted by its direct parent.
It dispatches `release.yml` at the SHA-derived transport tag; the child input
gate rejects `main`, another tag, or a tag name derived from any other SHA.

The workflow does not encode a second product/ecosystem publish order. Before
the first mutation it writes `normal-publication-plan.json` directly from the
approved lock. The normal registry executor consumes that same plan and rejects
an omitted selected dependency, unknown carrier, cycle, or non-contiguous
operation order. It runs one sequential Cargo, npm, Maven, and JSR lane,
overlaps independent lanes, and awaits every explicit cross-registry dependency
barrier. Cargo (including dynamic payload parts), npm, and JSR consume their
exact frozen carrier bytes. All selected Maven coordinates form one
signed, atomic Central deployment because Maven Central validates and publishes
that bundle as a unit. Before the first GitHub write, the workflow constructs
the complete selected bundle without upload and verifies every coordinate,
POM, primary artifact, sources JAR, javadoc JAR, signature, checksum, nonempty
file, and the strict sub-1-GB archive ceiling. A rerun skips an immutable carrier only after proving its
public bytes match the lock; a partially published Maven product fails closed.

JSR publication resolves the exact lock-installed CLI owned by
`src/sdks/js`, validates its package identity, lock integrity, and executable,
and invokes that absolute executable while retaining the frozen source as the
working directory. POSIX runs the package executable directly; Windows invokes
that same file through the absolute Node executable already verified by release
setup, because Windows does not execute JavaScript shebangs. Never replace this
with an ambient `jsr` or a `pnpm exec` lookup from `target/`: the frozen source
intentionally has no workspace `node_modules` tree.
The registry runner performs a frozen, script-disabled install filtered to
`@oliphaunt/ts` before the mutation gate, using the digest-pinned Node and pnpm
toolchains. This installs the one lock-owned JSR publisher without relying on
global state or spending the registry deadline on unrelated workspaces.

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
write. The slim bootstrap job consumes only the canonical dry-run's
manifest-bound Cargo/npm capsule; it neither reconstructs packages nor repeats
the macOS build ceremony. Bootstrap preserves the lock's Cargo/npm dependency
edges and executes one sequential lane per registry, overlapping only
independent operations. Its one serialized checkpoint writer receives newly
completed carrier IDs in canonical lock order and appends content-addressed,
hash-chained checkpoints containing normalized registry byte receipts. A lane
failure stops new starts, lets the peer's one in-flight immutable mutation
drain, and triggers a final reconciliation/checkpoint attempt; publication and
checkpoint failures are reported together rather than masking either. The
workflow uploads the chain even when a later phase fails and restores the newest
compatible chain for the same workflow and exact SHA on a rerun attempt or a
fresh recovery dispatch. Sealing succeeds only after
every expected Cargo and npm identity exists with lock-matching bytes; an
altered, missing, reordered, or conflicting checkpoint fails closed.

Before that genesis checkpoint, bootstrap performs a read-only crates.io name
inventory from the exact frozen lock. Crates.io's default per-user new-name
bucket (5 immediately, then one every 10 minutes) cannot accommodate the full
first-release catalog in one hosted job. No API exposes support-granted account
capacity, so an operator-entered number is not accepted as a correctness gate.
The planner uses the documented bucket, treats a valid `429 Retry-After` as
authoritative, and admits only a dependency-closed batch that fits the current
window. After progress, it uploads the immutable checkpoint before a separate
credential-free job dispatches an exact-parent continuation. The continuation
is bound to the release SHA/tree, lock and package-envelope digests, products,
root and parent run identities, artifact ID/digest/size, checkpoint identity,
and a bounded generation. Zero-progress recursion is forbidden; ambiguous
uploads and integrity or checkpoint failures remain hard failures.
For normal publication, every continuation artifact also carries the latest
content-write pacer and core-request journal. A child verifies their hashes,
sizes, schemas, counters, and root-run identity, merges any reads it performed
while locating that exact parent artifact, and seals the monotonically extended
state into the next generation. No child may reset rolling limits by falling
back to its own run ID or to the original stage snapshot.

Every mutating phase records its own hard deadline rather than inheriting time
left on a previous runner. Bootstrap and normal registry publication each have
an independent six-hour hosted-job envelope. The normal GitHub-staging job has
a 350-minute hard window plus ten minutes for cleanup; the registry job also
has a 350-minute hard window plus ten minutes for cleanup; finalization has a
114-minute hard window plus six minutes for cleanup. The executable phase-budget table accounts for setup, exact-ID
transfer, validation, mutation, evidence/handoff, and cleanup and requires a
strictly positive margin in every phase. A bootstrap root starts its registry window only after
qualification, capsule/lock verification, checkpoint restoration, and the
root transport boundary described above; a bootstrap continuation instead
proves the exact transport ref and parent authorization.
The window is clamped to the earlier of 5.5 hours from that point or the job
hard deadline. Normal registry mutation starts only after the
approved capsule and GitHub-stage handoff have been independently verified,
and the exact staged releases and recovery checkpoint have been revalidated at
the release SHA. Before beginning GitHub mutation, the root staging job either
proved current `main` inside the transport boundary or, only on a genuine exact
rerun, reused the tag that the prior attempt had already pinned; later
registry and finalization jobs never substitute moving `main` for their exact
checkout, handoff, tag, draft, and publication-lock proofs. Registry publication requires its complete
rate-aware mutation allowance plus positive margin before the protected
15-minute receipt/recovery handoff; a shortened residual window cannot admit a
partial planned run unless the executor can close a dependency-safe checkpoint
and issue an exact-parent continuation. Finalization refuses to start unless at least 48 minutes
remain on its fresh deadline. Bootstrap additionally proves that the exact pending Cargo/npm
inventory plus its reserve fits before mutation begins.

Normal publication applies the same immutable-version rule to every supported
registry: crates.io checks the published checksum, npm checks `dist.integrity`,
Maven Central streams and hashes each frozen payload at its exact coordinate,
and JSR compares the complete published file manifest with the frozen explicit
`publish.include` set. A complete, same-lock bootstrap ledger is verified in
bounded parallel before mutation and its Cargo/npm receipts are reused by the
normal executor; already-proven public identities are not queried serially
again. Each registry publisher returns the exact receipt it proves; the
executor assembles those results in canonical operation order, rejects missing,
extra, duplicate, or replaced receipts, and writes one exhaustive lock-bound
receipt file (including a valid empty receipt set for a source-only release).
It also atomically checkpoints the dependency-closed completed operation set
after every successful registry operation. Mutually exclusive success/failure
evidence steps retain exactly one `normal-publication-recovery-<SHA>` artifact
per run. On registry success, a separate immutable receipt-only handoff feeds
finalization without retransferring package payloads; on failure, the
dependency-maximal checkpoint remains recoverable without authorizing the next
job. A retry fully
paginates bounded exact-workflow/exact-SHA inventories, selects the unique
dependency-maximal checkpoint, and reuses it only after strict source, lock,
catalog, package-envelope, plan, and receipt validation.
Final verification validates that evidence locally instead of downloading and
reproving every registry package.

The post-publication consumer gate is an actual anonymous public-endpoint
probe, not the static consumer-shape policy check used during qualification.
It derives its products, ecosystem lanes, dependency roots, full carrier
closure, versions, Maven coordinates, and Git tags from the same frozen lock.
In parallel clean temporary homes/caches it resolves each Cargo consumer root
in an independent scratch manifest without compiling payloads, installs each
npm dependency root in an independent project, resolves each Maven entry in an
isolated Gradle configuration without an Android build, caches each exact JSR
entry import, and anonymously fetches every product tag. Each lane requires
the resolver's platform-independent lock graphs to cover every carrier in the
corresponding frozen dependency closure; a missing carrier cannot be silently
relabelled as receipt-only. It never invents one all-platform consumer graph.
Evidence separately identifies npm carriers not installed on the macOS host
and Cargo payloads intentionally not fetched/compiled; immutable receipts
prove those bytes. When Swift is
selected it also fetches the unscoped source tag,
requires its synthetic commit to have the release SHA as its only parent, and
evaluates that tagged `Package.swift` with `swift package dump-package`.

Known registry/CDN not-yet-visible and transient network responses are retried
only within one shared deadline. Every retry uses a new workspace and package
cache so a partial npm install or Gradle negative cache cannot authorize a
result. Exact-version, exact-source, closure, tag, and receipt mismatches are
terminal. The gate emits one deterministic immutable evidence file bound to
the registry receipt hash, GitHub receipt digest, lock digest, source SHA/tree,
and selected products; that file is uploaded before draft promotion. The
finalization job runs on macOS, so npm's `installedCarrierIds` proves only the host
subset actually installed there. The exact lock/receipt set and same-SHA CI,
not this host probe, prove the complete supported OS/ABI matrix.

Draft release assets are intentionally not claimed to be anonymously public.
In particular SwiftPM binary-target downloads cannot be a genuine public
pre-promotion test; the gate proves the public source tag and manifest while
the already-validated GitHub receipt proves every frozen binary-target asset.
Drafts remain unpromoted if either half fails.

GitHub release assets use the same immutable phase handoff. Each pinned provenance
action emits one signed bundle covering its complete subject set. Before the
registry clock starts, the workflow verifies each nonempty bundle once against
the frozen local lock bytes, checks the exact remote release asset set for
every selected product (including an explicit empty set for source-only
products), and freezes a lock/source/release-ID/digest receipt. Finalization
rechecks only immutable GitHub release IDs plus asset names, sizes, and SHA-256
metadata against that receipt. It never serially downloads and re-attests the
hundreds of extension assets after registry publication.
The CI extension artifact is intentionally broad, but an extension attestation
is not: its subjects are re-hashed paths derived from only the selected
exact-extension products' frozen GitHub asset and metadata rows. A subset
release therefore cannot attest an unselected exact-extension product merely
because both products were present in the downloaded CI artifact.

GitHub's primary `GITHUB_TOKEN` allowance and secondary content-creation
allowance are separate release constraints. The GitHub-staging request model is
derived from the frozen publication lock: selected products, exact per-product
asset counts, attestation subjects, qualification transfers, and live release
pagination all feed the admission calculation. The total may intentionally
span more than one rolling hour, so it is not compared directly with the hourly
allowance. The admission gate uses the current rolling request journal, a
361-request maximum paced hour, and a 100-attempt retry reserve, and rejects a
projected rolling count of 900 or more. Release-list pages are derived from the
live count plus every selected draft that may be created, and every product
uses the dedicated paginated asset endpoint; embedded release asset arrays
never authorize publication.
Every REST collection follows validated `Link` relations one page at a time;
opaque `gh api --paginate`/`--slurp` reads are forbidden so each physical page
attempt, including a retry of the same page, receives its own durable core-request
reservation before transport. Exact 100- and 200-row boundaries stop from the
response metadata without issuing an unbudgeted empty trailing request.
Snapshot reads distinguish ordinary authorization failures from GitHub primary
and secondary limits, honor bounded `Retry-After` or `X-RateLimit-Reset` waits,
and otherwise use GitHub's one-minute exponential backoff guidance inside a
five-minute phase deadline.
Completed workflow metadata and artifact
identities are captured once per immutable run and reused; artifact ZIPs are
downloaded only by exact ID and verified against GitHub's size and SHA-256.

Every product tag, draft, asset upload, SwiftPM source-tag push, attestation
bundle, and promotion shares one 10-second content-write pacer. The exact write
count is lock-derived, with at most 361 in any rolling hour and seven in any
rolling minute. Asset-backed products execute in bounded waves of at most five
uploader processes; products with an exact empty asset set are proven by the
pre-mutation and final receipts without consuming an uploader lane. A new
runner starts a conservative
rolling-hour cooldown at the beginning of the GitHub-staging job; read-only
qualification and artifact preparation overlap that window. The first actual
write still waits for the window to mature, and every reservation is persisted
before its request. Every core REST attempt, including retries and the API call
inside each attestation action, is also reserved in a durable run-identity-bound
journal before transport; attempt 901 inside one rolling hour is refused.
Each sealed handoff carries both journals, and a downstream runner accepts them
only when their repository/root-run/source identity and manifest bytes still
match. A runner that cannot prove continuity fails closed; exact remote-state
reconciliation still prevents immutable mutation replay. Before the first
write, the lock-derived admission gate proves the complete selected-product/
exact-asset pacing and bounded upload-wave plan plus the immutable stage
handoff fit the stage hard deadline, and simulates a conservative full registry
window for the capacity preflight. The workflow repeats the live
page/clock/rolling-request admission
immediately before the cold-start reservation. A paced mutation receives its
complete configured transport timeout only when that timeout still fits the
absolute operation deadline after pacing and core-request journal admission.
Read transports recompute and clamp their attempt timeout after journal admission,
and never start if the overall read deadline was exhausted while acquiring the
journal lock. The SwiftPM source-tag push is likewise
noninteractive and bounded; success, rejection, disconnect, and timeout are all
resolved by an exact remote tag/SHA read before the result is accepted. Before
any release mutation, a lock-derived SwiftPM preflight constructs the exact
manifest commit without creating a local tag and accepts only an absent remote
semantic tag or one already pointing at that exact commit; a conflicting or
ambiguous tag blocks the release before GitHub drafts are staged. Both
durable journals and the complete asset-wave report cross the validated
receipt handoff before public promotion. Promotion is the literal final step
of `publish-finalize` and the only remaining public
mutation; an interrupted partial promotion is resumable because the next run
accepts only exact already-public releases, promotes the remaining exact draft
IDs, and finishes with one exact tag/release snapshot.

The normal lane has one all-registry pre-mutation admission contract. It
inventories every selected frozen Cargo and npm `name@version`, routes absent
names back to identity bootstrap, budgets pending Cargo and npm publication,
the atomic Maven deployment, JSR, uncovered public-version reconciliation, and
executor contingency. It computes the critical path from explicit dependency
edges plus implicit same-ecosystem serialization, then compares that path and
reserve with the authoritative mutation window. When the full remaining graph
does not fit, it chooses the canonical first-fit maximal dependency-closed
operation subset. This deliberately preserves frozen plan priority rather than
maximizing the count of cheap reconciliation rows; independent registry lanes
still fill otherwise idle critical-path capacity. Every successful partial run
checkpoints at least one operation, so an N-operation frozen plan needs at most
N invocations. Admission also checks every remaining indivisible operation
against an empty fresh window before it authorizes any mutation. An
intrinsically oversized later operation therefore fails immediately instead of
being discovered after earlier progress or creating an unbounded continuation
chain. A verified bootstrap-ledger receipt removes its public Cargo/npm carrier
from the reconciliation budget. For Cargo rate admission, the gate uses
crates.io's documented default burst of 30 followed by one version per minute.
It overlaps publication work with bucket refill using the recurrence
`start = max(previous_finish, (index - burst) * refill)` and never trusts an
unverifiable capacity secret. A support-side exception naturally allows an
earlier accepted upload; a valid `429 Retry-After` is authoritative. If the
exact dependency graph still cannot fit, the registry checkpoint is uploaded
and an exact-parent continuation resumes it; finalization cannot run until the
receipt set is exhaustive.
Temporary trusted-publishing tokens expire after 30 minutes, so the executor
refreshes them in bounded batches and revokes each token; one early job token is
never treated as a release-long credential. The per-carrier values are
calibrated admission estimates, not worst-case bounds on registry visibility;
the absolute deadline stops pathological latency. A rerun of the same frozen
lock reclassifies matching public partial mutations, proves their checksum/SRI
or payload manifest, and never blindly replays an ambiguous immutable upload.

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
  runs a generated native-extension Swift executable against the exact candidate
  assets.
- WASIX: portable runtime/extension carriers plus native AOT carriers for Linux
  x64/arm64 GNU, macOS arm64, and Windows x64 MSVC.
- SDK façades: Rust/Cargo, npm, Maven/Gradle, and SwiftPM entry points select
  only the needed target carriers. JSR is deliberately protocol/query-only and
  does not claim native runtime carriers.

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

Every release-ready exact extension belongs to exactly one active product and
stable ecosystem façades. PostgreSQL contrib members belong to their shared
contrib product; each active external extension owns its independent product.
A build-only or publication-deferred extension owns neither. Each active
exact SQL member's `targets/artifacts.toml` explicitly declares
supported/unpublished targets and evidence. The runtime target matrix bounds
possible values but never creates extension support by default.

## Recovery and history repair

On a failed publish, preserve the candidate SHA, run id, lock, complete checkpoint chain, draft releases, and registry responses. Inventory every selected identity as absent, matching, or conflicting; restore and validate the exact-SHA chain, then resume only missing phases. Repository changes require a new version and candidate.

A deferred extension is never a recoverable missing publication. If it appears
in a release PR, dry-run artifact set, or lock, reject that candidate, remove
the extension from the active public graph, and qualify a new exact SHA. Do not
bootstrap its reserved identity, publish its job-local outputs, or bypass the
declared blocker to resume another product.

History repair is allowed only before any affected product tag/package is public. Freeze main, archive and bundle the old tip, then qualify the replacement tree with an all-target manual CI run on a retained temporary branch. The one tree-identical introduction commit must contain exactly one `Oliphaunt-History-Repair-Candidate: <lowercase-full-sha>` trailer naming that qualified branch commit. Bind the one-shot repair predecessor to the exact old tip, use an exact `--force-with-lease` only with explicit maintainer authorization, and immediately restore force-push protection. Rewritten-main CI selects the exact run and immutable artifacts named by the trailer, verifies the retained remote branch tip and equal Git tree before planning, and then runs the complete non-cancelled graph. Temporary-branch `Qualified` evidence is deliberately ineligible for publication; the rewritten main needs its own `Qualified` record.

If the superseded tip is the still-unpublished generated first-release commit,
the retained qualification transport is a direct child of that exact tip even
though its desired tree restores every product to the unreleased `0.0.0`
state. This one regression is accepted only when the child restores the
immutable `bootstrap-sha`, its parent manifest contains exactly the configured
first versions (including Swift `0.6.0`), its candidate manifest has the same
complete package paths at `0.0.0`, and every changed workspace package version
also ends at `0.0.0`. Dispatch it only from the exact branch exported as
`RELEASE_PLEASE_HISTORY_REPAIR_CANDIDATE_BRANCH` with `wasm_target`,
`native_target`, and
`mobile_target` all set to `all`. Push, pull-request, main, tag, another branch,
an indirect descendant, or a partial rollback cannot use this transport
exception. Its `Qualified` result proves only the replacement tree; it does
not authorize the final non-fast-forward update.

If that exact-main run exposes another defect, do not layer a fix commit onto the intended public history and do not prepare a release. Archive the superseded introduction separately, qualify a new replacement tree, and repeat the controlled rewrite. Rotate only `RELEASE_PLEASE_HISTORY_REPAIR_BEFORE_SHA` to the current main tip; the Release Please bootstrap boundary and displaced-main metadata baseline remain immutable, and every earlier repair predecessor must be rejected as a replay. The desired public bootstrap history remains one tree-identical introduction commit followed by one generated release-bump commit. See `.codex/skills/release-oliphaunt/references/recovery.md`.

## Handoff evidence

Record the candidate SHA/tree, exact CI run, selected product versions, catalog/lock digests, artifact attestations, registry bootstrap/trust status, publication ledger, promoted release URLs, and clean-install results. “The workflow passed” is not sufficient release evidence without those identities.
