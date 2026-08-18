# Release setup

Status: normative external-setup guide. Last verified: 2026-07-30. Owner: repository maintainers.

This document covers state that cannot live in the repository. The executable
contract is the direct least-privilege workflow in
`.github/workflows/release.yml` and
`tools/release/check_publish_environment.mjs`; update this guide when either
changes.

## GitHub controls

Protect `main` before the first public release:

- require pull requests and the repository's aggregate `Required` check;
- allow squash merges only and require linear history;
- enforce the rules for administrators, and block force-push and deletion;
- require conversations to be resolved and dismiss stale approvals;
- require at least one independent approval in team governance, but set the
  approval count to zero when the repository has only one collaborator so a
  self-authored generated release PR remains mergeable;
- do not enable `cancel-in-progress` for main qualification or release workflows.

`Required` is the branch merge gate. After a merge, the non-cancelled CI run on
the resulting `main` commit must also produce the exact-SHA `Qualified` record;
that record is publication evidence, not a pull-request branch-protection check.

Create these environments:

| Environment | Purpose | Secrets | Protection |
| --- | --- | --- | --- |
| `release-pr` | Create/update the generated release PR | `RELEASE_PR_TOKEN` | main only |
| `release-dry-run` | Exact-SHA artifact assembly and dry-run | none | main only |
| `release-bootstrap` | Creation of npm/crates identities that do not exist yet | Only the short-lived, registry-scoped `CRATES_IO_BOOTSTRAP_TOKEN` and/or `NPM_BOOTSTRAP_TOKEN` required by the approved lock | `main` for a root dispatch and `oliphaunt-release-transport/*` tags for verified continuations; independent approval when available |
| `release-publish` | Normal trusted publication | Maven Central credentials and signing key | `main` only; independent approval when available |

Use a GitHub App or narrowly scoped bot token for `RELEASE_PR_TOKEN`; PRs created by the default workflow token do not trigger the normal PR workflow. Keep bootstrap tokens out of repository secrets and out of `release-publish`. Delete/revoke them immediately after trusted publishers are configured.

Use exact custom deployment branch/tag policies. `release-pr` and
`release-dry-run` and `release-publish` allow only the `main` branch.
`release-bootstrap` also allows tags matching
`oliphaunt-release-transport/*` for its verified continuations; no other branch
or tag is allowed. The workflow accepts that tag namespace only when the suffix
is the full exact release SHA, the tag points directly to that commit, and the
sealed bootstrap-continuation pointer agrees. A transport tag is never updated
or deleted.
Environment approval is optional for dry-run and recommended for the
irreversible bootstrap and publish operations when a second maintainer is
available. In that case, require the independent reviewer and prevent
self-review. A solo-maintained repository must leave self-review prevention
disabled so publication remains possible; manual root dispatch plus exact-SHA
qualification, the root-admitted immutable transport boundary, and the frozen
lock are the viable solo controls.

Actions must allow OIDC and artifact attestations. Normal Cargo publication's
in-process broker follows crates.io's documented OIDC exchange and revocation
protocol: it requests audience `crates.io`, exchanges the GitHub JWT for a
30-minute registry token, masks it before use, starts at most 20 carriers and
no work after 20 minutes on that token, and revokes it in `finally`. A fresh
batch receives a fresh token; `id-token: write` alone does not authorize a
registry upload. The frozen Cargo uploader sends the lock-matching `.crate`
through crates.io's Registry Web API instead of asking `cargo publish` to
repackage it.

Bootstrap's OIDC permission is only for npm provenance on the
token-authenticated first publish; it is not npm or crates.io trusted-publisher
authorization. After package identities and their external publisher settings
exist, normal Cargo/npm publication uses the `release-publish` environment and
short-lived OIDC credentials without bootstrap tokens.

### Trusted-publisher identity through the direct workflow

Cargo and npm publication jobs run directly in `.github/workflows/release.yml`.
Their GitHub OIDC identity therefore contains that exact file in
`workflow_ref`, its exact commit in `workflow_sha`, and the protected
`release-publish` environment claim. GitHub may also emit `job_workflow_ref`
as an optional current-job alias, with or without `job_workflow_sha`. The ref
must exactly equal the canonical `workflow_ref`; a present SHA alias is
accepted only alongside that exact ref and must equal `workflow_sha`. This
rejects a distinct called reusable-workflow identity without requiring the SHA
alias to accompany every ref alias. Repository policy also forbids delegated
operation jobs and `workflow_call`. The workflow performs a read-only
live-token check of the repository, workflow, ref, SHA, hosted runner, event,
and environment claims before either mutating operation.

| Registry | Exact external configuration | Ref binding |
| --- | --- | --- |
| crates.io | owner `f0rr0`, repository `oliphaunt`, workflow filename `release.yml`, environment `release-publish` | Normal publication is a root `main` dispatch |
| npm | owner `f0rr0`, repository `oliphaunt`, workflow filename `release.yml`, environment `release-publish`, allowed action `npm publish` | Normal publication is a root `main` dispatch |

This identity follows GitHub's [OIDC claim
reference](https://docs.github.com/en/actions/reference/security/oidc), the
[crates.io trusted-publishing setup](https://crates.io/docs/trusted-publishing),
and npm's [trusted-publisher fields](https://docs.npmjs.com/trusted-publishers/).
Registry settings are external state: the OIDC preflight proves what GitHub
emits, not what a registry operator entered. Audit the table after bootstrap.
The crates.io exchange then proves its matching configuration before normal
registry mutation; npm has no non-publishing trusted-auth probe, so its package
settings must be checked directly.

Use the exact publication lock to manage that external state; never maintain a
second handwritten package list. This command validates the lock against the
checked-out catalog and prints a plan without credentials, network access, or
mutation:

```sh
lock=target/release/publication-lock.json
tools/dev/bun.sh tools/release/trusted-publisher-config.mjs --lock "$lock"
```

Authenticated `--audit` remains read-only. Mutation exists only behind the
literal `--apply` flag *and* an exact `--confirm-lock-digest`; the tool first
audits the entire selected batch, refuses every mutation if it finds a wrong or
extra configuration, creates only missing configurations, and re-audits after
creation. It never revokes or replaces a registry configuration. A failed or
expired-auth run is resumable by rerunning the same lock and batch: exact
configurations are skipped, while conflicts still fail closed.

Each credential-bearing job directly selects exactly one protected environment:
`release-pr`, `release-bootstrap`, or `release-publish`. Keep the named secrets
only in those environments; do not add repository-level duplicates or a
reusable-workflow secret bridge. GitHub automatically provides the scoped
`GITHUB_TOKEN`. Every job declares its own effective permissions: dry-run is
read-only, bootstrap adds OIDC for npm provenance and `contents: write`,
preparation gets release-PR writes, and normal publish runs in one direct job
with the `release-publish` grants. Bootstrap's
content write is solely for the root generation to create the immutable
release transport tag immediately before its first registry mutation;
continuation generations do not create, move, or delete repository refs.
Dry-run and publish share one YAML-anchored step list but remain separate
permission and environment boundaries.
The read-only dry-run validates every public release visible to its token and
every selected product tag. `publish` uses its content-write token to require
the complete live draft/public release set before mutation. A hidden draft is
therefore never misclassified as absent proof, and dry-run does not gain write
capability merely to list drafts.

The bootstrap continuation DAG does not widen those boundaries.
`dispatch-bootstrap-continuation` consumes only outputs from
`publish-bootstrap`. It is environment-free and secret-free, with Actions
write only for the bounded exact-child dispatch and repository read for its
transport checkout. It verifies and dispatches the exact
`oliphaunt-release-transport/<full-sha>` tag created by the root generation; the
child validates that tag, exact SHA, and parent authorization instead of
resolving current `main`. Normal publish has no continuation dispatcher.

Audit the live controls without changing them:

```sh
tools/dev/bun.sh tools/release/audit-github-release-controls.mjs \
  --governance solo \
  --bootstrap-state idle
```

Use `--governance team` only when an independent maintainer is actually
available. Bootstrap state is an explicit credential lifecycle, not an
authorization shortcut:

- `idle` is the default before first-identity bootstrap, including
  qualification, release-PR preparation, and dry-run; it requires both
  bootstrap tokens to be absent;
- `ready` is valid only after every reviewed short-lived Cargo/npm token
  required by the approved lock has been installed for an imminent
  `publish-bootstrap` dispatch; it accepts either registry token or both, and
  requires at least one. Provision only the registries whose exact locked
  identities remain absent. A recovery in which every selected Cargo/npm
  version already matches stays `idle` and requires neither token; and
- `retired` is valid only after bootstrap sealed, trusted publishers were
  configured, and both tokens were revoked and removed; it also requires the
  token names to be absent.

The `publish-bootstrap` workflow independently derives the registries required
by the approved lock and rejects each missing credential immediately before
mutation, so an `idle` audit cannot authorize bootstrap publication. The
auditor reads the canonical repository through `gh api`, prints deterministic
`PASS`/`WARN`/`FAIL` findings, and exits nonzero only for hard release-safety
findings (usage, authentication, or API errors exit `2`). It reads environment
secret names, never values; the authenticated account therefore needs
permission to inspect repository and environment settings. Warnings cover
optional team governance and repository hygiene and do not block a solo
release.

## Registry ownership

The publication catalog defines stable carrier topology; the frozen publication lock is the exhaustive candidate identity inventory, including generated payload parts. Generate/query them rather than maintaining a package list in this document. Bootstrap accepts exactly two registry states: the locked first version is already public with lock-matching bytes (a recovery skip), or the package name is wholly absent (a first-version mutation). An existing name without the locked exact version is a hard blocker and must use a later normal release; it is never treated as bootstrap work. A resumed run reconciles and checkpoints every matching public version, then invokes publishers only for names that remain absent. A conflicting public identity is a blocker, not a reason to rename an artifact silently.

### crates.io

1. Create the maintainer account/team.
2. Inventory the exact first-release lock. Crates.io's documented per-user new-name limit is a burst of 5 followed by one new crate every 10 minutes. Do not copy a carrier count from this document: the publication catalog is the stable identity model, while oversized payloads add generated `*-part-NNN` carriers only when the candidate artifacts and publication lock are assembled. For `C` missing Cargo names, the untouched-default rate-limit floor is `max(0, C - 5) * 10 minutes`. Crates.io support may grant exceptional capacity, but no API exposes that account state, so the workflow never treats an operator-entered number as proof. A valid `429 Retry-After` response and the next read-only registry inventory are authoritative.
3. Use the protected `publish-bootstrap` operation for only the missing first versions. The prior dry-run must have emitted one approved lock and its manifest-bound Cargo/npm capsule in the same workflow run. The slim bootstrap job verifies and atomically installs those exact bytes; it does not rebuild them. Before initializing its ledger or sending any npm/Cargo mutation, the workflow queries crates.io read-only and reports exact selected/existing/missing counts and the official-default duration floor. It admits only a dependency-closed batch that fits the bounded job window. Independent Cargo and npm mutations overlap; each registry remains strictly sequential, and a cross-registry dependency remains a barrier.

   When the exact lock cannot finish in one six-hour hosted job, successful
   partial progress is not a failure and does not require a maintainer rerun.
   The job flushes its content-addressed checkpoint, uploads it, and a separate
   credential-free job dispatches the next `release.yml` run for the same
   release commit. The continuation carries the exact parent artifact ID,
   digest, size, checkpoint identity, and bounded generation. It must prove at
   least one new receipt before another continuation is allowed. A timeout,
   ambiguous upload, integrity conflict, malformed retry response, or
   checkpoint failure remains a hard failure.

   Bootstrap's protected `release-bootstrap` environment may increase, but
   never decrease, four calibrated admission variables: 30 seconds per missing
   Cargo name (`REGISTRY_BOOTSTRAP_CARGO_SECONDS_PER_CARRIER`), 30 seconds per
   missing npm name (`REGISTRY_BOOTSTRAP_NPM_SECONDS_PER_CARRIER`), 6 seconds
   per already-public version reconciled at fixed concurrency eight
   (`REGISTRY_BOOTSTRAP_RECONCILIATION_SECONDS_PER_CARRIER`), and a 600-second
   non-publication reserve (`REGISTRY_BOOTSTRAP_RESERVE_SECONDS`). Leave them
   unset to use these defaults. Increase a value only from measured registry or
   runner evidence; the parser rejects smaller values so an operator cannot
   make a workload appear to fit by weakening the admission model. For `C`
   missing Cargo names and `N` missing npm names, the basic aggregate
   estimate is `30*C + 30*N` seconds and the independent-lane lower bound is
   `max(30*C, 30*N)` seconds before reserve and dependency barriers. These
   formulas are explanatory, not admission evidence: the gate recomputes the
   exact dependency-DAG critical path from the frozen lock, including every
   generated Cargo part carrier.

   These values are not upper bounds on third-party latency. A Cargo carrier
   can use up to twelve visibility probes separated by ten-second waits, and an
   npm carrier has its own bounded publish and visibility loops; either can
   exceed the 30-second estimate. The absolute registry/job deadline is the
   hard bound. Completed carrier IDs are reconciled and appended through one
   serialized checkpoint writer in canonical order. If either lane fails, no
   new mutation starts after the shared abort, the peer's one in-flight
   immutable operation drains, and a final checkpoint attempt covers every
   successful operation. An exact-lock rerun inventories and byte-proves public
   partial mutations, including an ambiguous upload accepted before failure,
   without blindly repeating that immutable upload.
4. Give the revocable scoped API token the `publish-new` and `trusted-publishing` endpoint scopes and only the `oliphaunt*` and `liboliphaunt*` crate scopes. After bootstrap seals, expose that same bootstrap token to the local process as `CRATES_IO_TRUST_CONFIG_TOKEN`, then run the lock-derived read-only audit and explicit apply below. The crates.io API is queried per exact crate; any wrong or additional configuration blocks the whole apply before it creates another one.

   ```sh
   lock=target/release/publication-lock.json
   digest="$(jq -er .lockDigest "$lock")"
   tools/dev/bun.sh tools/release/trusted-publisher-config.mjs \
     --audit --ecosystem cargo --lock "$lock"
   tools/dev/bun.sh tools/release/trusted-publisher-config.mjs \
     --apply --confirm-lock-digest "$digest" --ecosystem cargo --lock "$lock"
   ```

   The first audit exits `1` while configurations are missing; that is an
   expected read-only finding, not permission to weaken the apply guard. Run it
   once more after apply and retain its zero-missing, zero-conflict JSON report
   with the release evidence. `CRATES_IO_TRUST_CONFIG_TOKEN` is only the local
   process alias for the already-protected bootstrap token: do not duplicate it
   as another GitHub secret or put its value in a file, command argument, log,
   or shell history.
5. Revoke `CRATES_IO_BOOTSTRAP_TOKEN` and remove it from `release-bootstrap`.
6. Run normal `publish`; its bounded in-process broker must acquire, mask, use,
   and revoke fresh OIDC-exchanged tokens for at most 20 Cargo carriers and 20
   minutes per batch.

Crates.io returns `429` with an HTTP-date `Retry-After` when a publish bucket is
empty. The frozen publisher retries only that explicit non-mutating rejection,
using the exact same locked bytes and only while the bounded mutation deadline
can accommodate the server delay. Ambiguous transport and other server errors
are never blindly replayed: registry state is checked, matching bytes resume,
and the maintainer uses GitHub's rerun on the original Release run.

Normal publication does not predict registry capacity or deliberately admit a
partial batch. It inventories every exact `name@version`, rejects missing names
that require bootstrap, and attempts the complete dependency-ordered plan once
inside the job deadline. A rerun byte-proves matching public versions and
publishes only those still absent.
Trusted-publishing credentials are also bounded: crates.io issues each token
for 30 minutes, so the Cargo executor refreshes and revokes tokens in batches
well inside that lifetime rather than retaining the workflow's first token.
Every OIDC, token-exchange, and revoke request is clamped to the shared registry
deadline. A batch cannot acquire a token unless two bounded exchanges plus the
mandatory revoke budget remain, and publication receives a deadline that
excludes that revoke budget even when a carrier fails.

Generated Cargo `*-part-NNN` crates are allowed only when a `.crate` would
exceed crates.io's package-size limit. They are carriers in the frozen lock,
publish before their aggregator, and are not independent release products.

### npm

1. Create/claim the `@oliphaunt` scope and require public access/provenance in package metadata.
2. Bootstrap only identities whose settings page cannot exist before a first
   publish. Immediately before that run, create `NPM_BOOTSTRAP_TOKEN` as a
   short-lived **granular access token** owned by an actor whose npm account has
   2FA enabled and write access to `@oliphaunt`. Its package/scopes permission
   must be **Read and write**, its selected scope must explicitly include
   `@oliphaunt`, and **Bypass two-factor authentication** must be enabled.
   Limit its lifetime to the bootstrap window, store it only in the
   `release-bootstrap` environment, and revoke it as soon as the identity chain
   seals. An ordinary token, a read-only token, an organization-only grant, or
   a granular token without 2FA bypass may authenticate successfully but will
   fail the noninteractive first publish with `EOTP`; do not discover that
   distinction through a sacrificial package mutation.
3. For this operator-side configuration step, use npm CLI 11.15.0 or newer and
   an npm authentication method supported by `npm trust`; the account must have
   2FA and every package must already exist. The release workflow separately
   installs and verifies its exact `NPM_VERSION` through
   `setup-npm-publisher`; do not substitute the operator's ambient CLI for that
   workflow pin.
   The setup helper retains npm's documented two-second spacing and divides the
   exact lock into deterministic batches of 25, leaving room inside each
   five-minute 2FA skip window for pre-audit, creation, and post-audit. For each
   `npmBatches[].number` printed by the no-network plan, run the read-only audit
   and then the explicit apply:

   ```sh
   lock=target/release/publication-lock.json
   digest="$(jq -er .lockDigest "$lock")"
   tools/dev/bun.sh tools/release/trusted-publisher-config.mjs \
     --audit --ecosystem npm --batch 1 --lock "$lock" \
     --output target/release/npm-trust-batch-1-pre-audit.json
   tools/dev/bun.sh tools/release/trusted-publisher-config.mjs \
     --apply --confirm-lock-digest "$digest" \
     --ecosystem npm --batch 1 --lock "$lock" \
     --output target/release/npm-trust-batch-1-apply.json
   ```

   Repeat with the next batch number, completing npm's 2FA prompt when a new
   window is needed. The first audit exits `1` for missing configurations; its
   JSON is still the required pre-mutation inventory. Every exact package receives repository
   `f0rr0/oliphaunt`, workflow `release.yml`, environment
   `release-publish`, and only `npm publish`; staged publishing is never
   authorized. After all batches, rerun `--audit` for every batch and retain
   the zero-missing, zero-conflict reports.

   Run every npm `--audit` and `--apply` command directly in an interactive
   terminal. npm can require web or classic OTP even for `npm trust list`.
   Before the initial and final classification passes, the helper therefore
   runs one read-only list with inherited terminal streams and discards that
   display, then performs separate bounded captured reads as evidence. If that
   authentication window expires during a batch, an `EOTP` captured read gets
   exactly one more read-only warm-up and one captured retry; no other failure
   is retried. Every successful warm-up is followed by the same bounded
   two-second management-request spacing as ordinary list/create requests.
   Each interactive warm-up or mutation has a five-minute process deadline.
   Select npm's five-minute authentication window when prompted. Do not pipe
   or redirect npm audit/apply commands. `--output` atomically creates the
   machine-readable mode-`0600` report and refuses to overwrite an earlier
   report, so use a new output name for every final re-audit.
4. Revoke `NPM_BOOTSTRAP_TOKEN`; normal publishing uses npm trusted publishing and no `NODE_AUTH_TOKEN`.

Target-specific npm packages are intentional carriers. Routine payload-splitting packages are forbidden; an npm tarball contains the target payload directly and stays within the registry's documented limits.

### Maven Central

Verify in Central Portal that `dev.oliphaunt` is visibly **Verified** for the
account represented by the portal token. This is a one-time external control:
the documented Publisher API has no read-only namespace-status endpoint, so an
empty deployment listing must not be represented as proof of namespace
verification. Store the portal username/password and in-memory GPG
key/id/passphrase only in `release-publish`. Before any mutation, the normal
workflow authenticates against the read-only deployment endpoint, binds its
query to `dev.oliphaunt`, and rejects catalog groups outside that namespace. It
also imports the key into an isolated temporary GPG home, signs fixed preflight
bytes with the configured key and passphrase, requires the signature to use the
primary key rather than an incompatible signing subkey, verifies the detached
signature and fingerprint, confirms that exact primary fingerprint is
retrievable from at least one Central-supported keyserver, deletes the
temporary keyring, and repeats that proof immediately before mutation. The
normal publish job also constructs the complete
lock-selected Central bundle without upload and requires Central metadata,
exact primary/sources/javadoc files, nonempty payloads, signatures, checksums,
safe paths, and a total archive size strictly below 1 GB. Placeholder
sources/javadoc JARs are deterministic and intentional for binary carrier
coordinates. `MAVEN_GPG_KEY_ID` must be an 8-64 character hexadecimal
primary-key ID or fingerprint, with an optional `0x` prefix. Publish the public
primary key to `keyserver.ubuntu.com`, `keys.openpgp.org`, or `pgp.mit.edu`
before release. Publish the identities declared by the catalog: the Android
AAR, Gradle plugin and marker, runtime/extension ABI carriers. Do not publish an
undeclared Kotlin Multiplatform/JVM root module.

### SwiftPM and GitHub Releases

Product tags use `<product>-v<version>`. SwiftPM additionally consumes an unscoped semantic tag; because legacy unscoped tags occupy versions through `0.5.1`, the first Oliphaunt Swift version is `0.6.0`.

Release Please owns product versions, changelogs, and the generated release PR.
On the normal single-identity path, the root protected publish job first reads
`oliphaunt-release-transport/<full-sha>`. When it is absent, or the job is on
its first run attempt, the helper validates current `main` before creating or
accepting the exact direct-commit tag. Only a genuine GitHub rerun
(`GITHUB_RUN_ATTEMPT > 1`) of the exact root operation, original
`refs/heads/main` workflow SHA may reuse an already
exact tag after `main` advances; a missing, wrong, or annotated tag cannot use
that exception. The job then stages each selected product tag and draft GitHub
release directly at the qualified SHA. Before
staging, the lock-derived SwiftPM preflight creates no semantic tag and performs
no push: it accepts only an absent semantic tag or an existing tag that resolves
to the exact deterministic manifest commit for this release. Any conflicting
or ambiguous remote tag fails before the first mutation. The release transport
tag itself is immutable and is never updated or deleted.
The workflow then uploads checksum-covered assets, completes registries, runs
the receipt-bound anonymous public-consumer probes, preserves their immutable
evidence, and promotes drafts. A failed publish must leave drafts unpromoted.
The Swift probe can resolve the public source tag and evaluate its manifest at
this point; draft binary-target assets are not anonymously public until
promotion and remain covered by the exact GitHub asset/attestation receipt.

## First release sequence

1. Confirm selected registry identities and product tags do not conflict.
2. Merge the introduction tree through the qualified path. Its parent must be
   the full `bootstrap-sha` boundary recorded in `release-please-config.json`,
   so legacy release commits are excluded from the first product releases. Do
   not rewrite history after any affected identity is public. A defect creates
   a new ordinary candidate and requires fresh qualification.
3. Run `prepare-release-pr` from current `main`; review the single generated release-bump commit.
   A large Release Please update may arrive internally as multiple transport
   chunks; the prepare job validates and collapses the exact canonical PR tree
   to this single commit before it is reviewable or mergeable. The prepare job
   must also converge all derived pins, locks, compatibility values, and
   evidence, then validate their exact Git blobs before pushing the normalized
   head. A raw Release Please head is never
   mergeable merely because its direct versions and changelogs look complete.
4. Merge it and wait for that exact commit's non-cancelled `Qualified` CI run.
5. Run `publish-dry-run`. It must download that run's artifacts, create/freeze the publication lock, create the deterministic lock-bound Cargo/npm bootstrap capsule, and perform clean package/install checks without credentials. Preserve the successful run ID that contains both approval artifacts.
6. If npm/crates first identities are missing, run `publish-bootstrap`. It selects one same-SHA dry-run containing both the lock and capsule and verifies their byte binding. Before any registry identity becomes public, it resolves the exact merged Release Please PR by the release SHA, requires pending or already-tagged lifecycle state, and proves the tagged label still exists. At the mutation boundary it uses the exact root transport rule above; an absent tag is its first mutation and requires the immediately preceding current-main proof. A genuine exact rerun may reuse only the direct-commit tag created by its earlier attempt. It then installs the capsule without rebuilding, writes a genesis checkpoint before the first registry mutation, and appends immutable byte receipts throughout the run. An incomplete but progressing job uploads the chain and self-dispatches the next bounded generation at that exact tag; the child restores only the exact parent artifact ID/digest/size and validates the tag, SHA, and continuation contract before resuming. It does not reconsult moving `main`. Manual recovery can inventory compatible same-SHA evidence, but an automatic child never selects a mutable “latest” artifact. After the chain seals, use the exact lock's `trusted-publisher-config.mjs` plan, audit, and explicit apply flow above; retain the final reports and revoke the bootstrap tokens. Bootstrap does not promote GitHub releases or publish unrelated registries.
7. Run normal `publish` on the same current `main` SHA. Before the first
   mutation it repeats the exact Release Please markability assertion and pins
   the immutable transport tag. One protected job stages GitHub releases,
   attempts the complete dependency-ordered registry plan, runs public
   Cargo/npm/Maven and Git/Swift probes from fresh anonymous caches, and
   promotes drafts last. It has no normal checkpoint, continuation, or phase
   handoff. If it stops, use GitHub's rerun on the original Release run;
   matching immutable state is byte-verified and skipped. The final label updates add
   `autorelease: tagged` and remove `autorelease: pending` without replacing
   unrelated labels.
8. Preserve the publication lock, ledger, provenance, and workflow URL with the release.

The first generated release PR consumes the one-time `bootstrap-sha` boundary.
`sync-release-pr.mjs` removes it on that PR once any manifest entry advances
from `0.0.0`; the release-bump commit must contain that removal. Never delete
the boundary on the unreleased introduction tree. Never restore it on a
publishable release-bump tree.

On the normal single-identity path, `release_commit` is only an equality
assertion for the workflow commit; it cannot select an older commit and the
workflow ref must be `main`. A bootstrap continuation uses
`oliphaunt-release-transport/<release_commit>`. Release tooling fixes create a
new candidate SHA and require new qualification. There is no temporary Release
Please target branch, and a later commit cannot finish the release.

## Recovery

Publishing is not cross-registry atomic. On normal-publish failure, preserve
the lock and responses, inventory all selected identities, and use GitHub's
rerun on the original Release run at the exact same commit. Matching immutable
versions may be skipped only after registry bytes are proved; a mismatch stops
the release. Only first-identity bootstrap restores a content-addressed
checkpoint chain. Product changes require a new version and exact-SHA
qualification.

Normal recovery reruns `publish` at the exact same release commit with the same
qualified artifacts and approved lock. Use GitHub's rerun for the failed
Release run rather than a fresh dispatch after `main` moves. The original run
and referenced CI/dry-run artifacts must still be available. The rerun
byte-verifies public registry and GitHub state, skips exact matches, and writes
only missing state. A required fix creates a new candidate and requires normal
versioning and qualification. First-identity bootstrap alone restores its checkpoint chain. See
`.codex/skills/release-oliphaunt/references/recovery.md` for recovery.

## External readiness checklist

- the read-only GitHub controls audit has no `FAIL` findings for the applicable
  solo/team governance and `idle`, `ready`, or `retired` bootstrap lifecycle;
- main requires `Required`, squash-only merges, linear history, resolved
  conversations, stale-approval dismissal, administrator enforcement, and no
  force-push or deletion;
- `release-pr`, `release-dry-run`, and `release-publish` admit only the `main`
  branch; `release-bootstrap` additionally admits the
  `oliphaunt-release-transport/*` tag pattern required for exact verified
  bootstrap continuations; bootstrap and publish use independent approval and
  prevent-self-review when a second maintainer exists, while solo operation
  keeps self-review prevention disabled;
- `release-pr` can create a PR that triggers normal CI;
- dry-run has no write credentials;
- bootstrap tokens are absent unless a reviewed first-identity run is imminent;
- every Cargo and npm identity uses workflow `release.yml` and environment
  `release-publish`, npm
  allows `npm publish`, and neither registry is expected to bind a branch;
- the exact-lock trusted-publisher audit reports every selected Cargo/npm
  identity exact, with zero missing and zero conflicting/extra configurations;
- Central Portal visibly marks `dev.oliphaunt` Verified, the deployment API
  credentials authenticate, and the primary signing key preflight validates;
- registry owners and GitHub maintainers can recover/revoke credentials;
- staged/local clean consumers pass before publication, and the normal publish
  can resolve/install every applicable exact-lock public ecosystem entry from
  anonymous endpoints before draft promotion; Swift's pre-promotion proof is
  intentionally source-tag/manifest-only because draft binary assets are not
  public yet.
