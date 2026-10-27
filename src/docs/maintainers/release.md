# Release process

Windows publishers must also follow the [Visual C++ runtime release
contract](./windows-vc-runtime.md); it defines redistributable provenance,
extension-provider ownership, app-local placement, and receipt evidence.

Status: operation guide reviewed against native release entrypoints on 2026-10-13. Complete hosted qualification, the seed adoption anchor and legacy CI retirement remain pending. Owner: repository maintainers.

Oliphaunt releases independent products from one monorepo. There is no repository-wide product version.

The release entrypoints require `Native Bazel qualification / Required` for the
exact source SHA/tree. The workflow in `.github/workflows/bazel.yml` constructs
source-owned Bazel shipping exports and runs their mandatory configured tests.
Bazel's dependency graph and action cache determine execution; release preparation
compares delivered bytes with each product's authenticated completed publication
before selecting necessary owners. An ordinary build or test dependency is not
an automatic release bump.

Ordinary source CI imports one immutable public-input pool. A generated release
PR imports the authenticated inputs retained by its canonical `Release / Prepare
release PR` producer. Required checks every predecessor and audits construction
across all 27 products. That audit is construction evidence, not publication
admission. PR and merge-queue runs cannot supply reviewed-main assurance.

Native release preparation and freezing are implemented, but the migration is
not yet fully qualified: complete hosted platform/device results, the genuine
14-seed adoption contract and retirement of legacy CI are still outstanding.
Legacy CI remains for parity; its `Qualified` result is not the native release
selector or publication gate. A successful individual native job or local test
does not close these gaps.

Publication requires an exact successful eligible-main Native run, authenticated
final selected outputs, complete supplier and owner qualification coverage, and
the prepared-source bridge. Final installed consumers and `Publication ready`
remain separate prerequisites. Missing, failed, wrong-source or incomplete
proof blocks publication. Pre-publication recovery may retain a prior exact
source after allowlisted control fixes; it preserves original source/run/file
identity and never rebuilds binary producers.

## Model

A product owns its SemVer, changelog, source identity, Release Please component,
product tag, and GitHub release. A carrier is one published representation of
that product for an ecosystem, OS/ABI, or payload limit. All carriers for a
release use their product's version.

The canonical model is composed from:

- source-owned Bazel rules, configured shipping exports and captured production inputs for construction and qualification;
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
- Product source PRs never edit product versions or generated changelogs. Source PRs may author dependency requirements in conventional manifests. Release Please owns product versions and its ecosystem dependency updates; sync projects actual compiled inputs and manifest requirements into package metadata and lockfiles.

`bash tools/release/sync-release-pr.sh` closes the generated
candidate metadata: compatibility values for selected
consumers, package pins, locks, and deterministic evidence. It never creates a
consumer release merely because one of its dependencies changed. Its `--check`
mode proves that the same state is already closed. Pure version/changelog
changes alter package envelopes but do not alter committed runtime binaries.

The prepare workflow generates and validates the candidate locally before its
first push. It retains `native-release-inputs` before publishing the completed
PR tree. Native CI resolves the canonical Prepare run and verifies the exact
version-only source transition before expensive construction. A normalized
release PR has one source parent and the expected manifest/version/changelog
transition; an arbitrary `chore(release):` title is insufficient.

Native preparation supplies necessary owners from physical delivery comparison.
Pinned Release Please remains responsible for version and changelog calculation,
using commit intent bounded to those owners' captured source and loaded recipes.
Workflow, validation, transport, test and documentation changes do not themselves
require a product release. An unknown completed baseline or incomplete physical
coverage blocks the decision rather than falling back to path ownership.

### Independent candidates and pinned dependencies

Native delivery comparison selects necessary product owners; Release Please
owns their versions and changelogs. Shared contrib bytes can select both runtime
owners because each delivers those bytes. Dependency declarations and ordinary
Bazel build/test edges do not create another release candidate.

A dependency requirement is a consumer declaration. Releasing a producer does
not rewrite unselected consumers. Source-only SDKs preserve their authored
requirements except for Release Please ecosystem updates and the default
extension install closure described below.
A compiled payload names the source versions it actually incorporates. The
shipping owner's typed supplier Files and their original configured producer
closures establish that incorporation. ABI-only relationships do not silently
retarget held consumers. Carrier versions equal their owning product version.

Every compatibility reference declares `public_support`. Set it to `true` for an
exact host supplied independently by the caller, such as an external extension's
native or WASIX runtime. Set it to `false` for a private dependency or artifact
provider requirement. Removing a published public host supplies breaking intent
before Release Please chooses a version, including workspace-created candidates.
The release-commit verifier also checks the previous immutable product tag, so an
authored retarget before the release commit cannot evade the breaking boundary.
The configured pre-1.0 policy requires a minor bump; stable products require a
major bump. A private dependency update does not automatically imply a breaking
public API change.

Compatibility means that a declared installation recipe resolves and works.
The default SDK plus independently packaged extensions is one supported recipe.
Candidate preparation compares the selected packages with unchanged packages'
immutable release requirements. An exact extension host change selects the
required SDK, platform wrapper, addon and extension candidates; Release Please
chooses their versions and updates their conventional manifest requirements.
Runtime-only and compatible SDK-only or extension-only releases remain narrow.
Private broker, query and other unrelated requirements retain their authored
pins. Product version numbers remain independent, and historical combinations
retain their original requirements. Admission independently rejects a broken
default recipe. Frozen npm consumers install the declared SDK and extensions,
create the extensions and execute extension SQL through the existing host cases.
Recipes also depend on extension members, provider ABI and target profile;
runtime version equality alone is insufficient.

Bazel owns compiler inputs, generated payload dependencies and execution
configuration. Native evidence retains the full reached action DAG and hashes
its required physical boundary: source/tool/repository leaves, consumed typed
supplier Files, reached seed receipt/frozen pairs and final outputs. A valid
cached action need not leave arbitrary intermediate objects on disk. Missing or
unreadable required inputs still fail; incomplete supplier origin coverage stays
unknown. Cargo metadata ownership and a second declaration graph are not release
selection fallbacks.

For a new shipped owner, declare its actual output roots, consumed supplier Files
and mandatory configured tests in the source-owned shipping export. Source-only
facades preserve conventional requirements and qualify their packages without
inventing compiled incorporation. Package tests must exercise independently
advanced producers: held requirements use authentic completed archives even when
the workspace has the same version, while current construction identifies its
actual Files. A version match alone proves no physical origin.

Product-local `compatibility_versions` describe the requirements a carrier
consumes. A native runtime may release without bumping an SDK, whose older pin
remains intact. A selected compiled consumer records its actual incorporated
inputs. Other requirements retain authored values except for Release Please
ecosystem updates or necessary default-install adoption. Publication orders a
selected satisfying dependency before its consumer.

Cargo library declarations keep [Cargo's normal version requirement semantics](https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html#version-requirement-syntax):
`0.3.1` is a compatible minimum; `=0.3.1` is exact. Completed source-baseline
acquisition currently uses a stable literal minimum or exact `=` value as a
locator for one immutable completed source carrier. That lookup does not resolve
arbitrary registry ranges. Local `path` declarations remain normal Cargo
requirements checked against the local package. A library requirement and its
separately authored installed-helper locator can differ; source packages retain
the library requirement, while helper payload acquisition uses its own locator.

Before publishing a selected consumer, version checks require each exact artifact
dependency to be either selected at that exact version or already available at
its exact product tag and registry/GitHub carriers. Selecting a newer dependency
does not satisfy an older consumer pin. Structured release-commit verification
also rejects source changes hidden inside compatibility-only edits.

Workspace source checks and final installed admission are separate. Source
checks may compile against current workspace producers, while the prospective
public carrier preserves its authored held header, archive and requirement.
For Swift, the preparation export uses the same constructed roots with workspace
source/API/iOS checks; the final export additionally requires the exact installed
consumer. A Native-only change must not restamp unchanged held Swift bytes.
Changed Swift source can select Swift, but a new API requiring a newer native
base still needs explicit conventional adoption and final qualification.

WASIX source builds resolve extension archive versions from each staged product
manifest. External extensions retain independent versions; contrib follows its
actual runtime owner. Installed WASIX consumers require the exact declared
module/version contract. Resource creator provenance remains distinct from the
admitted consumer, and a runtime release does not automatically release held
compatible resource data.

Swift and React Native final staging retain their conventional requirements.
Held Swift source tags, bindings and Apple runtime archives come from the existing
authenticated completed readers. Explicitly adopted unpublished inputs require
actual matching candidate producer Files and their source-bound transport.
The Mac producer captures native/Swift inputs before the downstream React Native
consumer uses them; source checks cannot substitute for final installed proof.
Private workspace fixtures remain unpublishable.

Generated release trees resolve through `native-release-inputs.mts`, which checks
the canonical PR/Prepare identity, immutable source and exact version-only bridge.
Queue trees additionally need the matching original PR tree; a mixed queue or
synthetic title cannot bypass those checks. Publication plans use the same
verified Prepare record and its exact selected scope.

Publication derives its exact scope from the authenticated Prepare record for
the selected Release Please commit before checking product tags. Later changes
outside that candidate do not add products. Selected owners still require valid
version transitions, complete final carrier coverage and exact dependency pins.

## Qualification contract

Root publication admission accepts a current-main candidate or an explicit
ancestor source under an allowlisted current-main recovery controller. Source
qualification requires one successful, non-cancelled `Native Bazel qualification`
run whose `head_sha` is exact and whose `Required` gate succeeded. It must cover
the configured owners, mandatory tests, platform/device behavior and original
final artifacts. A successful producer job or construction audit alone is
insufficient. After the root job pins the
immutable release transport tag, the rest of that run remains bound to the
exact transaction without re-evaluating the moving main branch.

The qualified source commit owns the artifacts, lock, product tags, and
registry bytes. Ordinarily it also owns the publishing workflow. A narrowly
permitted publication-only controller fix may publish those same frozen bytes;
its workflow SHA is recorded separately and requires successful CI Required.

Publication runs on `ubuntu-24.04`, using its installed GNU timeout, Swift and
default Java 17. The Swift public probe evaluates the tagged manifest without
building Apple targets or fetching draft binary assets, so it also runs on
Linux. Apple builds and runtime tests remain in platform qualification.

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
tools/dev/bun.sh src/extensions/tools/check-extension-model.mts --check
```

For a workflow or local-action change, run the source-owned
`//tools/ci:source_checks` Bazel tests on the declared Linux profile. They use
pinned actionlint, zizmor and ShellCheck plus behavioral workflow/security tests;
actionlint alone is not equivalent. `tools/bazel/README.md` records the target/host
profiles and focused package rehearsals.

The default `release-check.sh` invocation covers product metadata and controller
mutation tests. Its `--mutation-tests-only` mode exercises release behavior,
including pinned Release Please integration, without repeating metadata gates.
Native preparation supplies authenticated supplier relationships to candidate
calculation, synchronization and verification. Publishers verify the frozen
candidate identity and live external state instead of replaying source-only tests.

The `Release` workflow has two operations:

1. `prepare-release-pr` — run from current `main`; creates or updates the generated release PR and synchronizes derived files.
2. `publish` — waits for exact-SHA qualification, prepares and freezes the candidate, bootstraps missing Cargo/npm names when necessary, publishes verified bytes, checks public consumers, and promotes GitHub drafts last.

The Prepare job requires an exact successful eligible-main Native run before
calling `prepare-release-pr.sh`. For local preparation, use an isolated clean
checkout of that qualified main source. Set `QUALIFIED_NATIVE_RUN_ID` to the
verified positive run ID, then:

```sh
export GITHUB_REPOSITORY=f0rr0/oliphaunt
export NATIVE_QUALIFICATION_RUN_ID="$QUALIFIED_NATIVE_RUN_ID"
bash tools/release/prepare-release-pr.sh /absolute/new/release-candidate
bash tools/release/close-release-candidate.sh /absolute/new/release-candidate
```

Use the shell's existing authenticated GitHub context; do not put credentials in
a candidate file. Preparation reads GitHub metadata and writes locally. Close
creates the local normalized release commit only when `required` is true.
`.github/scripts/publish-release-pr.sh` is the separate remote PR mutation.

The one-time resource migration uses actual constructor captures, not invented
history for the old resource release. At the exact captured source, the existing
proposal command is:

```sh
bash tools/release/with-source.sh HEAD bash tools/dev/bun.sh \
  tools/release/native-release-preparation.mts --seed-adoption-anchor \
  --run-id "$NATIVE_QUALIFICATION_RUN_ID" --ref "$QUALIFICATION_REF" \
  --output-directory /absolute/new/seed-adoption-proposal
```

Review the genuine 14-slot receipt/frozen/public-PGDATA join before committing
`construction-anchor.json` at `src/database-resources/seeds/construction-anchor.json`.
A successful PR source can propose that contract with its truthful source/run
identity; it does not become reviewed-main evidence. The committed declaration
and subsequent qualified source remain mandatory. Never edit the old public
metadata, fabricate its constructor intent or rerun initdb after version changes
to widen release scope. Whole hosted qualification and legacy retirement remain
separate cutover requirements.

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
If preparation recovery froze the source using a later controller, that
Release run's workflow SHA must also pass the source-to-controller allowlist;
the capsule retains its original source SHA and its new approval run ID.

If preparation failed before publication started, use `publish` on current main
with the original full `release_commit` and its successful CI
`qualification_run_id`, leaving `approval_run_id` empty. These inputs are
mutually exclusive. Recovery verifies the exact run's product coverage, required
jobs, artifacts and lifecycle evidence without searching for a substitute or
requesting CI. The controller must pass `Required` and differ only in permitted
release controls. Corrected registry preflight runs from that controller;
artifact staging, packaging and freezing run from the clean original source
checkout. The new capsule records the original CI/source identity and this
Release run's approval identity. Publication then uses the restored controller
and the existing frozen-candidate pipeline. An existing release transport tag
blocks this path: after publication starts, use frozen-candidate recovery.

Preparation is read-only and uses the existing `release-dry-run` environment.
It checks visible public releases; the publishing job repeats that preflight
with its content-write token so hidden drafts are checked before mutation.
The conditional bootstrap job uses `release-bootstrap` credentials for
wholly absent names and their required unpublished dependencies, preserves its
resumable ledger, and hands its immutable ledger artifact ID to publication.
Provision only the registry tokens required by that scope. After the initial release, configure trusted publishers for
those names and revoke bootstrap tokens before the next release.

Credential-bearing jobs directly select `release-pr`, `release-bootstrap`,
or `release-publish`. Keep secrets in those protected environments. The
Oli App's phase-scoped content-write token creates the bootstrap transport tag;
the same App owns release PRs, GitHub staging, asset uploads, attestations, and
promotion. Long asset uploads renew the App credential before its one-hour
expiry and revoke issued tokens after the lanes drain. GitHub provides each
job's read-only repository `GITHUB_TOKEN` and workflow OIDC credentials.

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

Native candidate preparation installs the locked release tooling and consumes
authenticated producer outputs. Normal publish and bootstrap install only the
verified command-line tools needed for signing, uploading and public verification. Neither path relies on Corepack. When the selected
carrier set includes npm, both normal and bootstrap jobs use
`setup-npm-publisher` to install the workflow-pinned npm archive. That action
verifies the canonical URL, compressed digests and byte count, safe archive
shape, executable modes, and complete extracted-tree digest before exporting
the CLI. It then compares the observed npm version exactly and validates the
observed Node/npm trusted-publishing runtime plus the command-specific
`npm trust list` and `npm trust github` help contract used by maintainer
configuration. This local tool setup neither requests an OIDC token nor changes
the frozen registry mutation logic.

Installer and transport fault-injection suites belong to source-owned Bazel
policy tests and the release controller suites. Publication does not rerun them.
Candidate freezing authenticates the exact-source Native record, final outputs
and Prepare bridge; slim publishers do not replay source-only qualification.
For local read-only validation, run `bash tools/release/release-check.sh` for
source metadata and release-tool tests. Check selected public version state with
`bash tools/release/release-check-registries.sh --products-json '["oliphaunt-js"]' --head-ref HEAD`
(replace the example selection with the actual products). Neither command
assembles release packages; the retired dry-run wrapper did not assemble them
either. Use the selected owners' actual Bazel package and consumer tests for local
rehearsal.

Release admission checks consumer combinations before uploading registry bytes.
Native CI verifies the canonical prepared source and conventional requirement
transition before qualifying generated release trees. Candidate admission then
checks the selected final delivery against unchanged immutable dependencies;
ordinary source checks do not substitute for that final contract.
`consumer-compatibility.mts` reads selected consumers' declared pins and reads
unselected dependencies from their immutable product tags. It compares the WASIX
SDK runtime with the runtime embedded by its exact N-API dependency, follows
declared SDK dependencies through tools and React Native, checks consumers'
own runtime pins against those SDKs. Installed consumers then resolve the frozen
root package's conventional manifest requirements and verify its artifact bytes.
Native extension execution uses the exact host declared by the package.
Unrelated historical extensions do not gate a new SDK release. A workspace `qualificationOnly`
fixture cannot satisfy these release contracts. A new runtime SDK must declare
its extension compatibility policy before metadata admission.

Cargo extension facades use compatible SemVer requirements for SDK, build-helper
and binding APIs; extension payload and AOT carrier versions remain exact.
Each owner's Bazel package construction consumes the shared facade generator.
When its delivered output changes, native comparison selects the affected
external extension or runtime contrib owner before Release Please versions it. WASIX tools declare
their SDK pin explicitly instead of deriving it from the current workspace SDK.
These rules preserve independent packaging versions; they do not establish
cross-runtime extension compatibility or waive ABI, AOT, export or integrity
checks. Incompatible combinations require a fresh matching release candidate.

Freezing the publication candidate additionally checks the unmodified WASIX SDK
tarball's declared pins and every selected N-API tarball, including macOS carriers
on a Linux preparation host. Packing and atomically installing a frozen candidate
repeat that check, so approval-run reuse and bootstrap retries cannot bypass it.
The post-publication npm check validates the actual
installed carrier for every installed WASIX SDK, including unselected historical
SDKs and nested dependency installations. Source qualification and installed
release compatibility remain separate requirements.

For a candidate failure, retain the exact source, Native run, Prepare record and
original artifact identities. Use the same `native-freeze-publication-candidate.mts`
entrypoint and arguments as Release's “Freeze authenticated native publication
outputs” step in an isolated checkout. This reuses the actual producer Files;
it does not substitute a local compiler build or the old carrier assembly path.
Use the complete selected scope when diagnosing missing or extra final carriers.
A construction diagnostic is not an admitted publication lock, and changed
production code requires fresh source qualification.

Candidate preparation verifies its exact-SHA qualification record once and
performs registry preflight once. Immediately before assembly,
`qualified-release-replay.sh` still rejects source modifications, suppressed
index entries and a mismatched checkout SHA. This source check runs locally as
well as in GitHub Actions. Publication rechecks live registry state at its
mutation boundary, where a race can still change the result.

Preparation normally binds `release_commit` to the workflow commit. For
`publish` with `approval_run_id` or `qualification_run_id`, it may instead
identify an exact ancestor candidate after narrowly permitted release-control
fixes. The controller
check requires a clean checkout and rejects changes to product source,
packagers, build definitions, CI, and lockfiles. The publishing commit requires
successful CI `Required`; the frozen candidate retains its original full
qualification, approval run, source SHA/tree, and package hashes. GitHub
attestations verify the actual publishing workflow SHA and record it separately
from the candidate source. Frozen-candidate recovery replays no build or
packaging command; pre-publication qualification recovery assembles once from
the original source and never rebuilds producers.

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
the still-absent names and their required unpublished dependencies. Already-public versions are excluded from that new
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
edges and includes the required unpublished versions of existing package names
before creating their new dependents. Unrelated existing names and optional npm
dependencies on existing names stay on normal trusted publication. Bootstrap
executes one sequential lane per registry, overlapping only
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
In parallel clean temporary homes/caches it resolves each Cargo consumer entry
in an independent scratch manifest without compiling payloads, installs each
npm dependency root in an independent project with default peer installation,
resolves each Maven entry in an isolated Gradle configuration without an Android
build, and anonymously fetches every product tag. Facades, plugins, resources
and tool facades are independent entries even when another package depends on them; remaining dependency roots
are also probed. Each lane requires the combined resolver lock graphs to cover
every frozen carrier; a missing carrier cannot be silently relabelled as
receipt-only. Cargo enables each entry's public features and respects the
features that entry requests from its dependencies, so an individual Cargo
resolution may omit transitive opt-ins exercised by another entry. npm and Maven
entries require their complete requirement-compatible frozen dependency closures;
an older authored dependency stays a separate public input. It never invents one
all-platform consumer graph.
Required npm peers are installed so the SDK/N-API compatibility check validates
the same dependency tree a normal clean install receives, including historical
SDK peers outside the selected publication lock.
Evidence separately identifies npm carriers not installed on the publication host
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
publish job runs on Linux, so npm's `installedCarrierIds` proves only the host
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
pre-mutation and final receipts without consuming an uploader lane. Every core
REST attempt, including retries and the API call
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

Native Linux construction uses the declared Bazel target/host toolchains,
including the GNU 2.28 profiles. Those construction profiles do not change the
published compatibility ceilings above. Inspect the actual ELF dependencies and
symbol versions of every final carrier, and run its installed consumer on the
required host. Do not link release outputs against arbitrary workstation or
runner-image libraries or restore the former Cargo/Docker producer path as an
alternative authority.

Every release-ready exact extension has stable ecosystem façades. PostgreSQL
contrib carriers belong to the matching native or WASIX runtime product; each
active external extension owns its independent product. The global extension
target-profile contract applies to every public SQL member and is checked
against the runtime target matrix.

## Frozen consumer readiness

The publication path is: exact-source Native `Required`, authenticated final outputs, exhaustive
publication lock and candidate capsule, `Frozen consumers` on the required hosts,
`Publication ready`, then bootstrap and normal publication. Both protected jobs
require the ready gate. Every supported mutation entry point also checks the
proof, including transport refs, release drafts, asset uploads, Swift pushes and
the direct frozen npm upload helper. Preparation and read-only registry inventory
do not require proof.

The consumer plan is derived from the frozen carrier identities, canonical target
contracts and product-owned fixtures. Consumers install an exact public entry
into a disposable external project. npm uses a GET-only loopback registry with
the complete packaged manifest and exact frozen tarball; historical versions
remain read-only public inputs. No overrides or extra transitive root requirements
replace authored pins. Cargo uses a clean home and lockfile with root
`[patch.crates-io]` entries pointing to safely extracted frozen crates. This is
explicit staging evidence, not crates.io provenance. Maven resolves unchanged
primary files from an isolated repository; protected signing remains the
publication envelope. Swift verifies canonical URLs and checksums before
localizing a disposable manifest. The frozen manifest is unchanged. React Native
has separate Android and iOS application builds, and Android SDK cases exercise
the actual Gradle plugin and packaged AAR public API.
Archive-only WASIX postmaster cases extract the frozen release and initialize a
cluster through its shipped launcher; their recorded level is `initialize-cluster`.

The case plan also selects toolchain setup. A query-only npm lane does not install
Rust or Android tooling. Node, Bun and Deno share one fresh SDK installation per
host and execute separately with fresh runtime data directories; browser projects
remain separate. Kotlin's AAR, plugin and marker share the same application build,
with each carrier's coordinates and primary bytes checked against its result.
Cargo and Maven staging happen once when needed, and npm downloads and historical
packuments share a fresh job-local cache. Cargo staging retains other target
crates because its lockfile resolver includes dependencies for all platforms.

Case results record resolved identities and checksums, execution level, resolver digest, toolchain, producing
run/attempt and log reference. Installation and compile/link checks are identified
as such. Missing, failed, skipped, duplicate or unexpected cases fail aggregation.
`oliphaunt-publication-consumer-proof` binds the complete case plan, test
configuration and publication lock. Mutation admission compares local proof bytes
to the immutable GitHub artifact, validates the canonical main Release workflow
and checks readiness and consumer jobs in their actual producing attempts.

An `approval_run_id` imports a successfully prepared capsule even if its old
consumer proof is absent or failed. Current consumer jobs run again over the same
bytes and produce current readiness. Test or controller fixes never require
rebuilding a frozen payload merely to obtain new proof. Postpublication anonymous
consumer verification and immutable registry reconciliation remain required.

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

If no publication transaction has started and preparation never produced a
usable frozen candidate, use the original source SHA and successful CI
`qualification_run_id` instead. The same controller restrictions apply; registry
preflight and exact-source qualification verification run again before the
original packaging code creates the candidate. Do not use this path to refreeze
a partially published release.

Ordinary clean-state control-plane workflow, policy, validator,
registry-transport, test, or documentation changes do not use recovery and do
not create a release. With no other unreleased product change,
`prepare-release-pr` reports no releasable products and creates no PR; a direct
publish selects no release changes and performs no registry work. A compiler, SDK, linker, recipe, source-selection or target change requires
qualification of its affected construction. Delivered payload changes select
necessary owners before Release Please calculates versions; an unchanged
qualified delivery does not release merely because a recipe or comment changed.

## Handoff evidence

Record the candidate SHA/tree, exact CI run, selected product versions,
catalog/lock digests, artifact attestations, registry bootstrap/trust status,
publication receipts, promoted release URLs, and clean-install results. “The
workflow passed” is not sufficient release evidence without those identities.
